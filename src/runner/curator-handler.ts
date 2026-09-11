import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Identity } from "../application/identity.js";
import type { DatabaseHandle } from "../storage/database.js";
import type { SecretVault } from "../storage/secrets.js";
import { ForgeError } from "../domain/errors.js";
import { defaultSettings, type Settings } from "../domain/settings.js";
import {
  CURATOR_EXTRACTOR_VERSION,
  CURATOR_POLICY_VERSION,
  memoryCuratePayloadSchema,
  narrowCuratorMode,
} from "../domain/curator.js";
import { ForgeRunner } from "./forge-runner.js";
import { budgetedStream } from "./budgeted-stream.js";
import { resolveCuratorModel } from "./curator-model.js";
import { BudgetService } from "../jobs/budgets.js";
import { MemoryService } from "../memory/service.js";
import { MemoryCommitService } from "../memory/commit.js";
import { vaultRoot } from "../memory/paths.js";
import { CuratorExtractionRepository } from "../memory/curator/extractions.js";
import { CuratorLookup } from "../memory/curator/lookup.js";
import { MemoryCuratorProfileRepository } from "../memory/curator/profile.js";
import { CuratorProposals } from "../memory/curator/proposals.js";
import { CURATOR_SYSTEM_PROMPT } from "../memory/curator/prompt.js";
import {
  sourceRefKey,
  CuratorSourceReader,
} from "../memory/curator/source-reader.js";
import { CuratorTools } from "../memory/curator/tools.js";
import { applyAutoProposals } from "../memory/curator/apply.js";
import type { JobHandler } from "../jobs/worker.js";

/**
 * Issue #39 (M06) Faz A: the single bounded MemoryCurator job handler.
 *
 * Deterministic steps (mode ceiling, space ACL, source read, citation check,
 * base_revision guard, proposal limits, auto-write class policy and the M02
 * commit path) stay in code. The model only proposes through the five narrow
 * tools. A missing model binding yields a visible `model_not_ready` no-op;
 * manual memory work is unaffected.
 */
export interface CuratorHandlerOptions {
  storage: DatabaseHandle;
  dataDir: string;
  vault: SecretVault;
  local: boolean;
  /** Test seam: the only replaceable part is the provider event stream. */
  providerStream?: StreamFn;
}

export function curatorJobHandler(options: CuratorHandlerOptions): JobHandler {
  return async (run, signal) => {
    if (run.kind !== "memory_curate")
      throw new ForgeError(
        "invalid_kind",
        "Hafıza küratör handler'ı yalnız memory_curate işini yürütür.",
        422,
      );
    const identity: Identity = {
      tenantId: run.tenant_id,
      userId: run.user_id,
    };
    const snapshot = JSON.parse(run.config_json) as {
      values?: Partial<Settings>;
    };
    const settings: Required<Settings> = {
      ...defaultSettings,
      ...snapshot.values,
    };
    const payload = memoryCuratePayloadSchema.parse(JSON.parse(run.input_json));
    const mode = narrowCuratorMode(
      payload.mode ?? settings.memoryCuratorMode,
      settings.memoryCuratorMode,
    );
    const root = vaultRoot(options.dataDir);
    const memory = new MemoryService(options.storage.db, undefined, root);
    const commits = new MemoryCommitService({
      db: options.storage.db,
      vaultRoot: root,
      service: memory,
    });
    const extractions = new CuratorExtractionRepository(options.storage.db);
    if (!settings.memoryEnabled)
      return { state: "no_op", result: { status: "memory_disabled" } };
    if (mode === "off")
      return { state: "no_op", result: { status: "curator_off" } };

    let space;
    try {
      space = await memory.authorizeRunSpace(run, payload.space_id, "write");
    } catch (error) {
      await extractions
        .insert({
          identity,
          spaceId: payload.space_id,
          runId: run.id,
          mode,
          extractorVersion: CURATOR_EXTRACTOR_VERSION,
          policyVersion: CURATOR_POLICY_VERSION,
          sourceFingerprint: "unavailable",
          status: "failed",
          errorCode: error instanceof ForgeError ? error.code : "space_denied",
        })
        .catch(() => undefined);
      return {
        state: "rejected",
        result: { status: "space_denied" },
        errorCode: "space_denied",
      };
    }

    const reader = new CuratorSourceReader(
      options.storage.db,
      identity.tenantId,
      space.id,
      payload.source_refs,
      settings.curatorMaxSourceBytes,
    );
    let reads;
    try {
      reads = await reader.readAll();
    } catch (error) {
      const code = error instanceof ForgeError ? error.code : "source_error";
      await extractions.insert({
        identity,
        spaceId: space.id,
        runId: run.id,
        mode,
        extractorVersion: CURATOR_EXTRACTOR_VERSION,
        policyVersion: CURATOR_POLICY_VERSION,
        sourceFingerprint: "unreadable",
        status: "failed",
        errorCode: code,
      });
      return {
        state: "rejected",
        result: { status: "source_error", code },
        errorCode: code,
      };
    }

    const cached = await extractions.findReusable({
      tenantId: identity.tenantId,
      spaceId: space.id,
      extractorVersion: CURATOR_EXTRACTOR_VERSION,
      policyVersion: CURATOR_POLICY_VERSION,
      sourceFingerprint: reads.fingerprint,
      mode,
    });
    if (cached) {
      await extractions.insert({
        identity,
        spaceId: space.id,
        runId: run.id,
        mode,
        extractorVersion: CURATOR_EXTRACTOR_VERSION,
        policyVersion: CURATOR_POLICY_VERSION,
        sourceFingerprint: reads.fingerprint,
        status: "no_op",
        result: { cached: true, previous: cached.id, outcome: cached.status },
        usage: emptyUsage(),
      });
      return {
        state: "no_op",
        result: {
          status: "cached",
          previous_extraction_id: cached.id,
          mode,
        },
      };
    }

    const profileRepo = new MemoryCuratorProfileRepository(
      options.storage.db,
      options.vault,
    );
    const resolved = await resolveCuratorModel(profileRepo, identity, {
      local: options.local,
      allowedOrigins: settings.allowedOrigins,
      allowPaid: settings.allowPaid,
    });
    if (!resolved) {
      await extractions.insert({
        identity,
        spaceId: space.id,
        runId: run.id,
        mode,
        extractorVersion: CURATOR_EXTRACTOR_VERSION,
        policyVersion: CURATOR_POLICY_VERSION,
        sourceFingerprint: reads.fingerprint,
        status: "not_ready",
        errorCode: "model_not_ready",
        usage: emptyUsage(),
      });
      return {
        state: "no_op",
        result: { status: "model_not_ready", mode },
      };
    }

    const proposals = new CuratorProposals({
      db: options.storage.db,
      identity,
      run,
      space,
      mode,
      maxProposals: settings.curatorMaxProposals,
      authorizedSources: new Map(
        reads.excerpts.map((excerpt) => [
          sourceRefKey(excerpt),
          { hash: excerpt.hash },
        ]),
      ),
      extractionId: null,
    });
    const tools = new CuratorTools(
      reader,
      new CuratorLookup(options.storage.db, identity.tenantId, space.id),
      proposals,
      async (decision) => {
        if (decision.outcome !== "proposed" || mode !== "auto")
          return { applied: [], skipped: 0 };
        const changes = await proposals.listForRun();
        return applyAutoProposals({
          db: options.storage.db,
          identity,
          run,
          space,
          settings,
          memory,
          commits,
          changes,
        });
      },
    );
    const stream = budgetedStream({
      storage: options.storage,
      run,
      identity,
      maxCostMicros: settings.maxCostMicros,
      providerStream: options.providerStream,
      resolve: (model, context, streamOptions) =>
        resolved.models.streamSimple(model, context, streamOptions),
    });
    await new BudgetService(options.storage).reconcileAccount(
      identity,
      settings.maxCostMicros,
    );
    const outcome = await new ForgeRunner().run({
      profile: "memory_curate",
      sessionId: run.session_id,
      model: resolved.model,
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      input: JSON.stringify({
        space_id: space.id,
        task: payload.task,
        mode,
        source_refs: payload.source_refs,
        note_refs: payload.note_refs ?? [],
        authorized_sources: reads.excerpts.map((excerpt) => ({
          source_id: excerpt.source_id,
          path: excerpt.path,
          section: excerpt.section,
          hash: excerpt.hash,
          truncated: excerpt.truncated,
        })),
      }),
      tools: tools.tools(),
      stream,
      deadlineMs: Math.max(1, run.deadline_at - Date.now()),
      maxCalls: settings.curatorMaxCalls,
      maxTokens: settings.maxTokens,
      maxCostMicros: settings.maxCostMicros,
      signal,
    });
    const usage = {
      calls: outcome.calls,
      input_tokens: outcome.usage?.input ?? null,
      output_tokens: outcome.usage?.output ?? null,
      reasoning_tokens: outcome.usage?.reasoning ?? null,
      cache_read_tokens: outcome.usage?.cacheRead ?? null,
      cache_write_tokens: outcome.usage?.cacheWrite ?? null,
      total_tokens: outcome.usage?.totalTokens ?? null,
      cost_micros: outcome.usage
        ? Math.ceil(outcome.usage.cost.total * 1_000_000)
        : null,
      elapsed_ms: Math.round(outcome.elapsedMs),
      tool_result_bytes: tools.toolResultBytes,
      model_revision: resolved.revision,
    };
    const finalize = tools.finalizeResult;
    if (!outcome.finalized || !finalize) {
      const errorCode = outcome.error ?? "not_finalized";
      await proposals.discardUnfinalized(errorCode);
      await extractions.insert({
        identity,
        spaceId: space.id,
        runId: run.id,
        mode,
        extractorVersion: CURATOR_EXTRACTOR_VERSION,
        policyVersion: CURATOR_POLICY_VERSION,
        sourceFingerprint: reads.fingerprint,
        status: "failed",
        errorCode,
        usage,
      });
      return {
        state: signal.aborted ? "cancelled" : "failed",
        result: { status: "not_finalized", error: errorCode, usage },
        errorCode,
      };
    }
    await extractions.insert({
      identity,
      spaceId: space.id,
      runId: run.id,
      mode,
      extractorVersion: CURATOR_EXTRACTOR_VERSION,
      policyVersion: CURATOR_POLICY_VERSION,
      sourceFingerprint: reads.fingerprint,
      status: finalize.outcome === "no_op" ? "no_op" : "ready",
      result: {
        outcome: finalize.outcome,
        reason: finalize.reason,
        applied: finalize.applied ?? null,
      },
      usage,
    });
    return {
      state:
        finalize.outcome === "rejected"
          ? "rejected"
          : finalize.outcome === "no_op"
            ? "no_op"
            : "completed",
      result: {
        status: finalize.outcome,
        reason: finalize.reason,
        applied: finalize.applied ?? null,
        mode,
        usage,
      },
    };
  };
}

function emptyUsage() {
  return {
    calls: 0,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: null,
    cost_micros: null,
    elapsed_ms: 0,
    tool_result_bytes: 0,
    model_revision: null,
  };
}
