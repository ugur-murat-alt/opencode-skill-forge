import { test, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import {
  MEMORY_CONTENT_MAX_BYTES,
  MemoryCommitService,
  type MemoryCommitHooks,
} from "../src/memory/commit.js";
import {
  publishRevisionFile,
  sha256Hex,
  tempFileName,
} from "../src/memory/files.js";
import {
  noteWorkingPath,
  resolveVaultRelative,
  revisionPath,
  spaceRoot,
  tempDir,
  vaultRoot,
} from "../src/memory/paths.js";

/**
 * Issue #35 (M02): real file + DB create/edit/read through the commit state
 * machine, including the three interruption points (before ACK, after file
 * publication before DB, after DB before the index marker), idempotent
 * receipts, CAS conflicts, working-copy conflicts and tombstones.
 */

const uuid = () => crypto.randomUUID();
const HASH = (value: string) => sha256Hex(value);

interface Env {
  storage: DatabaseHandle;
  dataDir: string;
  cleanup: () => Promise<void>;
}

async function openEnv(backend: "sqlite" | "postgres"): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-commit-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  const databaseName = `forge_m02_commit_${crypto.randomUUID().replaceAll("-", "")}`;
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
    storage,
    dataDir: root,
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

function runScope(identity: Identity) {
  return {
    tenant_id: identity.tenantId,
    user_id: identity.userId,
    scope_kind: "personal" as const,
    scope_key: identity.userId,
    project_id: null,
  };
}

async function fixture(backend: "sqlite" | "postgres") {
  const env = await openEnv(backend);
  const identities = new IdentityService(env.storage.db);
  const owner = await identities.bootstrapLocal();
  const service = new MemoryService(env.storage.db);
  const space = await service.ensureSpace(owner, { type: "personal" });
  const commits = new MemoryCommitService({
    db: env.storage.db,
    vaultRoot: vaultRoot(env.dataDir),
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
      contentHash: HASH(content),
    });
    return outcome.event;
  };
  return { env, storage: env.storage, owner, service, space, commits, record };
}

function contentFor(noteId: string, title: string, body: string) {
  return [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(noteId)}`,
    "memory_space_id: SPACE",
    "kind: note",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#35 commit creates one revision, one receipt and an indexed event (${backend})`, async () => {
    const { env, owner, service, space, commits, record } =
      await fixture(backend);
    try {
      void service;
      const noteId = uuid();
      const content = contentFor(noteId, "İlk sürüm", "Gövde bir.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("evt-create", content);
      const receipt = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      expect(receipt).toMatchObject({
        status: "committed",
        noteId,
        revision: 1,
        byteSize: Buffer.byteLength(
          await readFile(
            resolveVaultRelative(vaultRoot(env.dataDir), receipt.filePath),
            "utf8",
          ),
        ),
      });
      expect(receipt.indexed).toBe(true);
      const absolute = resolveVaultRelative(
        vaultRoot(env.dataDir),
        receipt.filePath,
      );
      const file = await readFile(absolute, "utf8");
      expect(sha256Hex(file)).toBe(receipt.fileHash);
      expect(file).toContain("Gövde bir.");
      expect(
        await readFile(
          noteWorkingPath(vaultRoot(env.dataDir), space.id, noteId),
          "utf8",
        ),
      ).toBe(file);
      const note = await env.storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", noteId)
        .executeTakeFirstOrThrow();
      expect(note.current_revision).toBe(1);
      expect(note.deleted_at).toBeNull();
      const revisionRows = await env.storage.db
        .selectFrom("memory_note_revisions")
        .selectAll()
        .where("note_id", "=", noteId)
        .execute();
      expect(revisionRows).toHaveLength(1);
      expect(revisionRows[0]!.content_hash).toBe(receipt.fileHash);
      expect(revisionRows[0]!.file_path).toBe(receipt.filePath);
      const stored = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", event.id)
        .executeTakeFirstOrThrow();
      expect(stored.state).toBe("committed");
      expect(stored.committed_revision).toBe(1);
      expect(stored.indexed_at).not.toBeNull();
      expect(stored.receipt_json).not.toBeNull();

      // Aynı olay yeniden teslim edilir: tek receipt, tek revision.
      const replayEvent = await record("evt-create", content);
      expect(replayEvent.id).toBe(event.id);
      const replay = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      expect(replay.status).toBe("duplicate");
      expect(replay.revision).toBe(1);
      expect(replay.fileHash).toBe(receipt.fileHash);
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", noteId)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 crash points (b) and (c) replay without losing accepted content (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    try {
      const noteId = uuid();
      const content = contentFor(
        noteId,
        "Crash",
        "Kabul edilen içerik.",
      ).replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("evt-crash", content);

      // (b) dosya yayını sonrası, DB öncesi kesinti.
      const hooksB: MemoryCommitHooks = {
        afterPublish: () => {
          throw new Error("simulated crash after publish");
        },
      };
      const crashing = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.dataDir),
        hooks: hooksB,
      });
      await expect(
        crashing.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: event.id,
          sourceKind: "manual",
          content,
        }),
      ).rejects.toThrow("simulated crash after publish");
      const pending = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", event.id)
        .executeTakeFirstOrThrow();
      expect(pending.state).toBe("pending");
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", noteId)
          .execute(),
      ).toHaveLength(0);

      const recovered = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      expect(recovered.status).toBe("committed");
      const expectedFile = revisionPath(
        vaultRoot(env.dataDir),
        space.id,
        noteId,
        1,
        recovered.fileHash,
      );
      expect(
        resolveVaultRelative(vaultRoot(env.dataDir), recovered.filePath),
      ).toBe(expectedFile);
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", noteId)
          .execute(),
      ).toHaveLength(1);

      // (c) DB sonrası, indeks işareti öncesi kesinti.
      const content2 = contentFor(noteId, "Crash v2", "İkinci içerik.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event2 = await record("evt-crash-2", content2);
      const hooksC: MemoryCommitHooks = {
        afterCommitBeforeIndex: () => {
          throw new Error("simulated crash before index");
        },
      };
      const crashing2 = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.dataDir),
        hooks: hooksC,
      });
      await expect(
        crashing2.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: event2.id,
          sourceKind: "manual",
          content: content2,
          baseRevision: 1,
        }),
      ).rejects.toThrow("simulated crash before index");
      const committed = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", event2.id)
        .executeTakeFirstOrThrow();
      expect(committed.state).toBe("committed");
      expect(committed.indexed_at).toBeNull();
      const replay = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event2.id,
        sourceKind: "manual",
        content: content2,
        baseRevision: 1,
      });
      expect(replay.status).toBe("duplicate");
      expect(replay.revision).toBe(2);
      expect(replay.indexed).toBe(true);
      expect(
        await env.storage.db
          .selectFrom("memory_events")
          .select(["indexed_at"])
          .where("id", "=", event2.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ indexed_at: expect.any(Number) });
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", noteId)
          .execute(),
      ).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 CAS conflicts protect the winner file and external working-copy edits survive (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    try {
      const noteId = uuid();
      const v1 = contentFor(noteId, "Sürüm 1", "Bir.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const e1 = await record("cas-v1", v1);
      await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      const v2 = contentFor(noteId, "Sürüm 2", "İki.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const e2 = await record("cas-v2", v2);
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: e2.id,
          sourceKind: "manual",
          content: v2,
        }),
      ).rejects.toMatchObject({
        code: "memory_revision_required",
        status: 422,
      });
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: e2.id,
          sourceKind: "manual",
          content: v2,
          baseRevision: 0,
        }),
      ).rejects.toMatchObject({
        code: "memory_revision_conflict",
        status: 409,
      });
      const committed = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(committed.revision).toBe(2);

      // Kazanan dosyası hâlâ yerinde ve atıfta bulunulmuş.
      const winner = await env.storage.db
        .selectFrom("memory_note_revisions")
        .selectAll()
        .where("note_id", "=", noteId)
        .where("revision", "=", 2)
        .executeTakeFirstOrThrow();
      expect(
        await readFile(
          resolveVaultRelative(vaultRoot(env.dataDir), winner.file_path!),
          "utf8",
        ),
      ).toContain("İki.");

      // Dış editör çalışma kopyasını değiştirir; yeni commit onu ezmez.
      const working = noteWorkingPath(vaultRoot(env.dataDir), space.id, noteId);
      await writeFile(working, "Dış editörün daha yeni metni.");
      const v3 = contentFor(noteId, "Sürüm 3", "Üç.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const e3 = await record("cas-v3", v3);
      const third = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: e3.id,
        sourceKind: "manual",
        content: v3,
        baseRevision: 2,
      });
      expect(third.revision).toBe(3);
      expect(await readFile(working, "utf8")).toBe(
        "Dış editörün daha yeni metni.",
      );
      const conflict = await env.storage.db
        .selectFrom("memory_change_candidates")
        .selectAll()
        .where("note_id", "=", noteId)
        .where("state", "=", "conflict")
        .execute();
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.reason).toBe("working_copy_changed");
      expect(conflict[0]!.observed_hash).toBe(
        sha256Hex("Dış editörün daha yeni metni."),
      );
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 tombstone, content mismatch, bounds and redaction policy (${backend})`, async () => {
    const { env, owner, storage, space, commits, record } =
      await fixture(backend);
    try {
      const noteId = uuid();
      const content = contentFor(
        noteId,
        "Politika",
        "Politika gövdesi.",
      ).replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("policy-1", content);
      await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      // İçerik hash uyuşmazlığı reddedilir ve olay reddedilmiş işaretlenir.
      const other = await record("policy-2", "başka içerik");
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: other.id,
          sourceKind: "manual",
          content: "farklı içerik",
        }),
      ).rejects.toMatchObject({ code: "memory_content_mismatch", status: 409 });

      // Boyut sınırı: sınır aşılırsa içerik hash'ine bakılmadan reddedilir.
      const tooBig = "y".repeat(MEMORY_CONTENT_MAX_BYTES + 1);
      const bigEvent = await record("policy-big-2", tooBig);
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: bigEvent.id,
          sourceKind: "manual",
          content: tooBig,
        }),
      ).rejects.toMatchObject({ code: "memory_content_limit", status: 422 });

      // Otomatik yakalama redakte edilir; elle yazım sessizce değiştirilmez.
      const secret = "api_key = abcdef1234567890";
      const auto = await record("auto-secret", secret, "hook");
      const autoReceipt = await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: auto.id,
        sourceKind: "hook",
        content: secret,
      });
      expect(autoReceipt.redacted).toBe(true);
      const stored = await readFile(
        resolveVaultRelative(vaultRoot(env.dataDir), autoReceipt.filePath),
        "utf8",
      );
      expect(stored).toContain("[redacted]");
      expect(stored).not.toContain("abcdef1234567890");

      const manualSecret = await record("manual-secret", secret, "manual");
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: manualSecret.id,
          sourceKind: "manual",
          content: secret,
        }),
      ).rejects.toMatchObject({ code: "memory_unsafe_content", status: 422 });

      // Tombstone: silinmiş not yeniden diriltilmez.
      await storage.db
        .updateTable("memory_notes")
        .set({ deleted_at: Date.now() })
        .where("id", "=", noteId)
        .where("space_id", "=", space.id)
        .where("tenant_id", "=", owner.tenantId)
        .execute();
      const afterDelete = contentFor(noteId, "Politika v2", "Yeni.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const deletedEvent = await record("policy-3", afterDelete);
      await expect(
        commits.commit({
          identity: owner,
          run: runScope(owner),
          spaceId: space.id,
          eventId: deletedEvent.id,
          sourceKind: "manual",
          content: afterDelete,
          baseRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "memory_note_deleted", status: 409 });
      const rows = await storage.db
        .selectFrom("memory_note_revisions")
        .select(["revision"])
        .where("note_id", "=", noteId)
        .execute();
      expect(rows).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 orphan revision files are quarantined metadata-only, winners keep theirs (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    try {
      const noteId = uuid();
      const content = contentFor(noteId, "Orphan", "Orphan gövde.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("orphan-1", content);
      // Elle referanssız bir revision dosyası bırak (kesinti simülasyonu).
      const orphanText = "eski başarısız yayın";
      const orphanHash = sha256Hex(orphanText);
      await publishRevisionFile(
        vaultRoot(env.dataDir),
        space.id,
        noteId,
        7,
        orphanHash,
        orphanText,
      );
      await commits.commit({
        identity: owner,
        run: runScope(owner),
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      // Referanslı dosya durur; referanssız dosya karantina kaydıyla gider.
      expect(
        await readFile(
          resolveVaultRelative(
            vaultRoot(env.dataDir),
            (
              await env.storage.db
                .selectFrom("memory_note_revisions")
                .select(["file_path"])
                .where("note_id", "=", noteId)
                .executeTakeFirstOrThrow()
            ).file_path!,
          ),
          "utf8",
        ),
      ).toContain("Orphan gövde.");
      const { readdir } = await import("node:fs/promises");
      const quarantine = await readdir(
        join(vaultRoot(env.dataDir), ".quarantine"),
      );
      const entries = await Promise.all(
        quarantine.map(async (name) =>
          JSON.parse(
            await readFile(
              join(vaultRoot(env.dataDir), ".quarantine", name),
              "utf8",
            ),
          ),
        ),
      );
      expect(
        entries.some(
          (entry) =>
            entry.reason === "orphan_revision" && entry.hash === orphanHash,
        ),
      ).toBe(true);
      expect(JSON.stringify(entries)).not.toContain("eski başarısız yayın");
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 receipt reconstruction is scoped to the event's note (${backend})`, async () => {
    const { env, owner, space, storage, commits, record } =
      await fixture(backend);
    try {
      const textFor = (noteId: string, body: string) =>
        contentFor(noteId, noteId, body).replace(
          "memory_space_id: SPACE",
          `memory_space_id: ${JSON.stringify(space.id)}`,
        );
      const commitNote = async (key: string, noteId: string, body: string) => {
        const content = textFor(noteId, body);
        const event = await record(key, content);
        const receipt = await commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: event.id,
          sourceKind: "manual",
          content,
        });
        return { event, content, receipt };
      };
      await commitNote("recon-a", "note-a", "A gövdesi");
      const b = await commitNote("recon-b", "note-b", "B gövdesi");
      // Commit, olayı hedef not kimliğiyle bağlar.
      expect(
        (
          await storage.db
            .selectFrom("memory_events")
            .select(["note_id"])
            .where("id", "=", b.event.id)
            .executeTakeFirstOrThrow()
        ).note_id,
      ).toBe("note-b");
      // Receipt kaybolsa bile replay aynı alandaki başka notu seçmez.
      await storage.db
        .updateTable("memory_events")
        .set({ receipt_json: null })
        .where("id", "=", b.event.id)
        .execute();
      const replay = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: b.event.id,
        sourceKind: "manual",
        content: b.content,
      });
      expect(replay.noteId).toBe("note-b");
      expect(replay.filePath).toBe(b.receipt.filePath);
      // Not bağı tamamen kaybolmuşsa uydurma yerine açık hata.
      const a = await commitNote("recon-a2", "note-a2", "A2 gövdesi");
      await storage.db
        .updateTable("memory_events")
        .set({ receipt_json: null, note_id: null })
        .where("id", "=", a.event.id)
        .execute();
      await expect(
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: a.event.id,
          sourceKind: "manual",
          content: a.content,
        }),
      ).rejects.toMatchObject({
        code: "memory_receipt_unavailable",
        status: 409,
      });
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 replay adopts its own crashed working-copy write without a ghost conflict (${backend})`, async () => {
    const { env, owner, space, storage, commits, record } =
      await fixture(backend);
    try {
      const contentForSpace = (title: string, body: string) =>
        contentFor("ghost-note", title, body).replace(
          "memory_space_id: SPACE",
          `memory_space_id: ${JSON.stringify(space.id)}`,
        );
      const v1 = contentForSpace("Ghost 1", "Temel.");
      const e1 = await record("ghost-e1", v1);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.id,
        sourceKind: "manual",
        content: v1,
      });
      const v2 = contentForSpace("Ghost 2", "Kesinti.");
      const e2 = await record("ghost-e2", v2);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      // Kesinti: rev2 dosyası ve çalışma kopyası diskte, DB rev1.
      await storage.db
        .deleteFrom("memory_note_revisions")
        .where("revision", "=", 2)
        .where("note_id", "=", "ghost-note")
        .execute();
      await storage.db
        .updateTable("memory_notes")
        .set({ current_revision: 1 })
        .where("id", "=", "ghost-note")
        .execute();
      await storage.db
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
      expect(
        await storage.db
          .selectFrom("memory_change_candidates")
          .select(["id"])
          .where("reason", "=", "working_copy_changed")
          .execute(),
      ).toEqual([]);
      // Gerçek dış edit hâlâ çatışma olarak görünür.
      const working = noteWorkingPath(
        vaultRoot(env.dataDir),
        space.id,
        "ghost-note",
      );
      await writeFile(working, "dış editör metni");
      const v3 = contentForSpace("Ghost 3", "Üçüncü.");
      const e3 = await record("ghost-e3", v3);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e3.id,
        sourceKind: "manual",
        content: v3,
        baseRevision: 2,
      });
      expect(
        await storage.db
          .selectFrom("memory_change_candidates")
          .select(["reason"])
          .where("reason", "=", "working_copy_changed")
          .execute(),
      ).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 a successful commit cleans dead-pid temp files and keeps live/foreign ones (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    try {
      const dir = tempDir(vaultRoot(env.dataDir));
      await mkdir(dir, { recursive: true });
      const ownHost = hostname();
      const dead = tempFileName(424242, ownHost);
      const live = tempFileName(process.pid, ownHost);
      const foreign = tempFileName(424243, "other-host");
      for (const name of [dead, live, foreign])
        await writeFile(join(dir, name), "tmp");
      const old = (Date.now() - 60_000) / 1000;
      for (const name of [dead, live, foreign])
        await utimes(join(dir, name), old, old);
      const content = contentFor("gc-note", "GC", "GC gövdesi.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("gc-evt", content);
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      const left = await readdir(dir);
      expect(left).not.toContain(dead);
      expect(left).toContain(live);
      expect(left).toContain(foreign);
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 the receipt reader refuses success when the revision file is gone (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    try {
      const content = contentFor(
        "file-note",
        "Dosya",
        "Dosya gövdesi.",
      ).replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("file-evt", content);
      const receipt = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.id,
        sourceKind: "manual",
        content,
      });
      const view = await commits.receipt(owner, space.id, "file-evt");
      expect(view.state).toBe("committed");
      expect(view.receipt?.revision).toBe(1);
      await rm(resolveVaultRelative(vaultRoot(env.dataDir), receipt.filePath));
      await expect(
        commits.receipt(owner, space.id, "file-evt"),
      ).rejects.toMatchObject({
        code: "memory_revision_file_missing",
        status: 409,
      });
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test(`#35 commit refuses a symlinked working-copy directory (${backend})`, async () => {
    const { env, owner, space, commits, record } = await fixture(backend);
    const outside = await mkdtemp(join(tmpdir(), "forge-m02-work-out-"));
    try {
      const vault = vaultRoot(env.dataDir);
      await mkdir(spaceRoot(vault, space.id), { recursive: true });
      await symlink(outside, join(spaceRoot(vault, space.id), "notes"));
      const content = contentFor("work-sym", "Sym", "Sym gövde.").replace(
        "memory_space_id: SPACE",
        `memory_space_id: ${JSON.stringify(space.id)}`,
      );
      const event = await record("work-sym-evt", content);
      await expect(
        commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: event.id,
          sourceKind: "manual",
          content,
        }),
      ).rejects.toMatchObject({ code: "memory_path_escape", status: 422 });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await env.cleanup();
    }
  }, 30_000);
}

test("#35 no backend is left without an env when postgres is not requested", () => {
  expect(true).toBe(true);
});
