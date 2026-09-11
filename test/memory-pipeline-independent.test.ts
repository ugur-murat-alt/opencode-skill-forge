import { test, expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import {
  MEMORY_CONTENT_MAX_BYTES,
  MemoryCommitService,
} from "../src/memory/commit.js";
import { VaultWriter } from "../src/memory/writer.js";
import { sha256Hex } from "../src/memory/files.js";
import {
  noteWorkingPath,
  revisionDir,
  resolveVaultRelative,
  vaultRoot,
} from "../src/memory/paths.js";

/**
 * Bağımsız M02 (#35) kabul testleri: gerçek dosya + DB + gerçek çocuk süreç.
 *
 * Çekirdeğin testlerini kopyalamaz; #35 kabul maddelerini kendi senaryolarıyla
 * doğrular: create/edit/read, replay'de tek receipt/revision, farklı hash 409,
 * gerçek SIGKILL kesintileri (b)/(c), CAS kaybedeninin yalnız kendi adayını
 * silmesi, yazıcı kilidi yarışında temiz hata, tombstone/restore, içerik
 * sınırı ve redaksiyon politikası.
 *
 * Bilinen açık uçlar `test.failing` ile işaretlidir; çekirdek düzeltmesi
 * gelince test yeşile döner ve Bun "failing ama geçti" diye uyarır (bilinçli
 * flip sinyali).
 */

interface Env {
  root: string;
  storage: DatabaseHandle;
  postgresUrl?: string;
  cleanup: () => Promise<void>;
}

async function openEnv(backend: "sqlite" | "postgres"): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-verify-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  let databaseName: string | undefined;
  if (backend === "postgres") {
    databaseName = `forge_m02_verify_${crypto.randomUUID().replaceAll("-", "")}`;
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
    postgresUrl,
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

function contentFor(
  noteId: string,
  spaceId: string,
  title: string,
  body: string,
): string {
  return [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(noteId)}`,
    `memory_space_id: ${JSON.stringify(spaceId)}`,
    "kind: note",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
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
  const commits = new MemoryCommitService({
    db: env.storage.db,
    vaultRoot: vaultRoot(env.root),
    service,
  });
  const record = async (
    key: string,
    content: string,
    sourceKind = "manual",
  ) => {
    const outcome = await service.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: key,
      sourceKind,
      contentHash: sha256Hex(content),
    });
    return outcome.event;
  };
  return { env, owner, service, space, commits, record };
}

async function rejection(
  action: () => Promise<unknown>,
): Promise<{ code?: string; status?: number }> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError)
      throw error;
    return error as { code?: string; status?: number };
  }
  throw new Error("hata beklenirken çağrı başarılı oldu");
}

function fakeWriter(): VaultWriter {
  return {
    acquire: async () => ({
      heartbeat: async () => true,
      release: async () => {},
    }),
  } as unknown as VaultWriter;
}

async function revisionFileNames(
  dataDir: string,
  spaceId: string,
  noteId: string,
) {
  return (
    await readdir(revisionDir(vaultRoot(dataDir), spaceId, noteId))
  ).sort();
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
] as const) {
  test(`#35 bağımsız: create/edit/read, replay tek receipt ve farklı hash 409 (${backend})`, async () => {
    const { env, owner, service, space, commits, record } =
      await fixture(backend);
    try {
      const v1 = contentFor("ind-note", space.id, "Sürüm 1", "Gövde 1.");
      const e1 = await record("ind-e1", v1);
      const r1 = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      expect(r1.status).toBe("committed");
      expect(r1.revision).toBe(1);
      expect(r1.indexed).toBe(true);
      const file1 = await readFile(
        resolveVaultRelative(vaultRoot(env.root), r1.filePath),
        "utf8",
      );
      expect(sha256Hex(file1)).toBe(r1.fileHash);
      // Gerçek "okuma": kabul edilen revizyon ve içerik.
      const read1 = await service.readNote(owner, {
        spaceId: space.id,
        noteId: "ind-note",
      });
      expect(read1.revision?.revision).toBe(1);
      expect(read1.revision?.content_hash).toBe(r1.fileHash);
      expect(read1.content).toContain("Gövde 1.");
      // Düzenleme: base_revision zorunlu ve CAS ile ilerler.
      const v2 = contentFor("ind-note", space.id, "Sürüm 2", "Gövde 2.");
      const e2 = await record("ind-e2", v2);
      const missingBase = await rejection(() =>
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: e2.id,
          sourceKind: "manual",
          content: v2,
        }),
      );
      expect(missingBase.code).toBe("memory_revision_required");
      const r2 = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(r2.status).toBe("committed");
      expect(r2.revision).toBe(2);
      // Aynı olayın tekrarı: aynı revision, yeni satır/dosya yok.
      const replay1 = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      expect(replay1.status).toBe("duplicate");
      expect(replay1.revision).toBe(1);
      expect(replay1.filePath).toBe(r1.filePath);
      const replay2 = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(replay2.status).toBe("duplicate");
      expect(replay2.revision).toBe(2);
      const revisionRows = await env.storage.db
        .selectFrom("memory_note_revisions")
        .select(["revision"])
        .where("note_id", "=", "ind-note")
        .execute();
      expect(revisionRows.map((row) => row.revision).sort()).toEqual([1, 2]);
      expect(
        await revisionFileNames(env.root, space.id, "ind-note"),
      ).toHaveLength(2);
      // Aynı kaynak anahtarı farklı içerikle: 409.
      const conflict = await rejection(() =>
        service.recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "ind-e1",
          sourceKind: "manual",
          contentHash: sha256Hex("başka içerik"),
        }),
      );
      expect(conflict.code).toBe("memory_event_conflict");
      expect(conflict.status).toBe(409);
      // Teslim edilen içerik kabul edilen hash ile uyuşmazsa commit yazmaz.
      const e3 = await record("ind-e3", "kabul edilen");
      const mismatch = await rejection(() =>
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: e3.id,
          sourceKind: "manual",
          content: "farklı içerik",
        }),
      );
      expect(mismatch.code).toBe("memory_content_mismatch");
      expect(mismatch.status).toBe(409);
      expect(
        await revisionFileNames(env.root, space.id, "ind-note"),
      ).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  }, 30000);

  test(`#35 bağımsız: CAS kaybedeni yalnız kendi adayını siler, kazanan dosyası yerinde (${backend})`, async () => {
    const { env, owner, space, commits } = await fixture(backend);
    try {
      const v1 = contentFor("cas-note", space.id, "Sürüm 1", "Temel.");
      const e1 = await (async () => {
        const outcome = await new MemoryService(
          env.storage.db,
          undefined,
          vaultRoot(env.root),
        ).recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "cas-e1",
          sourceKind: "manual",
          contentHash: sha256Hex(v1),
        });
        return outcome.event;
      })();
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      const vA = contentFor("cas-note", space.id, "Kazanan", "A içeriği.");
      const vB = contentFor("cas-note", space.id, "Kaybeden", "B içeriği.");
      const eA = await (async () => {
        const outcome = await new MemoryService(
          env.storage.db,
          undefined,
          vaultRoot(env.root),
        ).recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "cas-eA",
          sourceKind: "manual",
          contentHash: sha256Hex(vA),
        });
        return outcome.event;
      })();
      const eB = await (async () => {
        const outcome = await new MemoryService(
          env.storage.db,
          undefined,
          vaultRoot(env.root),
        ).recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "cas-eB",
          sourceKind: "manual",
          contentHash: sha256Hex(vB),
        });
        return outcome.event;
      })();

      // Deterministik yarış: B dosyayı yayınladıktan sonra hook içinde A
      // commit'lenir; B DB CAS'ında kaybeder ve kendi adayını temizler.
      const commitsA = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service: new MemoryService(
          env.storage.db,
          undefined,
          vaultRoot(env.root),
        ),
        writer: fakeWriter(),
      });
      const commitsB = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service: new MemoryService(
          env.storage.db,
          undefined,
          vaultRoot(env.root),
        ),
        writer: fakeWriter(),
        hooks: {
          afterPublish: async () => {
            await commitsA.commit({
              identity: owner,
              spaceId: space.id,
              eventId: eA.id,
              sourceKind: "manual",
              content: vA,
              baseRevision: 1,
            });
          },
        },
      });
      const loser = await rejection(() =>
        commitsB.commit({
          identity: owner,
          spaceId: space.id,
          eventId: eB.id,
          sourceKind: "manual",
          content: vB,
          baseRevision: 1,
        }),
      );
      expect(loser.code).toBe("memory_revision_conflict");
      expect(loser.status).toBe(409);
      const winnerRows = await env.storage.db
        .selectFrom("memory_note_revisions")
        .select(["revision", "file_path"])
        .where("note_id", "=", "cas-note")
        .orderBy("revision")
        .execute();
      expect(winnerRows.map((row) => row.revision)).toEqual([1, 2]);
      const files = await revisionFileNames(env.root, space.id, "cas-note");
      // Disk yalnız DB referanslı dosyaları taşır; kaybedenin adayı yok.
      const referencedNames = winnerRows
        .map((row) => row.file_path!.split("/").pop())
        .sort();
      expect(files).toEqual(referencedNames);
      const winnerRelative = winnerRows[1]!.file_path!;
      const winnerContent = await readFile(
        resolveVaultRelative(vaultRoot(env.root), winnerRelative),
        "utf8",
      );
      expect(winnerContent).toContain("A içeriği.");
      // Çalışma kopyası kazananın içeriğini taşır.
      const working = await readFile(
        noteWorkingPath(vaultRoot(env.root), space.id, "cas-note"),
        "utf8",
      );
      expect(working).toContain("A içeriği.");
      // İki gerçek yazıcı yarışı: biri kazanır, diğeri temiz hata alır.
      const vC = contentFor("cas-note", space.id, "Yarış C", "C içeriği.");
      const vD = contentFor("cas-note", space.id, "Yarış D", "D içeriği.");
      const service2 = new MemoryService(
        env.storage.db,
        undefined,
        vaultRoot(env.root),
      );
      const eC = (
        await service2.recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "cas-eC",
          sourceKind: "manual",
          contentHash: sha256Hex(vC),
        })
      ).event;
      const eD = (
        await service2.recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "cas-eD",
          sourceKind: "manual",
          contentHash: sha256Hex(vD),
        })
      ).event;
      const first = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service: service2,
      });
      const second = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service: service2,
      });
      const raced = await Promise.allSettled([
        first.commit({
          identity: owner,
          spaceId: space.id,
          eventId: eC.id,
          sourceKind: "manual",
          content: vC,
          baseRevision: 2,
        }),
        second.commit({
          identity: owner,
          spaceId: space.id,
          eventId: eD.id,
          sourceKind: "manual",
          content: vD,
          baseRevision: 2,
        }),
      ]);
      expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(
        1,
      );
      const failed = raced.find((item) => item.status === "rejected") as
        PromiseRejectedResult | undefined;
      expect(failed).toBeDefined();
      const loserCode = (failed!.reason as { code?: string }).code;
      expect(
        loserCode === "memory_writer_busy" ||
          loserCode === "memory_revision_conflict",
      ).toBe(true);
      const finalRows = await env.storage.db
        .selectFrom("memory_note_revisions")
        .select(["revision"])
        .where("note_id", "=", "cas-note")
        .execute();
      expect(finalRows.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
      // Referanssız revision dosyası kalmadı.
      const referenced = await env.storage.db
        .selectFrom("memory_note_revisions")
        .select(["file_path"])
        .where("note_id", "=", "cas-note")
        .execute();
      const referencedSet = new Set(
        referenced.map((row) => row.file_path!.split("/").pop()),
      );
      const allFiles = await revisionFileNames(env.root, space.id, "cas-note");
      expect(allFiles.filter((name) => !referencedSet.has(name))).toEqual([]);
    } finally {
      await env.cleanup();
    }
  }, 60000);

  test(`#35 bağımsız: gerçek SIGKILL kesintileri (b) benimseme ve (c) indeks tamamlama (${backend})`, async () => {
    const env = await openEnv(backend);
    let child: ChildProcess | undefined;
    const script = join(
      import.meta.dir,
      "fixtures/memory/commit-crash-child.ts",
    );
    try {
      const identities = new IdentityService(env.storage.db);
      const owner = await identities.bootstrapLocal();
      const service = new MemoryService(
        env.storage.db,
        identities,
        vaultRoot(env.root),
      );
      const space = await service.ensureSpace(owner, { type: "personal" });
      const commits = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service,
        writer: new VaultWriter(vaultRoot(env.root), { leaseMs: 300 }),
      });
      const record = async (key: string, content: string) =>
        (
          await service.recordEvent(owner, {
            spaceId: space.id,
            sourceEventKey: key,
            sourceKind: "manual",
            contentHash: sha256Hex(content),
          })
        ).event;
      const spawnChild = async (
        eventId: string,
        content: string,
        marker: "PUBLISHED" | "COMMITTED",
        baseRevision?: number,
      ) => {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            DATA_DIR: env.root,
            VAULT: vaultRoot(env.root),
            POSTGRES_URL: env.postgresUrl ?? "",
            TENANT: owner.tenantId,
            USER: owner.userId,
            SPACE: space.id,
            EVENT: eventId,
            CONTENT_B64: Buffer.from(content).toString("base64"),
            MARKER: marker,
            ...(baseRevision !== undefined
              ? { BASE_REVISION: String(baseRevision) }
              : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const line = await new Promise<string>((resolveLine, rejectLine) => {
          let output = "";
          const timer = setTimeout(
            () => rejectLine(new Error(`child timeout: ${output}`)),
            15000,
          );
          child!.once("error", rejectLine);
          child!.stdout!.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("\n")) {
              clearTimeout(timer);
              resolveLine(output.trim());
            }
          });
        });
        expect(line).toBe(marker);
        if (child.exitCode === null && child.signalCode === null) {
          const ended = new Promise<void>((resolveExit) =>
            child!.once("exit", () => resolveExit()),
          );
          child.kill("SIGKILL");
          await ended;
        }
        child = undefined;
        await new Promise((wait) => setTimeout(wait, 500));
      };

      // (b) dosya yayınlandı, DB öncesi öldürüldü.
      const v1 = contentFor("kill-note", space.id, "Kill 1", "Kesinti b.");
      const e1 = await record("kill-b", v1);
      await spawnChild(e1.id, v1, "PUBLISHED");
      const pending = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", e1.id)
        .executeTakeFirstOrThrow();
      expect(pending.state).toBe("pending");
      const orphans = await revisionFileNames(env.root, space.id, "kill-note");
      expect(orphans).toHaveLength(1);
      const replayB = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      expect(replayB.status).toBe("committed");
      expect(replayB.revision).toBe(1);
      expect(await revisionFileNames(env.root, space.id, "kill-note")).toEqual(
        orphans,
      );

      // (c) DB commit edildi, indeks işareti öncesi öldürüldü.
      const v2 = contentFor("kill-note", space.id, "Kill 2", "Kesinti c.");
      const e2 = await record("kill-c", v2);
      await spawnChild(e2.id, v2, "COMMITTED", 1);
      const committed = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", e2.id)
        .executeTakeFirstOrThrow();
      expect(committed.state).toBe("committed");
      expect(committed.indexed_at).toBeNull();
      const replayC = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(replayC.status).toBe("duplicate");
      expect(replayC.revision).toBe(2);
      expect(replayC.indexed).toBe(true);
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", "kill-note")
          .execute(),
      ).toHaveLength(2);
      expect(
        await revisionFileNames(env.root, space.id, "kill-note"),
      ).toHaveLength(2);
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((wait) => setTimeout(wait, 100));
      }
      await env.cleanup();
    }
  }, 90000);

  test(`#35 bağımsız: tombstone/restore, içerik sınırı ve redaksiyon politikası (${backend})`, async () => {
    const { env, owner, service, space, commits, record } =
      await fixture(backend);
    try {
      const v1 = contentFor("tomb-note", space.id, "Tomb 1", "Yaşayan gövde.");
      const e1 = await record("tomb-e1", v1);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      await service.archiveNote(owner, {
        spaceId: space.id,
        noteId: "tomb-note",
      });
      const v2 = contentFor("tomb-note", space.id, "Tomb 2", "Yeni gövde.");
      const e2 = await record("tomb-e2", v2);
      const blocked = await rejection(() =>
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: e2.id,
          sourceKind: "manual",
          content: v2,
          baseRevision: 1,
        }),
      );
      expect(blocked.code).toBe("memory_note_deleted");
      expect(blocked.status).toBe(409);
      const againArchive = await rejection(() =>
        service.archiveNote(owner, {
          spaceId: space.id,
          noteId: "tomb-note",
        }),
      );
      expect(againArchive.code).toBe("memory_note_unavailable");
      await service.restoreNote(owner, {
        spaceId: space.id,
        noteId: "tomb-note",
      });
      const restored = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(restored.status).toBe("committed");
      expect(restored.revision).toBe(2);
      const againRestore = await rejection(() =>
        service.restoreNote(owner, {
          spaceId: space.id,
          noteId: "tomb-note",
        }),
      );
      expect(againRestore.code).toBe("memory_note_unavailable");

      // İçerik sınırı: aşım yazımdan önce reddedilir.
      const tooLarge = "x".repeat(MEMORY_CONTENT_MAX_BYTES + 1);
      const limit = await rejection(() =>
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: "missing-event",
          sourceKind: "manual",
          content: tooLarge,
        }),
      );
      expect(limit.code).toBe("memory_content_limit");
      expect(limit.status).toBe(422);

      // Güvenilmeyen kaynak redakte edilir; güvenilir kaynak sessizce
      // değiştirilmez.
      const secret =
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789";
      const untrusted = contentFor(
        "redact-note",
        space.id,
        "Redaksiyon",
        secret,
      );
      const eUntrusted = await record("redact-1", untrusted, "hook");
      const redacted = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: eUntrusted.id,
        sourceKind: "hook",
        content: untrusted,
      });
      expect(redacted.redacted).toBe(true);
      const stored = await readFile(
        resolveVaultRelative(vaultRoot(env.root), redacted.filePath),
        "utf8",
      );
      expect(stored).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(stored).toContain("[redacted]");
      const trustedUnsafe = contentFor(
        "trusted-note",
        space.id,
        "Güvenilir",
        secret,
      );
      const eTrusted = await record("redact-2", trustedUnsafe, "manual");
      const unsafe = await rejection(() =>
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: eTrusted.id,
          sourceKind: "manual",
          content: trustedUnsafe,
        }),
      );
      expect(unsafe.code).toBe("memory_unsafe_content");
      expect(unsafe.status).toBe(422);
    } finally {
      await env.cleanup();
    }
  }, 30000);
}

test.failing(
  "#35 bağımsız (bekleyen): receipt_json eksikken replay aynı alandaki başka notun revizyonunu seçmemeli",
  async () => {
    const { env, owner, space, commits, record } = await fixture("sqlite");
    try {
      const textFor = (noteId: string, body: string) =>
        contentFor(noteId, space.id, noteId, body);
      const commitNote = async (key: string, noteId: string, body: string) => {
        const text = textFor(noteId, body);
        const event = await record(key, text);
        return {
          event,
          receipt: await commits.commit({
            identity: owner,
            spaceId: space.id,
            eventId: event.id,
            sourceKind: "manual",
            content: text,
          }),
        };
      };
      await commitNote("receipt-a", "note-a", "A gövdesi");
      const b = await commitNote("receipt-b", "note-b", "B gövdesi");
      // Onarım/legacy durumu: committed olayın receipt'i yok.
      await env.storage.db
        .updateTable("memory_events")
        .set({ receipt_json: null })
        .where("id", "=", b.event.id)
        .execute();
      const replay = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: b.event.id,
        sourceKind: "manual",
        content: textFor("note-b", "B gövdesi"),
      });
      expect(replay.noteId).toBe("note-b");
      expect(replay.filePath).toBe(b.receipt.filePath);
    } finally {
      await env.cleanup();
    }
  },
  30000,
);

test.failing(
  "#35 bağımsız (bekleyen): çalışma kopyası yazıldıktan sonra DB öncesi kesinti replay'i hayalet working_copy_changed üretmemeli",
  async () => {
    const { env, owner, space, commits, record } = await fixture("sqlite");
    try {
      const v1 = contentFor("ghost-note", space.id, "Ghost 1", "Temel.");
      const e1 = await record("ghost-e1", v1);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      const v2 = contentFor("ghost-note", space.id, "Ghost 2", "Kesinti.");
      const e2 = await record("ghost-e2", v2);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      // Kesinti simülasyonu: rev2 dosyası ve çalışma kopyası diskte, DB rev1.
      await env.storage.db
        .deleteFrom("memory_note_revisions")
        .where("revision", "=", 2)
        .execute();
      await env.storage.db
        .updateTable("memory_notes")
        .set({ current_revision: 1 })
        .where("id", "=", "ghost-note")
        .execute();
      await env.storage.db
        .updateTable("memory_events")
        .set({
          state: "pending",
          committed_revision: null,
          receipt_json: null,
          indexed_at: null,
        })
        .where("id", "=", e2.id)
        .execute();
      const replay = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(replay.revision).toBe(2);
      const ghost = await env.storage.db
        .selectFrom("memory_change_candidates")
        .select(["id"])
        .where("reason", "=", "working_copy_changed")
        .execute();
      expect(ghost).toEqual([]);
    } finally {
      await env.cleanup();
    }
  },
  30000,
);
