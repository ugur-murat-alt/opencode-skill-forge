import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Identity } from "../../application/identity.js";
import type {
  DB,
  MemoryCuratorChange,
  MemorySpace,
  Run,
} from "../../storage/schema.js";
import type { Settings } from "../../domain/settings.js";
import {
  serializeMemoryDocument,
  type MemoryKind,
  type MemoryRecord,
  type MemorySource,
} from "../../domain/memory.js";
import { ForgeError } from "../../domain/errors.js";
import type { MemoryService } from "../service.js";
import type { MemoryCommitService } from "../commit.js";
import { sha256Hex } from "../files.js";

/**
 * Issue #39 (M06): deterministic auto-write policy.
 *
 * Only a finalized `auto` run can reach this module, and only a low-risk
 * `user_declaration` preference whose kind is explicitly allowlisted is
 * committed. Merges, contradictions, rewrites of human text, links and
 * deletions never auto-apply: they stay reviewable proposals. Every apply goes
 * through the M02 event + commit path, so a replay cannot create a second note.
 */

export interface CuratorApplyOutcome {
  change_id: string;
  note_id: string;
  revision: number;
  file_path: string;
}

export async function applyAutoProposals(input: {
  db: Kysely<DB>;
  identity: Identity;
  run: Run;
  space: MemorySpace;
  settings: Required<Settings>;
  memory: MemoryService;
  commits: MemoryCommitService;
  changes: MemoryCuratorChange[];
}): Promise<{ applied: CuratorApplyOutcome[]; skipped: number }> {
  const { db, identity, run, space, settings, memory, commits } = input;
  const applied: CuratorApplyOutcome[] = [];
  let skipped = 0;
  for (const change of input.changes) {
    if (!isAutoEligible(change, settings)) {
      skipped += 1;
      continue;
    }
    const noteId = change.note_id ?? randomUUID();
    try {
      const sources = parseSources(change.source_refs_json);
      const now = Date.now();
      const record: MemoryRecord = {
        formatVersion: 1,
        noteId,
        spaceId: space.id,
        kind: change.kind as MemoryKind,
        title: change.title!,
        summary: change.summary,
        lifecycle: "active",
        pinned: false,
        taskStatus: null,
        verification: "declared",
        stale: null,
        sources,
        edges: [],
        createdAt: now,
        observedAt: now,
        validFrom: null,
        validUntil: null,
        baseRevision: null,
        revision: null,
        unknown: {},
        body: (change.body_md ?? "").endsWith("\n")
          ? (change.body_md ?? "")
          : `${change.body_md ?? ""}\n`,
      };
      const content = serializeMemoryDocument(record);
      const event = await memory.recordEvent(identity, {
        spaceId: space.id,
        sourceEventKey: `curator:${change.id}`,
        sourceKind: "curator",
        contentHash: sha256Hex(content),
        observedAt: now,
      });
      if (event.status === "duplicate") {
        skipped += 1;
        continue;
      }
      const receipt = await commits.commit({
        identity,
        run,
        spaceId: space.id,
        eventId: event.event.id,
        sourceKind: "curator",
        content,
        noteId,
        baseRevision: null,
        kind: record.kind,
      });
      await db
        .updateTable("memory_curator_changes")
        .set({
          state: "applied",
          applied_revision: receipt.revision,
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", change.id)
        .execute();
      applied.push({
        change_id: change.id,
        note_id: noteId,
        revision: receipt.revision,
        file_path: receipt.filePath,
      });
    } catch (error) {
      await db
        .updateTable("memory_curator_changes")
        .set({
          state: "rejected",
          reason: shortCode(error),
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", change.id)
        .execute();
    }
  }
  return { applied, skipped };
}

export function isAutoEligible(
  change: MemoryCuratorChange,
  settings: Required<Settings>,
): boolean {
  return (
    change.state === "proposed" &&
    change.risk === "low" &&
    change.operation === "create" &&
    change.claim_class === "user_declaration" &&
    change.kind === "preference" &&
    (settings.curatorAutoWriteKinds as string[]).includes(change.kind)
  );
}

function parseSources(raw: string): MemorySource[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is { source_id: string; hash?: unknown } =>
        typeof (entry as { source_id?: unknown })?.source_id === "string",
    )
    .slice(0, 100)
    .map((entry) => ({
      id: entry.source_id,
      kind: "curator-source",
      hash: typeof entry.hash === "string" ? entry.hash : undefined,
      revision: undefined,
    }));
}

function shortCode(error: unknown): string {
  if (error instanceof ForgeError) return error.code.slice(0, 120);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.slice(0, 120) : "apply_error";
}
