import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemorySourceService } from "../src/memory/sources.js";
import { sha256Hex } from "../src/memory/files.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Issue #35 (M02): source registration, bounded cursor reconciliation and
 * visible candidates/conflicts. Real directories and real DB rows; the
 * 1000+ file case proves per-turn file reads stay bounded while every change
 * is eventually found.
 */

async function openEnv(backend: "sqlite" | "postgres") {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-scan-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  const databaseName = `forge_m02_scan_${crypto.randomUUID().replaceAll("-", "")}`;
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

async function fixture(backend: "sqlite" | "postgres") {
  const env = await openEnv(backend);
  const identities = new IdentityService(env.storage.db);
  const owner = await identities.bootstrapLocal();
  const service = new MemoryService(
    env.storage.db,
    identities,
    vaultRoot(env.root),
  );
  const space = await service.ensureSpace(owner, { type: "personal" });
  const sources = new MemorySourceService({
    db: env.storage.db,
    vaultRoot: vaultRoot(env.root),
    service,
  });
  return { env, owner, service, space, sources };
}

async function bindNote(
  storage: DatabaseHandle,
  owner: Identity,
  spaceId: string,
  input: {
    noteId: string;
    sourceId: string;
    path: string;
    hash: string;
    revision?: number;
    deletedAt?: number | null;
  },
) {
  const now = Date.now();
  await storage.db
    .insertInto("memory_notes")
    .values({
      tenant_id: owner.tenantId,
      space_id: spaceId,
      id: input.noteId,
      lifecycle: input.deletedAt ? "archived" : "active",
      pinned: 0,
      task_status: null,
      current_revision: input.revision ?? 1,
      format_version: 1,
      title: "Bağlı not",
      summary: null,
      created_at: now,
      updated_at: now,
      superseded_by: null,
      source_id: input.sourceId,
      source_path: input.path,
      source_hash: input.hash,
      source_state: "present",
      deleted_at: input.deletedAt ?? null,
    })
    .execute();
}

async function drain(
  sources: MemorySourceService,
  owner: Identity,
  sourceId: string,
  limit: number,
  maxTurns = 500,
) {
  const reports = [];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const report = await sources.scan(owner, { sourceId, limit });
    reports.push(report);
    if (report.done) return reports;
  }
  throw new Error("scan did not finish within the turn budget");
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#35 source registration is canonical, idempotent and vault-safe (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-source-root-"));
    try {
      const first = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      expect(first.mode).toBe("read_only");
      expect(first.root_path).toBe(await realpathOf(sourceRoot));
      const again = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      expect(again.id).toBe(first.id);
      await expect(
        sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: "göreli/yol",
          mode: "read_only",
        }),
      ).rejects.toMatchObject({ code: "invalid_memory_source", status: 422 });
      await expect(
        sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: join(sourceRoot, "yok"),
          mode: "read_only",
        }),
      ).rejects.toMatchObject({
        code: "memory_source_unavailable",
        status: 404,
      });
      await mkdir(vaultRoot(env.root), { recursive: true });
      await expect(
        sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: vaultRoot(env.root),
          mode: "managed",
        }),
      ).rejects.toMatchObject({ code: "invalid_memory_source", status: 422 });
      expect(
        await sources.listSources(owner, { spaceId: space.id }),
      ).toHaveLength(1);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 scan surfaces new files as candidates and keeps a resumable cursor (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-source-root-"));
    try {
      await writeFile(join(sourceRoot, "a.md"), "içerik a");
      await writeFile(join(sourceRoot, "b.md"), "içerik b");
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      const reports = await drain(sources, owner, source.id, 1);
      // Sayfa başına 1 dosya: üç tur (a, b, kapanış) ve ilerleyen cursor.
      expect(reports.length).toBeGreaterThanOrEqual(2);
      expect(reports.at(-1)!.done).toBe(true);
      expect(reports.at(-1)!.cursor).toBeNull();
      const totalRead = reports.reduce((sum, report) => sum + report.read, 0);
      expect(totalRead).toBe(2);
      const candidates = await sources.listCandidates(owner, {
        spaceId: space.id,
      });
      expect(candidates.items).toHaveLength(2);
      expect(candidates.items.map((item) => item.path).sort()).toEqual([
        "a.md",
        "b.md",
      ]);
      expect(candidates.items.every((item) => item.state === "candidate")).toBe(
        true,
      );
      expect(candidates.items.every((item) => item.reason === "new")).toBe(
        true,
      );
      const reloaded = await env.storage.db
        .selectFrom("memory_sources")
        .selectAll()
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow();
      expect(reloaded.last_scan_at).not.toBeNull();
      expect(reloaded.cursor_json).toBeNull();
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 scan classifies unchanged/updated/missing/conflict and never revives tombstones (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-source-bound-"));
    try {
      const file = join(sourceRoot, "a.md");
      await writeFile(file, "sürüm 1");
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "managed",
      });
      await bindNote(env.storage, owner, space.id, {
        noteId: "not-a",
        sourceId: source.id,
        path: "a.md",
        hash: sha256Hex("sürüm 1"),
        revision: 1,
      });
      // Değişmemiş dosya yeniden aday üretmez.
      let report = await sources.scan(owner, {
        sourceId: source.id,
        limit: 50,
      });
      expect(report.unchanged).toBe(1);
      expect(report.candidates).toBe(0);
      // Dış değişiklik aday olur; kabul edilmiş head henüz ilerlemedi.
      await writeFile(file, "sürüm 2");
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.candidates).toBe(1);
      const candidate = await env.storage.db
        .selectFrom("memory_change_candidates")
        .selectAll()
        .where("path", "=", "a.md")
        .executeTakeFirstOrThrow();
      expect(candidate.state).toBe("candidate");
      expect(candidate.reason).toBe("updated");
      expect(candidate.base_revision).toBe(1);
      // Head ilerler + dosya yeniden değişir: sessiz son-yazan-kazanmaz.
      await env.storage.db
        .updateTable("memory_notes")
        .set({ current_revision: 2 })
        .where("id", "=", "not-a")
        .execute();
      await writeFile(file, "sürüm 3");
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.conflicts).toBe(1);
      const conflict = await env.storage.db
        .selectFrom("memory_change_candidates")
        .selectAll()
        .where("path", "=", "a.md")
        .executeTakeFirstOrThrow();
      expect(conflict.state).toBe("conflict");
      expect(conflict.reason).toBe("external_and_accepted_changed");
      // Dosya silinir: not silinmez, kaynak durumu missing olur.
      await rm(file);
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.missing).toBe(1);
      const deletedSourceNote = await env.storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "not-a")
        .executeTakeFirstOrThrow();
      expect(deletedSourceNote.source_state).toBe("missing");
      expect(deletedSourceNote.deleted_at).toBeNull();
      // Tombstone: dosya geri gelse bile not diriltilmez.
      await env.storage.db
        .updateTable("memory_notes")
        .set({ deleted_at: Date.now(), lifecycle: "archived" })
        .where("id", "=", "not-a")
        .execute();
      await writeFile(file, "sürüm 4");
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.skipped).toBe(1);
      expect(report.candidates).toBe(0);
      const tombstone = await env.storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "not-a")
        .executeTakeFirstOrThrow();
      expect(tombstone.deleted_at).not.toBeNull();
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 duplicate note_id, case conflict, symlink and large file stay visible (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-source-edge-"));
    try {
      const frontmatter = (noteId: string, title: string) =>
        [
          "---",
          "format_version: 1",
          `note_id: ${JSON.stringify(noteId)}`,
          `memory_space_id: ${JSON.stringify(space.id)}`,
          "kind: note",
          `title: ${JSON.stringify(title)}`,
          "---",
          "",
          title,
          "",
        ].join("\n");
      await writeFile(
        join(sourceRoot, "owner.md"),
        frontmatter("dup-id", "Sahip"),
      );
      await writeFile(
        join(sourceRoot, "copy.md"),
        frontmatter("dup-id", "Kopya"),
      );
      await writeFile(join(sourceRoot, "Case.md"), "büyük harf");
      await writeFile(join(sourceRoot, "case.md"), "küçük harf");
      await symlink(join(sourceRoot, "owner.md"), join(sourceRoot, "link.md"));
      await writeFile(join(sourceRoot, "big.md"), "x".repeat(4096));
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      await bindNote(env.storage, owner, space.id, {
        noteId: "dup-id",
        sourceId: source.id,
        path: "owner.md",
        hash: sha256Hex(frontmatter("dup-id", "Sahip")),
        revision: 1,
      });
      const custom = new MemorySourceService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service: sources.service,
        maxFileBytes: 1024,
      });
      const reports = await drain(custom, owner, source.id, 50);
      expect(reports.at(-1)!.done).toBe(true);
      const rows = await env.storage.db
        .selectFrom("memory_change_candidates")
        .selectAll()
        .execute();
      const byPath = new Map(rows.map((row) => [row.path, row]));
      expect(byPath.get("copy.md")).toMatchObject({
        state: "conflict",
        reason: "duplicate_note_id",
        note_id: "dup-id",
      });
      expect(byPath.get("case.md")).toMatchObject({
        state: "conflict",
        reason: "case_conflict",
      });
      expect(byPath.get("link.md")).toMatchObject({
        state: "quarantined",
        reason: "symlink",
      });
      expect(byPath.get("big.md")).toMatchObject({
        state: "quarantined",
        reason: "too_large",
      });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30_000);

  if (backend === "sqlite") {
    test("#35 1000+ sources are fully reconciled with a bounded per-turn read budget", async () => {
      const { env, owner, space, sources } = await fixture(backend);
      const sourceRoot = await mkdtemp(join(tmpdir(), "forge-source-large-"));
      try {
        const total = 1005;
        for (let dirIndex = 0; dirIndex < 10; dirIndex += 1) {
          const dir = join(sourceRoot, `d${String(dirIndex).padStart(2, "0")}`);
          await mkdir(dir, { recursive: true });
          for (let fileIndex = 0; fileIndex < 100; fileIndex += 1) {
            await writeFile(
              join(dir, `f${String(fileIndex).padStart(3, "0")}.md`),
              `içerik ${dirIndex}-${fileIndex}`,
            );
          }
        }
        for (let rootIndex = 0; rootIndex < 5; rootIndex += 1)
          await writeFile(join(sourceRoot, `root-${rootIndex}.md`), "kök");
        const source = await sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: sourceRoot,
          mode: "read_only",
        });
        const reports = await drain(sources, owner, source.id, 200);
        const read = reports.reduce((sum, report) => sum + report.read, 0);
        const candidates = reports.reduce(
          (sum, report) => sum + report.candidates,
          0,
        );
        expect(read).toBe(total);
        expect(candidates).toBe(total);
        expect(reports.at(-1)!.done).toBe(true);
        for (const report of reports)
          expect(report.scanned).toBeLessThanOrEqual(200);
        // Turnu tamamlamayan ara turlar sonraki tura gerçek cursor bırakır.
        const intermediate = reports.slice(0, -1);
        expect(
          intermediate.every(
            (report) => report.cursor !== null && !report.done,
          ),
        ).toBe(true);
        expect(
          (
            await env.storage.db
              .selectFrom("memory_change_candidates")
              .select((eb) => eb.fn.countAll<number>().as("n"))
              .executeTakeFirstOrThrow()
          ).n,
        ).toBe(total);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await env.cleanup();
      }
    }, 120_000);
  }
}

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
