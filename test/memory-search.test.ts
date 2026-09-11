import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemorySearchService } from "../src/memory/search.js";
import { sha256Hex } from "../src/memory/files.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Issue #36 (M03): derived index and global lexical search. The 1000+ corpus
 * puts the strong match in the last id group to prove candidate discovery is
 * global (never "first N ids"), TR/EN normalization, exact-title and graph
 * weights, stale-index handling, scope isolation and rebuild consistency are
 * all exercised against a real database.
 */

async function openEnv(backend: "sqlite" | "postgres") {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-search-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  const databaseName = `forge_m03_search_${crypto.randomUUID().replaceAll("-", "")}`;
  if (backend === "postgres") {
    admin = new PgClient({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${databaseName}`;
    postgresUrl = url.toString();
  }
  const storage = await openDatabase({
    dataDir: root,
    ...(postgresUrl ? { postgresUrl } : {}),
  });
  return {
    root,
    storage,
    cleanup: async () => {
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface SeedNote {
  tenantId: string;
  spaceId: string;
  noteId: string;
  ownerId: string;
  title: string;
  body: string;
  kind?: string;
  lifecycle?: string;
  pinned?: boolean;
  taskStatus?: string | null;
  edges?: { relation: string; target: string }[];
  revision?: number;
  deletedAt?: number | null;
}

async function seedNotes(
  storage: DatabaseHandle,
  notes: SeedNote[],
): Promise<void> {
  const now = Date.now();
  for (let start = 0; start < notes.length; start += 100) {
    const batch = notes.slice(start, start + 100);
    await storage.db
      .insertInto("memory_notes")
      .values(
        batch.map((note) => ({
          tenant_id: note.tenantId,
          space_id: note.spaceId,
          id: note.noteId,
          lifecycle: (note.lifecycle ?? "active") as never,
          pinned: note.pinned ? 1 : 0,
          task_status: (note.taskStatus ?? null) as never,
          current_revision: note.revision ?? 1,
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
          deleted_at: note.deletedAt ?? null,
        })),
      )
      .execute();
    await storage.db
      .insertInto("memory_note_revisions")
      .values(
        batch.map((note) => ({
          tenant_id: note.tenantId,
          space_id: note.spaceId,
          note_id: note.noteId,
          revision: note.revision ?? 1,
          format_version: 1,
          kind: note.kind ?? "note",
          title: note.title,
          summary: null,
          body_md: note.body,
          metadata_json: JSON.stringify({
            record_hash: "",
            record: {
              kind: note.kind ?? "note",
              title: note.title,
              summary: null,
              lifecycle: note.lifecycle ?? "active",
              pinned: note.pinned ?? false,
              task_status: note.taskStatus ?? null,
              verification: "declared",
              sources: [],
              edges: note.edges ?? [],
            },
          }),
          sources_json: "[]",
          base_revision: null,
          created_by: note.ownerId,
          created_at: now,
          file_path: null,
          content_hash: sha256Hex(note.body),
          byte_size: note.body.length,
        })),
      )
      .execute();
  }
}

async function fixture(backend: "sqlite" | "postgres") {
  const env = await openEnv(backend);
  const identities = new IdentityService(env.storage.db);
  const owner = await identities.bootstrapLocal();
  const service = new MemoryService(
    env.storage.db,
    identities,
    vaultRoot(env.root),
  );
  const personal = await service.ensureSpace(owner, { type: "personal" });
  const organization = await service.createOrganizationSpace(owner, "Ortak");
  const index = new MemoryIndexService(
    env.storage.db,
    vaultRoot(env.root),
    service,
  );
  const search = new MemorySearchService(env.storage.db, service);
  return {
    env,
    storage: env.storage,
    identities,
    owner,
    service,
    personal,
    organization,
    index,
    search,
  };
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#36 search finds the last-id strong match in a 1000+ corpus and navigation is complete (${backend})`, async () => {
    const { env, owner, personal, index, search, storage } =
      await fixture(backend);
    try {
      const notes: SeedNote[] = [];
      for (let i = 0; i < 1000; i += 1)
        notes.push({
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: `note-${String(i).padStart(4, "0")}`,
          ownerId: owner.userId,
          title: `Genel not ${i}`,
          body: `içerik ${i} ortak terim`,
        });
      // Güçlü eşleşme en son ID grubunda.
      notes.push({
        tenantId: owner.tenantId,
        spaceId: personal.id,
        noteId: "note-9999",
        ownerId: owner.userId,
        title: "Özel güçlü eşleşme başlığı",
        body: "benzersiz terim zeta",
      });
      await seedNotes(storage, notes);
      // Rebuild bounded per call: cursor ilerletilerek tüm korpus indekslenir.
      let indexAfter: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const report = await index.rebuild(owner, {
          batchSize: 500,
          after: indexAfter,
        });
        if (!report.next) break;
        indexAfter = report.next;
      }
      const result = await search.search(owner, {
        query: "benzersiz terim zeta",
        limit: 5,
      });
      expect(result.items[0]?.note_id).toBe("note-9999");
      expect(result.items[0]?.revision).toBe(1);
      expect(result.items.every((item) => item.revision === 1)).toBe(true);

      // Katalog gezinmesi relevance'ten ayrı ve eksiksiz; gerçek tekrarlar
      // düz diziyle denetlenir.
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 200; page += 1) {
        const list = await search.service.listNotes(owner, {
          spaceId: personal.id,
          after,
          limit: 100,
        });
        seen.push(...list.items.map((item) => item.id));
        if (!list.next) break;
        after = list.next;
      }
      const sorted = [...seen].sort();
      expect(sorted).toHaveLength(1001);
      expect(sorted[0]).toBe("note-0000");
      expect(sorted[sorted.length - 1]).toBe("note-9999");
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      await env.cleanup();
    }
  }, 120_000);

  test(`#36 TR/EN normalization, exact-title weight and bounded graph expansion (${backend})`, async () => {
    const { env, owner, personal, organization, index, search, storage } =
      await fixture(backend);
    try {
      await seedNotes(storage, [
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "tr-1",
          ownerId: owner.userId,
          title: "İÇİN kararı",
          body: "Çiğdem IŞIK için hazırlandı.",
        },
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "tr-2",
          ownerId: owner.userId,
          title: "Başka",
          body: "için çiğdem ışık",
        },
        {
          tenantId: owner.tenantId,
          spaceId: organization.id,
          noteId: "chain-target",
          ownerId: owner.userId,
          title: "Hedef notu",
          body: "hedef gövdesi",
        },
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "chain-source",
          ownerId: owner.userId,
          title: "Zincir kaynağı",
          body: "tamamen farklı gövde",
          edges: [{ relation: "SUPPORTS", target: "chain-target" }],
        },
      ]);
      await index.rebuild(owner, { batchSize: 100 });
      // Türkçe büyük/küçük harf: "İÇİN" ≡ "icin"; noktalı/noktasız I ayrımı
      // ve diakritik katlama birlikte.
      const tr = await search.search(owner, { query: "icin", limit: 5 });
      expect(tr.items.map((item) => item.note_id)).toContain("tr-1");
      const folded = await search.search(owner, {
        query: "cigdem isik",
        limit: 5,
      });
      expect(folded.items.map((item) => item.note_id).sort()).toEqual([
        "tr-1",
        "tr-2",
      ]);
      // Tam başlık eşleşmesi gövde eşleşmesinin önüne geçer.
      const exact = await search.search(owner, {
        query: "İÇİN kararı",
        limit: 5,
      });
      expect(exact.items[0]?.note_id).toBe("tr-1");
      expect(exact.items[0]?.match_reason).toContain("title:exact");
      // Sınırlı graph genişlemesi: kenar hedefi sonuçlara gerekçesiyle katılır.
      const graph = await search.search(owner, {
        query: "zincir",
        limit: 5,
        graphDepth: 1,
      });
      const ids = graph.items.map((item) => item.note_id);
      expect(ids).toContain("chain-source");
      expect(ids).toContain("chain-target");
      const target = graph.items.find(
        (item) => item.note_id === "chain-target",
      );
      expect(
        target?.match_reason.some((reason) => reason.startsWith("graph:")),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 stale index hits are excluded and reported, rebuild restores them (${backend})`, async () => {
    const { env, owner, personal, index, search, storage } =
      await fixture(backend);
    try {
      await seedNotes(storage, [
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "stale-1",
          ownerId: owner.userId,
          title: "Sürüm bir",
          body: "bayat terimi",
        },
      ]);
      await index.rebuild(owner, { batchSize: 100 });
      // Head ilerler ama indeks yenilenmez.
      await storage.db
        .updateTable("memory_note_revisions")
        .set({ revision: 2, body_md: "güncel gövde", title: "Sürüm iki" })
        .where("note_id", "=", "stale-1")
        .execute();
      await storage.db
        .updateTable("memory_notes")
        .set({ current_revision: 2, title: "Sürüm iki" })
        .where("id", "=", "stale-1")
        .execute();
      const stale = await search.search(owner, {
        query: "bayat terimi",
        limit: 5,
      });
      expect(stale.items).toEqual([]);
      expect(stale.index.stale).toBeGreaterThanOrEqual(1);
      const rebuilt = await index.rebuild(owner, { batchSize: 100 });
      expect(rebuilt.indexed).toBe(1);
      const fresh = await search.search(owner, {
        query: "güncel gövde",
        limit: 5,
      });
      expect(fresh.items[0]?.note_id).toBe("stale-1");
      expect(fresh.items[0]?.revision).toBe(2);
      expect(fresh.index.stale).toBe(0);
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 lifecycle/deletion/supersession reflect consistently and scope never leaks (${backend})`, async () => {
    const { env, storage, identities, owner, personal, index, search } =
      await fixture(backend);
    try {
      const other = await identities.bootstrapLocal(); // idempotent; same user
      // Başka kullanıcı ve başka kiracı.
      const now = Date.now();
      await storage.db
        .insertInto("users")
        .values({
          id: "u-b",
          subject: "u-b",
          display_name: "B",
          created_at: now,
        })
        .execute();
      await storage.db
        .insertInto("memberships")
        .values({ tenant_id: owner.tenantId, user_id: "u-b", role: "writer" })
        .execute();
      const serviceB = new MemoryService(
        storage.db,
        identities,
        vaultRoot(env.root),
      );
      const personalB = await serviceB.ensureSpace(
        { tenantId: owner.tenantId, userId: "u-b" },
        { type: "personal" },
      );
      await storage.db
        .insertInto("tenants")
        .values({ id: "tenant-x", name: "X", created_at: now })
        .execute();
      await storage.db
        .insertInto("users")
        .values({
          id: "u-x",
          subject: "u-x",
          display_name: "X",
          created_at: now,
        })
        .execute();
      await storage.db
        .insertInto("memberships")
        .values({ tenant_id: "tenant-x", user_id: "u-x", role: "founder" })
        .execute();
      await storage.db
        .insertInto("memory_spaces")
        .values({
          tenant_id: "tenant-x",
          id: "space-x",
          kind: "personal",
          owner_user_id: "u-x",
          project_id: null,
          name: "X",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await seedNotes(storage, [
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "active-1",
          ownerId: owner.userId,
          title: "Aktif",
          body: "kapsam terimi",
        },
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "archived-1",
          ownerId: owner.userId,
          title: "Arşiv",
          body: "kapsam terimi",
          lifecycle: "archived",
        },
        {
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "deleted-1",
          ownerId: owner.userId,
          title: "Silinmiş",
          body: "kapsam terimi",
          deletedAt: Date.now(),
        },
        {
          tenantId: owner.tenantId,
          spaceId: personalB.id,
          noteId: "other-user-1",
          ownerId: "u-b",
          title: "Diğer kullanıcı",
          body: "kapsam terimi",
        },
        {
          tenantId: "tenant-x",
          spaceId: "space-x",
          noteId: "other-tenant-1",
          ownerId: "u-x",
          title: "Diğer kiracı",
          body: "kapsam terimi",
        },
      ]);
      await index.rebuild(owner, { batchSize: 100 });
      await index.rebuild(
        { tenantId: "tenant-x", userId: "u-x" },
        {
          batchSize: 100,
        },
      );
      const result = await search.search(owner, {
        query: "kapsam terimi",
        limit: 10,
      });
      expect(result.items.map((item) => item.note_id)).toEqual(["active-1"]);
      expect(result.items.some((item) => item.space_id === personalB.id)).toBe(
        false,
      );
      // Yetkisiz alan açıkça istenirse yetki hatası; sızıntı yok.
      await expect(
        search.search(owner, {
          query: "kapsam terimi",
          spaceId: "space-x",
          limit: 5,
        }),
      ).rejects.toMatchObject({
        code: "memory_space_unavailable",
        status: 404,
      });
      void other;
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 cursor is bound to query/scope and index lag is reported (${backend})`, async () => {
    const { env, owner, personal, index, search, storage } =
      await fixture(backend);
    try {
      await seedNotes(
        storage,
        Array.from({ length: 5 }, (_, index) => ({
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: `page-${index}`,
          ownerId: owner.userId,
          title: `Sayfa ${index}`,
          body: "sayfalama terimi",
          pinned: index === 0,
        })),
      );
      await index.rebuild(owner, { batchSize: 100 });
      const first = await search.search(owner, {
        query: "sayfalama terimi",
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await search.search(owner, {
        query: "sayfalama terimi",
        limit: 2,
        after: first.next!,
      });
      expect(second.items).toHaveLength(2);
      expect(
        second.items.some((item) =>
          first.items.some((firstItem) => firstItem.note_id === item.note_id),
        ),
      ).toBe(false);
      // Başka sorguya ait cursor reddedilir.
      await expect(
        search.search(owner, {
          query: "bambaşka",
          limit: 2,
          after: first.next!,
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
      // İndeks gecikmesi: committed ama indexed_at yok.
      const now = Date.now();
      await storage.db
        .insertInto("memory_events")
        .values({
          tenant_id: owner.tenantId,
          space_id: personal.id,
          id: "lag-evt",
          source_event_key: "lag-evt",
          source_kind: "manual",
          content_hash: "a".repeat(64),
          state: "committed",
          observed_at: null,
          created_at: now,
          updated_at: now,
          committed_revision: 1,
          note_id: "page-0",
          error_code: null,
          receipt_json: null,
          attempts: 1,
          indexed_at: null,
        })
        .execute();
      const lagged = await search.search(owner, {
        query: "sayfalama terimi",
        limit: 2,
      });
      expect(lagged.index.pending_events).toBeGreaterThanOrEqual(1);
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  if (backend === "sqlite") {
    test("#36 10k corpus keeps global discovery and bounded catalog scans", async () => {
      const { env, owner, personal, index, search, storage } =
        await fixture(backend);
      try {
        const notes: SeedNote[] = [];
        for (let i = 0; i < 10_000; i += 1)
          notes.push({
            tenantId: owner.tenantId,
            spaceId: personal.id,
            noteId: `bulk-${String(i).padStart(5, "0")}`,
            ownerId: owner.userId,
            title: `Toplu ${i}`,
            body: `yaygın terim ${i % 7}`,
          });
        notes.push({
          tenantId: owner.tenantId,
          spaceId: personal.id,
          noteId: "bulk-99999",
          ownerId: owner.userId,
          title: "Son güçlü",
          body: "ultra nadir omega",
        });
        const started = Date.now();
        await seedNotes(storage, notes);
        let after: string | undefined;
        for (let page = 0; page < 25; page += 1) {
          const report = await index.rebuild(owner, {
            batchSize: 500,
            after,
          });
          if (!report.next) break;
          after = report.next;
        }
        const found = await search.search(owner, {
          query: "ultra nadir omega",
          limit: 3,
        });
        expect(found.items[0]?.note_id).toBe("bulk-99999");
        expect(Date.now() - started).toBeLessThan(120_000);
      } finally {
        await env.cleanup();
      }
    }, 180_000);
  }
}
