/**
 * #40 (M07) FAZ 2: eski/yeni shadow karşılaştırması.
 *
 * Kaynak manifesti ile hedef DB/vault durumunu yalnız okur; hiçbir şey
 * yazmaz. Amaç kayıpsız aktarımın kanıtıdır: planlanan her not/revision/
 * edge/pin hedefte beklenen kimlik ve içerik hash'iyle duruyor mu, hangi
 * kayıtlar bilinçli olarak karantinada/dışlanmış, hangileri kayıp veya
 * uyuşmuyor.
 */

import { readFile } from "node:fs/promises";
import type { Identity } from "../../application/identity.js";
import { memoryRecordHash, parseMemoryDocument } from "../../domain/memory.js";
import { sha256Hex } from "../files.js";
import { resolveVaultRelative } from "../paths.js";
import type { MemoryService } from "../service.js";
import type { AgzExclusion } from "./inventory.js";
import type { AgzImportManifest } from "./manifest.js";

export interface AgzShadowMismatch {
  sourceNoteId: string;
  targetNoteId: string;
  reason: string;
}

export interface AgzShadowReport {
  kind: "agz-import-shadow";
  decision: "match" | "mismatch";
  source: { notes: number; revisions: number; edges: number; pinned: number };
  target: { notes: number; revisions: number; edges: number; pinned: number };
  coverage: {
    notes: number;
    revisions: number;
    edges: number;
    pinned: number;
  };
  missingNotes: string[];
  mismatched: AgzShadowMismatch[];
  quarantined: Array<{ sourceNoteId: string; codes: string[] }>;
  excluded: AgzExclusion[];
}

export interface CompareAgzShadowInput {
  service: MemoryService;
  identity: Identity;
  vaultRoot: string;
  manifest: AgzImportManifest;
}

function ratio(matched: number, total: number): number {
  if (total === 0) return 1;
  return Math.min(1, Math.max(0, matched / total));
}

function edgeKey(relation: string, target: string): string {
  return `${relation}\u0000${target}`;
}

export async function compareAgzShadow(
  input: CompareAgzShadowInput,
): Promise<AgzShadowReport> {
  const { manifest } = input;
  for (const mapping of manifest.mappings)
    await input.service.authorizeSpace(
      input.identity,
      mapping.target.memorySpaceId,
      "read",
    );
  const mappingByProject = new Map(
    manifest.mappings.map((mapping) => [mapping.sourceProjectId, mapping]),
  );

  const missingNotes: string[] = [];
  const mismatched: AgzShadowMismatch[] = [];
  const quarantined: AgzShadowReport["quarantined"] = [];
  let matchedNotes = 0;
  let matchedRevisions = 0;
  let matchedEdges = 0;
  let matchedPinned = 0;

  for (const note of manifest.notes) {
    if (note.status === "quarantined") {
      quarantined.push({
        sourceNoteId: note.sourceNoteId,
        codes: note.issues
          .filter((issue) => issue.severity === "blocking")
          .map((issue) => issue.code),
      });
      continue;
    }
    const mapping = mappingByProject.get(note.sourceProjectId);
    if (!mapping) {
      missingNotes.push(note.sourceNoteId);
      continue;
    }
    const mismatch = (reason: string): void => {
      mismatched.push({
        sourceNoteId: note.sourceNoteId,
        targetNoteId: note.targetNoteId,
        reason,
      });
    };
    const row = await input.service.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", mapping.target.memorySpaceId)
      .where("id", "=", note.targetNoteId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) {
      missingNotes.push(note.sourceNoteId);
      continue;
    }
    let noteMatched = true;
    if (row.title !== note.title) {
      mismatch("title");
      noteMatched = false;
    }
    if (row.lifecycle !== note.lifecycle) {
      mismatch("lifecycle");
      noteMatched = false;
    }
    if (Boolean(row.pinned) !== note.pinned) {
      mismatch("pinned");
      noteMatched = false;
    } else if (note.pinned) matchedPinned += 1;

    const revisions = await input.service.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", mapping.target.memorySpaceId)
      .where("note_id", "=", note.targetNoteId)
      .execute();
    const byRevision = new Map(
      revisions.map((revision) => [revision.revision, revision]),
    );
    for (const planned of note.revisions) {
      const revision = byRevision.get(planned.targetRevision);
      if (!revision) {
        mismatch(`revision:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      let metadata: { client_hash?: unknown; record_hash?: unknown };
      try {
        metadata = JSON.parse(revision.metadata_json) as typeof metadata;
      } catch {
        mismatch(`revision_metadata:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      if (metadata.client_hash !== planned.documentSha256) {
        mismatch(`revision_stage_identity:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      if (!revision.file_path) {
        mismatch(`revision_file:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      let content: string;
      try {
        content = await readFile(
          resolveVaultRelative(input.vaultRoot, revision.file_path),
          "utf8",
        );
      } catch {
        mismatch(`revision_file_missing:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      if (sha256Hex(content) !== revision.content_hash) {
        mismatch(`revision_file_hash:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      const parsedRevision = parseMemoryDocument(content);
      if (parsedRevision.status !== "ok") {
        mismatch(`revision_contract:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      // M02 `record_hash`'i base_revision içerdiğinden zincire bağlıdır;
      // dosyadan yeniden hesaplanan M01 hash'i metadata ile doğrulanır.
      if (memoryRecordHash(parsedRevision.record) !== metadata.record_hash) {
        mismatch(`revision_record_hash:${planned.targetRevision}`);
        noteMatched = false;
        continue;
      }
      matchedRevisions += 1;
      if (planned.targetRevision === note.revisions.at(-1)!.targetRevision) {
        if (revision.kind !== note.kind) {
          mismatch("kind");
          noteMatched = false;
        }
        const parsed = parsedRevision;
        if (parsed.status !== "ok") {
          mismatch("document_contract");
          noteMatched = false;
        } else {
          const actual = new Set(
            parsed.record.edges.map((edge) =>
              edgeKey(edge.relation, edge.target),
            ),
          );
          const plannedEdges = new Set(
            note.edges.map((edge) => edgeKey(edge.relation, edge.targetNoteId)),
          );
          for (const edge of plannedEdges)
            if (actual.has(edge)) matchedEdges += 1;
          if (
            actual.size !== plannedEdges.size ||
            [...plannedEdges].some((edge) => !actual.has(edge))
          ) {
            mismatch("edges");
            noteMatched = false;
          }
        }
      }
    }
    const head = note.revisions.at(-1)!.targetRevision;
    if (row.current_revision !== head) {
      mismatch("head_revision");
      noteMatched = false;
    }
    if (noteMatched) matchedNotes += 1;
  }

  const source = {
    notes: manifest.counts.notes,
    revisions: manifest.counts.revisions,
    edges: manifest.counts.edges,
    pinned: manifest.counts.pinned,
  };
  const target = {
    notes: matchedNotes,
    revisions: matchedRevisions,
    edges: matchedEdges,
    pinned: matchedPinned,
  };
  return {
    kind: "agz-import-shadow",
    decision:
      missingNotes.length === 0 && mismatched.length === 0
        ? "match"
        : "mismatch",
    source,
    target,
    coverage: {
      notes: ratio(target.notes, manifest.counts.readyNotes),
      revisions: ratio(target.revisions, source.revisions),
      edges: ratio(target.edges, source.edges),
      pinned: ratio(target.pinned, source.pinned),
    },
    missingNotes,
    mismatched,
    quarantined,
    excluded: manifest.exclusions,
  };
}
