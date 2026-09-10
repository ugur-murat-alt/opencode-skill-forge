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
/**
 * Composition-test seam for the production handler. Only the provider event
 * stream is replaceable; lease fencing, budget reservation, the real tools
 * and finalization stay on the production path. Policy is never injectable:
 * the store always receives the accepted run's effective snapshot.
 */
export interface RunnerHandlerOverrides {
  providerStream?: StreamFn;
}
/**
 * Issue #26: single composition point for the runner's package store. The
 * accepted run snapshot is a required argument, so an internal search path
 * cannot be built without the effective policy that external entries use.
 */
export function runnerPackageStore(
  storage: DatabaseHandle,
  dataDir: string,
  validateScripts: ConstructorParameters<typeof PackageStore>[2],
  snapshot: { values: Required<Settings> },
) {
  return new PackageStore(storage, dataDir, validateScripts, snapshot.values);
}
export function productionHandler(
  storage: DatabaseHandle,
  dataDir: string,
  vault: SecretVault,
  local: boolean,
  overrides: RunnerHandlerOverrides = {},
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
    // Issue #26: the internal inventory resolves search caps from the same
    // explicit policy context as the external MCP/HTTP paths. The accepted
    // job snapshot is the upper bound (it already contains the operator
    // cap); currently stored tenant/workspace/environment/project/personal
    // layers can only narrow it further for this run.
    const store = runnerPackageStore(
      storage,
      dataDir,
      (path, manifest) => executor.validate(path, manifest),
      snapshot,
    );
    const staging = new EvolutionStaging(store, identity, run);
    try {
      const tools: AgentTool[] = staging.tools();
      const budget = new BudgetService(storage);
      // Issue #25: the account row records the most recent effective job
      // limit without freezing while calls are in flight. The reservation
      // itself is bounded by this job's accepted snapshot limit, so another
      // project's policy or this user's past spending is never a quota.
      await budget.reconcileAccount(identity, snapshot.values.maxCostMicros);
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
        await budget.reserve(
          identity,
          run.id,
          id,
          estimate,
          snapshot.values.maxCostMicros,
        );
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
            const events = await (overrides.providerStream
              ? overrides.providerStream(model, context, options)
              : resolved.models.streamSimple(model, context, options));
            for await (const event of events) {
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
