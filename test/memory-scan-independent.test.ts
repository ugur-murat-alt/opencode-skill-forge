import { test, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemorySourceService } from "../src/memory/sources.js";
import { readStableText, sha256Hex } from "../src/memory/files.js";
import { noteWorkingPath, vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M02 (#35) kaynak uzlaştırma testleri.
 *
 * - Bounded tur: tur başına okuma limiti aşılmaz, "ilk N'e dönme" yok; son
 *   dosyadaki güçlü eşleşme (zz-needle) bulunur ve tam tur sonrası ikinci
 *   geçiş yalnız "unchanged" üretir.
 * - Cursor ortasına eklenen dosya bu turda atlanır (dokümante sınır), sonraki
 *   tam turda kaybolmadan bulunur.
 * - Kopya note_id, case çakışması, symlink, boyut sınırı ve kök dışı yollar
 *   görünür karar üretir; yarım yazım `readStableText` ile yakalanır.
 * - Tombstone: silinen not yeniden taramayla dirilmez; açık restore sonrası
 *   dış değişiklik aday olur.
 *
 * Silinen kaynak kökü çekirdek düzeltmesiyle (`e26d46c`) ham ENOENT yerine
 * kaynak durumu (`missing`) raporlar; test normal regresyondur.
 */

interface Env {
  root: string;
  storage: DatabaseHandle;
  cleanup: () => Promise<void>;
}

async function openEnv(backend: "sqlite" | "postgres"): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-scan-ind-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  let databaseName: string | undefined;
  if (backend === "postgres") {
    databaseName = `forge_m02_scan_ind_${crypto.randomUUID().replaceAll("-", "")}`;
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
      if (admin && databaseName) {
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
  const commits = new MemoryCommitService({
    db: env.storage.db,
    vaultRoot: vaultRoot(env.root),
    service,
  });
  return { env, owner, service, space, sources, commits };
}

async function drain(
  sources: MemorySourceService,
  owner: Identity,
  sourceId: string,
  limit: number,
  maxTurns = 200,
) {
  const reports = [];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const report = await sources.scan(owner, { sourceId, limit });
    reports.push(report);
    if (report.done) return reports;
  }
  throw new Error("tarama tur bütçesinde bitmedi");
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
  const binding = {
    source_id: input.sourceId,
    source_path: input.path,
    source_hash: input.hash,
    source_state: "present" as const,
  };
  const updated = await storage.db
    .updateTable("memory_notes")
    .set(binding)
    .where("tenant_id", "=", owner.tenantId)
    .where("space_id", "=", spaceId)
    .where("id", "=", input.noteId)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) > 0) return;
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

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
] as const) {
  test(
    `#35 bağımsız: bounded tarama tur başına limiti aşmaz, son dosyayı bulur, satırları çoğaltmaz (${backend})`,
    async () => {
      const { env, owner, space, sources } = await fixture(backend);
      const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-scan-big-"));
      try {
        const dirCount = backend === "sqlite" ? 10 : 1;
        const perDir = backend === "sqlite" ? 100 : 60;
        const limit = backend === "sqlite" ? 100 : 25;
        let total = 0;
        for (let d = 0; d < dirCount; d += 1) {
          const dir = join(sourceRoot, `d${String(d).padStart(2, "0")}`);
          await mkdir(dir, { recursive: true });
          for (let f = 0; f < perDir; f += 1)
            await writeFile(
              join(dir, `f${String(f).padStart(3, "0")}.md`),
              `içerik ${d}-${f}`,
            );
          total += perDir;
        }
        // Alfabetik olarak en sonda: "yalnız ilk N" taraması bunu kaçırırdı.
        await writeFile(join(sourceRoot, "zz-needle.md"), "iğne içerik");
        total += 1;
        const source = await sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: sourceRoot,
          mode: "read_only",
        });
        const reports = await drain(sources, owner, source.id, limit);
        expect(reports.at(-1)!.done).toBe(true);
        for (const report of reports) {
          expect(report.scanned).toBeLessThanOrEqual(limit);
        }
        const read = reports.reduce((sum, report) => sum + report.read, 0);
        const candidates = reports.reduce(
          (sum, report) => sum + report.candidates,
          0,
        );
        expect(read).toBe(total);
        expect(candidates).toBe(total);
        const needle = await env.storage.db
          .selectFrom("memory_change_candidates")
          .select(["state", "reason"])
          .where("path", "=", "zz-needle.md")
          .executeTakeFirstOrThrow();
        expect(needle).toMatchObject({ state: "candidate", reason: "new" });
        // İkinci tam geçiş: aday satırları çoğalmaz (upsert), okuma yine
        // bounded; hiçbir dosya atlanmaz.
        const second = await drain(sources, owner, source.id, limit);
        const secondRead = second.reduce((sum, report) => sum + report.read, 0);
        expect(secondRead).toBe(total);
        const rowCount = await env.storage.db
          .selectFrom("memory_change_candidates")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirstOrThrow();
        expect(Number(rowCount.n)).toBe(total);
        const distinct = await env.storage.db
          .selectFrom("memory_change_candidates")
          .select("path")
          .execute();
        expect(new Set(distinct.map((row) => row.path)).size).toBe(total);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await env.cleanup();
      }
    },
    backend === "sqlite" ? 180000 : 90000,
  );

  test(`#35 bağımsız: cursor ortasına giren dosya kaybolmaz, sonraki tam turda bulunur (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-scan-cur-"));
    try {
      for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"])
        await writeFile(join(sourceRoot, name), `içerik ${name}`);
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      // İlk tur: yalnız a,b. Cursor b'de.
      const first = await sources.scan(owner, {
        sourceId: source.id,
        limit: 2,
      });
      expect(first.done).toBe(false);
      expect(first.cursor).toBe("b.md");
      // Cursor'un gerisinde kalan yeni dosya bu turda atlanır (sınır),
      // ama kaybolmaz: tur sonunda ikinci tam geçiş bulur.
      await writeFile(join(sourceRoot, "0-early.md"), "erken içerik");
      const remaining = await drain(sources, owner, source.id, 2);
      expect(remaining.at(-1)!.done).toBe(true);
      const hidden = await env.storage.db
        .selectFrom("memory_change_candidates")
        .select(["id"])
        .where("path", "=", "0-early.md")
        .execute();
      expect(hidden).toHaveLength(0);
      const secondPass = await drain(sources, owner, source.id, 2);
      expect(secondPass.at(-1)!.done).toBe(true);
      const found = await env.storage.db
        .selectFrom("memory_change_candidates")
        .select(["state", "reason"])
        .where("path", "=", "0-early.md")
        .executeTakeFirstOrThrow();
      expect(found).toMatchObject({ state: "candidate", reason: "new" });
      // Aday satırları yoldan bağımsız çoğalmaz: her dosya için tek satır.
      const rows = await env.storage.db
        .selectFrom("memory_change_candidates")
        .select("path")
        .execute();
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((row) => row.path)).size).toBe(7);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30000);

  test(`#35 bağımsız: kopya id/case/symlink/boyut kararları ve kök dışı ret (${backend})`, async () => {
    const { env, owner, space, sources } = await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-scan-edge-"));
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
        frontmatter("edge-dup", "Sahip"),
      );
      await writeFile(
        join(sourceRoot, "copy.md"),
        frontmatter("edge-dup", "Kopya"),
      );
      await writeFile(join(sourceRoot, "Case.md"), "büyük");
      await writeFile(join(sourceRoot, "case.md"), "küçük");
      await symlink(join(sourceRoot, "owner.md"), join(sourceRoot, "link.md"));
      await writeFile(join(sourceRoot, "big.md"), "x".repeat(2048));
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "read_only",
      });
      await bindNote(env.storage, owner, space.id, {
        noteId: "edge-dup",
        sourceId: source.id,
        path: "owner.md",
        hash: sha256Hex(frontmatter("edge-dup", "Sahip")),
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
      // Karantina ham içerik saklamaz.
      const quarantineDir = join(vaultRoot(env.root), ".quarantine");
      const entries = await readdir(quarantineDir);
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const name of entries) {
        const raw = await readFile(join(quarantineDir, name), "utf8");
        expect(raw).not.toContain("x".repeat(64));
        expect(raw.length).toBeLessThan(2000);
      }
      // Kök dışı/relative ve vault içi kök reddedilir.
      await expect(
        sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: "relative/path",
          mode: "read_only",
        }),
      ).rejects.toMatchObject({ code: "invalid_memory_source", status: 422 });
      await mkdir(vaultRoot(env.root), { recursive: true });
      await expect(
        sources.registerSource(owner, {
          spaceId: space.id,
          rootPath: vaultRoot(env.root),
          mode: "managed",
        }),
      ).rejects.toMatchObject({ code: "invalid_memory_source", status: 422 });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30000);

  test(`#35 bağımsız: tombstone yeniden dirilmez, açık restore sonrası dış değişiklik aday olur (${backend})`, async () => {
    const { env, owner, service, space, sources, commits } =
      await fixture(backend);
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-scan-tomb-"));
    try {
      const content = [
        "---",
        "format_version: 1",
        'note_id: "tomb-scan-note"',
        `memory_space_id: ${JSON.stringify(space.id)}`,
        "kind: note",
        'title: "Tarama tombstone"',
        "---",
        "",
        "İlk gövde.",
        "",
      ].join("\n");
      const event = await service.recordEvent(owner, {
        spaceId: space.id,
        sourceEventKey: "tomb-scan-e1",
        sourceKind: "manual",
        contentHash: sha256Hex(content),
      });
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.event.id,
        sourceKind: "manual",
        content: content,
      });
      const working = await readFile(
        noteWorkingPath(vaultRoot(env.root), space.id, "tomb-scan-note"),
        "utf8",
      );
      const sourceFile = join(sourceRoot, "bind.md");
      await writeFile(sourceFile, working);
      const source = await sources.registerSource(owner, {
        spaceId: space.id,
        rootPath: sourceRoot,
        mode: "managed",
      });
      await bindNote(env.storage, owner, space.id, {
        noteId: "tomb-scan-note",
        sourceId: source.id,
        path: "bind.md",
        hash: sha256Hex(working),
        revision: 1,
      });
      // Değişmeyen dosya: aday yok.
      let report = await sources.scan(owner, {
        sourceId: source.id,
        limit: 50,
      });
      expect(report.unchanged).toBe(1);
      expect(report.candidates).toBe(0);
      // Tombstone + dış değişiklik: diriltme yok.
      await service.archiveNote(owner, {
        spaceId: space.id,
        noteId: "tomb-scan-note",
      });
      await writeFile(sourceFile, `${working}\nDış değişiklik.\n`);
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.skipped).toBe(1);
      expect(report.candidates).toBe(0);
      const tombstone = await env.storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "tomb-scan-note")
        .executeTakeFirstOrThrow();
      expect(tombstone.deleted_at).not.toBeNull();
      // Açık restore + dış değişiklik: görünür aday.
      await service.restoreNote(owner, {
        spaceId: space.id,
        noteId: "tomb-scan-note",
      });
      report = await sources.scan(owner, { sourceId: source.id, limit: 50 });
      expect(report.candidates).toBe(1);
      const candidate = await env.storage.db
        .selectFrom("memory_change_candidates")
        .select(["state", "reason", "note_id"])
        .where("path", "=", "bind.md")
        .executeTakeFirstOrThrow();
      expect(candidate).toMatchObject({
        state: "candidate",
        reason: "updated",
        note_id: "tomb-scan-note",
      });
      const restored = await env.storage.db
        .selectFrom("memory_notes")
        .select(["deleted_at", "source_state"])
        .where("id", "=", "tomb-scan-note")
        .executeTakeFirstOrThrow();
      expect(restored.deleted_at).toBeNull();
      expect(restored.source_state).toBe("present");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30000);
}

test("#35 bağımsız: readStableText yarım yazımı ya yakalar ya da kararlı hash döndürür", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-stable-"));
  try {
    const path = join(root, "unstable.md");
    await writeFile(path, "başlangıç");
    let changed = 0;
    let stable = 0;
    for (let i = 0; i < 24; i += 1) {
      const payload = `sürüm-${i}:` + "x".repeat(1_000_000 + i * 4096);
      const writing = writeFile(path, payload);
      try {
        const result = await readStableText(path, { maxBytes: 8_000_000 });
        // Kararlı sonuç: hash gerçekten okunan baytlarla uyuşmalı.
        expect(result.hash).toBe(sha256Hex(result.content));
        stable += 1;
      } catch (error) {
        const code = (error as { code?: string }).code;
        expect(code).toBe("memory_file_changed");
        changed += 1;
      }
      await writing;
    }
    // En az bir yarım yazım yakalanmalı; tümü kararlıysa test ortamı
    // yarışı üretememiş demektir ve bu kanıt sayılmaz.
    expect(changed).toBeGreaterThan(0);
    expect(stable + changed).toBe(24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("#35 bağımsız: silinen kaynak kökü scan'i ham ENOENT ile düşürmemeli", async () => {
  const { env, owner, space, sources } = await fixture("sqlite");
  const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-scan-gone-"));
  try {
    await writeFile(join(sourceRoot, "a.md"), "içerik");
    const source = await sources.registerSource(owner, {
      spaceId: space.id,
      rootPath: sourceRoot,
      mode: "read_only",
    });
    await rm(sourceRoot, { recursive: true, force: true });
    const report = await sources.scan(owner, {
      sourceId: source.id,
      limit: 50,
    });
    expect(typeof report.scanned).toBe("number");
  } finally {
    await env.cleanup();
  }
}, 30000);
