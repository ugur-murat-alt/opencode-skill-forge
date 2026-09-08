import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn, AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseHandle } from "../storage/database.js";
import type { DB } from "../storage/schema.js";
import type { Settings } from "../domain/settings.js";
import { providerProfileSchema } from "../application/providers.js";
import { SecretVault } from "../storage/secrets.js";
import { PackageStore } from "../skills/store.js";
import { DockerExecutor } from "../execution/docker.js";
import { BudgetService } from "../jobs/budgets.js";
import { JobQueue } from "../jobs/queue.js";
import type { JobHandler } from "../jobs/worker.js";
import { ForgeError } from "../domain/errors.js";
import { ForgeRunner } from "./forge-runner.js";
import { resolveProvider } from "./providers.js";
import { EvolutionStaging } from "./staging.js";
import { resolvePrompt } from "../application/agent-prompts.js";
export function productionHandler(
  storage: DatabaseHandle,
  dataDir: string,
  vault: SecretVault,
  local: boolean,
): JobHandler {
  return async (run, signal) => {
    const identity = { tenantId: run.tenant_id, userId: run.user_id };
    const snapshot = JSON.parse(run.config_json) as {
      values: Required<Settings>;
      providerProfile: DB["provider_profiles"] | null;
    };
    const input = JSON.parse(run.input_json) as Record<string, unknown>;
    if (!snapshot.providerProfile) {
      throw new ForgeError(
        "model_missing",
        "Skill modeli yapılandırılmamış.",
        422,
      );
    }
    let resolved;
    {
      const row = snapshot.providerProfile,
        profile = providerProfileSchema.parse(JSON.parse(row.profile_json));
      resolved = await resolveProvider(
        {
          ...profile,
          allowPaid: profile.allowPaid && snapshot.values.allowPaid,
        },
        async () =>
          row.secret_ref
            ? vault.get(identity.tenantId, identity.userId, row.secret_ref)
            : undefined,
        { local, allowedOrigins: snapshot.values.allowedOrigins },
      );
    }
    const executor = new DockerExecutor(dataDir, {
      trustScope: `${identity.tenantId}:${identity.userId}`,
      allowDependencyInstall: snapshot.values.dependencyInstall,
      allowedOrigins: snapshot.values.scriptAllowedOrigins,
    });
    const store = new PackageStore(storage, dataDir, (path, manifest) =>
      executor.validate(path, manifest),
    );
    const staging = new EvolutionStaging(store, identity, run);
    try {
      const tools: AgentTool[] = staging.tools();
      const budget = new BudgetService(storage);
      await storage.db
        .insertInto("budget_accounts")
        .values({
          tenant_id: identity.tenantId,
          user_id: identity.userId,
          limit_micros: snapshot.values.maxCostMicros,
          reserved_micros: 0,
          spent_micros: 0,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
      let call = 0;
      const stream: StreamFn = async (model, context, options) => {
        await storage.db
          .transaction()
          .execute((tx) => new JobQueue(storage).assertLease(tx, run));
        const id = `${run.id}:${run.fence}:${++call}`;
        const estimate = Math.ceil(
          model.contextWindow *
            Math.max(
              model.cost.input,
              model.cost.cacheRead,
              model.cost.cacheWrite,
            ) +
            (options?.maxTokens ?? model.maxTokens) * model.cost.output,
        );
        await budget.reserve(identity, run.id, id, estimate);
        const result = createAssistantMessageEventStream();
        void (async () => {
          let terminal = false;
          const fail = () =>
            result.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content: [],
                timestamp: Date.now(),
                stopReason: "error",
                errorMessage: "provider_or_usage_error",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              },
            });
          try {
            for await (const event of resolved.models.streamSimple(
              model,
              context,
              options,
            )) {
              if (event.type === "done" || event.type === "error")
                terminal = true;
              if (event.type === "done")
                await budget.settle(
                  identity,
                  id,
                  Math.ceil(event.message.usage.cost.total * 1_000_000),
                );
              else if (event.type === "error")
                await budget.settle(identity, id, null);
              result.push(event);
            }
            if (!terminal) {
              await budget.settle(identity, id, null);
              fail();
            }
          } catch {
            try {
              await budget.settle(identity, id, null);
            } catch {}
            fail();
          }
        })();
        return result;
      };
      const outcome = await new ForgeRunner().run({
        profile: run.kind,
        sessionId: run.session_id,
        model: resolved.model,
        systemPrompt: (
          await resolvePrompt(storage.db, identity.tenantId, run.project_id)
        ).content,
        input: JSON.stringify(input),
        tools,
        stream,
        deadlineMs: Math.max(1, run.deadline_at - Date.now()),
        maxCalls: snapshot.values.maxCalls,
        maxTokens: snapshot.values.maxTokens,
        maxCostMicros: snapshot.values.maxCostMicros,
        signal,
      });
      const usage = {
        calls: outcome.calls,
        tokens: outcome.usage?.totalTokens ?? null,
        cost_micros: outcome.usage
          ? Math.ceil(outcome.usage.cost.total * 1_000_000)
          : null,
        elapsed_ms: outcome.elapsedMs,
      };
      if (!outcome.finalized || !staging.closed)
        throw new ForgeError(
          outcome.error ?? "not_finalized",
          "SPR işi finalize ile bitirmedi.",
          422,
        );
      const result = staging.result as { decision: string };
      return {
        state:
          result.decision === "no-op"
            ? "no_op"
            : result.decision === "reject"
              ? "rejected"
              : "completed",
        result: { ...result, usage },
      };
    } finally {
      await staging.dispose();
    }
  };
}
