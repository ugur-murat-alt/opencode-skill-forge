import { LearningStore } from "../prompt/learning.js";
import { sanitizePromptEditorText } from "../prompt-editor/context-snapshot.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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
import { preservedConstraints, skipPrompt } from "../prompt/guard.js";
async function prompt(name: string) {
  const bundled = fileURLToPath(
    new URL(`./prompts/${name}.md`, import.meta.url),
  );
  return readFile(
    existsSync(bundled) ? bundled : resolve("prompts", `${name}.md`),
    "utf8",
  );
}
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
    const input = JSON.parse(run.input_json) as Record<string, unknown>,
      original = typeof input.original === "string" ? input.original : "";
    const fallback = (reason: string) => ({
      state: "fallback" as const,
      result: {
        status: "fallback",
        original,
        effective: original,
        auto_applied: false,
        reason,
      },
      errorCode: reason,
    });
    if (run.kind === "prompt_edit") {
      if (sanitizePromptEditorText(original, 32000) !== original)
        return fallback("sensitive_input");
      const skip = skipPrompt(
        original,
        snapshot.values.promptEnabled ? snapshot.values.promptMode : "off",
      );
      if (skip)
        return {
          state: "unchanged",
          result: {
            status: "unchanged",
            original,
            effective: original,
            auto_applied: false,
            reason: skip,
          },
        };
    }
    if (!snapshot.providerProfile) {
      if (run.kind === "prompt_edit") return fallback("model_missing");
      throw new ForgeError(
        "model_missing",
        "Skill modeli yapılandırılmamış.",
        422,
      );
    }
    let resolved;
    try {
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
    } catch (error) {
      if (run.kind === "prompt_edit")
        return fallback(
          error instanceof ForgeError ? error.code : "provider_error",
        );
      throw error;
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
    let edited: {
      status: "improved" | "unchanged" | "needs_clarification";
      text: string;
      reason: string;
    } | null = null;
    const learning = new LearningStore(storage);
    const lessons =
      run.kind === "prompt_edit" && snapshot.values.learning !== "off"
        ? await learning.retrieve(identity, run.project_id, original)
        : [];
    const tools: AgentTool[] =
      run.kind === "skill_evolve"
        ? staging.tools()
        : [
            {
              name: "finalize",
              label: "Finalize",
              description:
                "Return one intent-preserving candidate or unchanged/needs_clarification. Never solve the task.",
              parameters: Type.Object({
                status: Type.Union([
                  Type.Literal("improved"),
                  Type.Literal("unchanged"),
                  Type.Literal("needs_clarification"),
                ]),
                text: Type.String({ maxLength: 65536 }),
                reason: Type.String({ maxLength: 800 }),
                lesson: Type.Optional(
                  Type.Object({
                    content: Type.String({ maxLength: 1000 }),
                    triggers: Type.String({ maxLength: 200 }),
                  }),
                ),
              }),
              execute: async (_id, args: any) => {
                if (
                  args.status === "improved" &&
                  !preservedConstraints(original, args.text)
                )
                  throw new ForgeError(
                    "constraint_guard_failed",
                    "Özgün sayı, yol, sürüm ve olumsuzlukları koruyarak yalnız bir kez onarın.",
                  );
                edited = args;
                return {
                  content: [
                    {
                      type: "text",
                      text: "Candidate received for manager checks.",
                    },
                  ],
                  details: {},
                };
              },
            },
          ];
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
      systemPrompt: await prompt(
        run.kind === "skill_evolve" ? "skill-evolve" : "prompt-edit",
      ),
      input: JSON.stringify({
        ...input,
        ...(lessons.length ? { reusable_lessons: lessons } : {}),
      }),
      tools,
      stream,
      deadlineMs: Math.max(1, run.deadline_at - Date.now()),
      maxCalls:
        run.kind === "prompt_edit"
          ? Math.min(2, snapshot.values.maxCalls)
          : snapshot.values.maxCalls,
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
    if (run.kind === "prompt_edit") {
      const candidate = edited as {
        status: "improved" | "unchanged" | "needs_clarification";
        text: string;
        reason: string;
        lesson?: { content: string; triggers: string };
      } | null;
      if (!outcome.finalized || !candidate || outcome.error)
        return {
          ...fallback(outcome.error ?? "not_finalized"),
          result: {
            ...fallback(outcome.error ?? "not_finalized").result,
            usage,
          },
        };
      if (
        candidate.status === "improved" &&
        !preservedConstraints(original, candidate.text)
      )
        return fallback("constraint_guard_failed");
      const improved =
        candidate.status === "improved" && candidate.text !== original;
      if (
        improved &&
        candidate.lesson &&
        snapshot.values.learning === "reusable-only"
      ) {
        try {
          await learning.save(identity, run.project_id, candidate.lesson, run);
        } catch (error) {
          if (!(
            error instanceof ForgeError &&
            error.code === "learning_not_reusable"
          ))
            throw error;
        }
      }
      return {
        state: improved ? "improved" : "unchanged",
        result: {
          status: candidate.status,
          original,
          candidate: improved ? candidate.text : original,
          effective:
            improved && snapshot.values.autoApply ? candidate.text : original,
          auto_applied: improved && snapshot.values.autoApply,
          reason: candidate.reason,
          usage,
        },
      };
    }
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
  };
}
