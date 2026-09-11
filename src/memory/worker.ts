import { ForgeError } from "../domain/errors.js";
import type { JobHandler } from "../jobs/worker.js";
import type { Identity } from "../application/identity.js";
import { MemoryService } from "./service.js";
import { memoryIngestJobKind, memoryReconcileJobKind } from "./job-kinds.js";

/**
 * Issue #34 (M01): model-free memory handlers for the shared ForgeWorker.
 * They never touch a provider profile, `PackageStore`, `EvolutionStaging` or
 * SPR tools, they respect the abort signal, and the space ACL is re-resolved
 * inside `MemoryService` on every call. They run with `evolutionEnabled`
 * false; `memoryEnabled` was already checked at acceptance.
 */

export function memoryIngestHandler(service: MemoryService): JobHandler {
  return async (run, signal) => {
    throwIfAborted(signal);
    const payload = memoryIngestJobKind.payload.parse(
      JSON.parse(run.input_json),
    );
    const identity: Identity = {
      tenantId: run.tenant_id,
      userId: run.user_id,
    };
    // B1: the persisted run scope must match the concrete target space; the
    // regular space ACL is re-checked inside `recordEvent` as well.
    await service.authorizeRunSpace(run, payload.spaceId, "write");
    const outcome = await service.recordEvent(identity, payload);
    throwIfAborted(signal);
    return {
      state: "completed",
      result: { status: outcome.status, eventId: outcome.event.id },
    };
  };
}

export function memoryReconcileHandler(service: MemoryService): JobHandler {
  return async (run, signal) => {
    throwIfAborted(signal);
    const payload = memoryReconcileJobKind.payload.parse(
      JSON.parse(run.input_json),
    );
    const identity: Identity = {
      tenantId: run.tenant_id,
      userId: run.user_id,
    };
    // Explicit target spaces are checked against the run scope; the global
    // pass already limits itself to spaces the actor may read.
    if (payload.spaceId)
      await service.authorizeRunSpace(run, payload.spaceId, "read");
    const report = await service.reconcile(identity, payload);
    throwIfAborted(signal);
    return { state: "completed", result: report };
  };
}

export function memoryJobHandlers(service: MemoryService) {
  return {
    memory_ingest: memoryIngestHandler(service),
    memory_reconcile: memoryReconcileHandler(service),
  } satisfies Partial<Record<"memory_ingest" | "memory_reconcile", JobHandler>>;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new ForgeError("aborted", "Hafıza işi iptal edildi.", 499);
}
