import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemorySearchService } from "../src/memory/search.js";
import { sha256Hex } from "../src/memory/files.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Issue #36 (M03) benchmark acceptance: abstention, freshness and source
 * accuracy are measured against a frozen fixture set. Thresholds are
 * declared BEFORE the measurement runs and are intentionally conservative;
 * the report is printed as JSON (no threshold is adjusted afterwards).
 */

/** Ölçüm öncesi donuk eşikler. */
const THRESHOLDS = {
  recallAt3: 1.0,
  precisionAt3: 0.5,
  abstention: 1.0,
  sourceAccuracy: 1.0,
  freshness: 1.0,
} as const;

interface Fixture {
  version: number;
  notes: {
    note_id: string;
    kind: string;
    title: string;
    body: string;
    sources?: { id: string; kind?: string }[];
  }[];
  queries: { query: string; expected: string[]; abstain?: boolean }[];
}

test("#36 benchmark: frozen thresholds for recall, abstention, sources and freshness", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(import.meta.dir, "fixtures", "memory-benchmark", "cases.json"),
      "utf8",
    ),
  ) as Fixture;
  const root = await mkdtemp(join(tmpdir(), "forge-m03-bench-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const service = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await service.ensureSpace(owner, { type: "personal" });
    const index = new MemoryIndexService(storage.db, vaultRoot(root), service);
    const search = new MemorySearchService(storage.db, service);
    const now = Date.now();
    for (const note of fixture.notes) {
      await storage.db
        .insertInto("memory_notes")
        .values({
          tenant_id: owner.tenantId,
          space_id: space.id,
          id: note.note_id,
          lifecycle: "active",
          pinned: 0,
          task_status: null,
          current_revision: 1,
          format_version: 1,
          title: note.title,
          summary: null,
          created_at: now,
          updated_at: now,
          superseded_by: null,
          source_id: null,
          source_path: null,
          source_hash: null,
          source_state: "present",
          deleted_at: null,
        })
        .execute();
      await storage.db
        .insertInto("memory_note_revisions")
        .values({
          tenant_id: owner.tenantId,
          space_id: space.id,
          note_id: note.note_id,
          revision: 1,
          format_version: 1,
          kind: note.kind,
          title: note.title,
          summary: null,
          body_md: note.body,
          metadata_json: JSON.stringify({
            record_hash: "",
            record: {
              kind: note.kind,
              title: note.title,
              summary: null,
              lifecycle: "active",
              pinned: false,
              task_status: null,
              verification: "declared",
              sources: note.sources ?? [],
              edges: [],
            },
          }),
          sources_json: JSON.stringify(note.sources ?? []),
          base_revision: null,
          created_by: owner.userId,
          created_at: now,
          file_path: null,
          content_hash: sha256Hex(note.body),
          byte_size: note.body.length,
        })
        .execute();
    }
    await index.rebuild(owner, { batchSize: 100 });

    let recallHits = 0;
    let expectedTotal = 0;
    let precisionNumerator = 0;
    let precisionDenominator = 0;
    let abstained = 0;
    let abstainTotal = 0;
    let sourceHits = 0;
    let sourceTotal = 0;
    const perQuery: Record<string, unknown> = {};
    for (const query of fixture.queries) {
      const result = await search.search(owner, {
        query: query.query,
        spaceId: space.id,
        limit: 3,
      });
      const top = result.items.map((item) => item.note_id);
      if (query.abstain) {
        abstainTotal += 1;
        if (top.length === 0) abstained += 1;
        perQuery[query.query] = { abstained: top.length === 0, top };
        continue;
      }
      expectedTotal += query.expected.length;
      recallHits += query.expected.filter((id) => top.includes(id)).length;
      precisionNumerator += top.filter((id) =>
        query.expected.includes(id),
      ).length;
      precisionDenominator += top.length;
      for (const expected of query.expected) {
        const card = result.items.find((item) => item.note_id === expected);
        const fixtureNote = fixture.notes.find(
          (note) => note.note_id === expected,
        );
        if (fixtureNote?.sources && fixtureNote.sources.length > 0) {
          sourceTotal += 1;
          if (card && Array.isArray(card.sources) && card.sources.length > 0)
            sourceHits += 1;
        }
      }
      perQuery[query.query] = { top, expected: query.expected };
    }
    const recallAt3 = expectedTotal === 0 ? 1 : recallHits / expectedTotal;
    const precisionAt3 =
      precisionDenominator === 0
        ? 1
        : precisionNumerator / precisionDenominator;
    const abstention = abstainTotal === 0 ? 1 : abstained / abstainTotal;
    const sourceAccuracy = sourceTotal === 0 ? 1 : sourceHits / sourceTotal;

    // Güncellik: yeni revision indekslenince arama güncel sürümü döndürür.
    await storage.db
      .updateTable("memory_note_revisions")
      .set({
        revision: 2,
        body_md: "Kapsam filtresi aday seçiminden önce uygulanır (v2).",
        metadata_json: JSON.stringify({
          record_hash: "",
          record: {
            kind: "fact",
            title: "Kapsam filtresi",
            summary: null,
            lifecycle: "active",
            pinned: false,
            task_status: null,
            verification: "declared",
            sources: [],
            edges: [],
          },
        }),
      })
      .where("note_id", "=", "bench-fact-scope")
      .execute();
    await storage.db
      .updateTable("memory_notes")
      .set({ current_revision: 2 })
      .where("id", "=", "bench-fact-scope")
      .execute();
    await index.indexNote(owner.tenantId, space.id, "bench-fact-scope");
    const fresh = await search.search(owner, {
      query: "kapsam filtresi",
      spaceId: space.id,
      limit: 3,
    });
    const freshHit = fresh.items.find(
      (item) => item.note_id === "bench-fact-scope",
    );
    const freshness =
      freshHit && freshHit.revision === 2 && freshHit.stale === false ? 1 : 0;

    const report = {
      recallAt3,
      precisionAt3,
      abstention,
      sourceAccuracy,
      freshness,
      thresholds: THRESHOLDS,
      perQuery,
      estimator: "bytes/2.5 estimate (conservative; no tokenizer)",
    };
    console.log(`M03-BENCHMARK ${JSON.stringify(report)}`);
    expect(recallAt3).toBeGreaterThanOrEqual(THRESHOLDS.recallAt3);
    expect(precisionAt3).toBeGreaterThanOrEqual(THRESHOLDS.precisionAt3);
    expect(abstention).toBeGreaterThanOrEqual(THRESHOLDS.abstention);
    expect(sourceAccuracy).toBeGreaterThanOrEqual(THRESHOLDS.sourceAccuracy);
    expect(freshness).toBeGreaterThanOrEqual(THRESHOLDS.freshness);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
