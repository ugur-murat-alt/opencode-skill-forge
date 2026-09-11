import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryWriteService } from "../src/memory/writes.js";
import { MemoryContextService } from "../src/memory/context.js";
import { parseMemoryDocument } from "../src/domain/memory.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M03-B doğrulaması (c79e481): tipli yazma işlemleri, CAS, link,
 * checkpoint, bağlam derleyicisi ve bütçe. Gerçek SQLite + M02 commit hattı +
 * türetilmiş indeks; sahte katman yok.
 *
 * Entegrasyon turunda açılan uçlar kapatıldı ve normal regresyon testlerine
 * dönüştü: kayıpsız tipli patch, bağlam bütçesi, event_key idempotency'si ve
 * supersede yaşam döngüsü.
 */

interface Env {
  root: string;
  storage: DatabaseHandle;
  db: DatabaseHandle["db"];
  owner: Identity;
  service: MemoryService;
  commits: MemoryCommitService;
  index: MemoryIndexService;
  writes: MemoryWriteService;
  context: MemoryContextService;
  spaceId: string;
  close: () => Promise<void>;
}

async function openEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "forge-m03b-ind-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const vault = vaultRoot(root);
  const service = new MemoryService(storage.db, identities, vault);
  const index = new MemoryIndexService(storage.db, vault, service);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vault,
    service,
    index,
  });
  const writes = new MemoryWriteService({ db: storage.db, service, commits });
  const context = new MemoryContextService(storage.db, service);
  const space = await service.ensureSpace(owner, { type: "personal" });
  return {
    root,
    storage,
    db: storage.db,
    owner,
    service,
    commits,
    index,
    writes,
    context,
    spaceId: space.id,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createNote(
  env: Env,
  input: {
    kind?: string;
    title: string;
    body?: string;
    task_status?: string;
    pinned?: boolean;
    spaceId?: string;
  },
): Promise<{ noteId: string; revision: number }> {
  const result = await env.writes.update(env.owner, {
    space_id: input.spaceId ?? env.spaceId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "gövde",
    task_status: input.task_status,
    pinned: input.pinned,
  } as never);
  return {
    noteId: String(result.note_id),
    revision: Number(result.revision),
  };
}

async function recordOf(env: Env, noteId: string) {
  const current = await env.service.readNote(env.owner, {
    spaceId: env.spaceId,
    noteId,
  });
  if (!current.content) throw new Error("içerik yok");
  const parsed = parseMemoryDocument(current.content);
  if (parsed.status !== "ok") throw new Error(`parse: ${parsed.status}`);
  return { record: parsed.record, revision: current.note.current_revision! };
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
  throw new Error("red beklenirken çağrı başarılı oldu");
}

test("update: expected_revision CAS'i, çakışma ve event_key tekilliği", async () => {
  const env = await openEnv();
  try {
    const created = await createNote(env, { title: "CAS notu", kind: "note" });
    expect(created.revision).toBe(1);
    // Yanlış beklenen revizyon 409 ve hiçbir yeni revizyon yok.
    const stale = await rejection(() =>
      env.writes.update(env.owner, {
        space_id: env.spaceId,
        note_id: created.noteId,
        expected_revision: 0,
        body: "eski taban",
      } as never),
    );
    expect(stale.code).toBe("memory_revision_conflict");
    expect(stale.status).toBe(409);
    expect((await recordOf(env, created.noteId)).revision).toBe(1);
    // Doğru CAS revizyonu ilerletir.
    const patched = await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: created.noteId,
      expected_revision: 1,
      title: "CAS notu v2",
      body: "yeni gövde",
    } as never);
    expect(Number(patched.revision)).toBe(2);
    const after = await recordOf(env, created.noteId);
    expect(after.record.title).toBe("CAS notu v2");
    expect(after.record.body).toContain("yeni gövde");
    // Aynı event_key ikinci kez kullanılamaz.
    const withKey = await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: created.noteId,
      expected_revision: 2,
      body: "event key gövdesi",
      event_key: "sabit-anahtar",
    } as never);
    expect(Number(withKey.revision)).toBe(3);
    const duplicateEvent = await rejection(() =>
      env.writes.update(env.owner, {
        space_id: env.spaceId,
        note_id: created.noteId,
        expected_revision: 3,
        body: "tekrar",
        event_key: "sabit-anahtar",
      } as never),
    );
    expect(duplicateEvent.status).toBe(409);
  } finally {
    await env.close();
  }
}, 30000);

test("archive/restore: yaşam döngüsü ve silinmiş nota yazım reddi", async () => {
  const env = await openEnv();
  try {
    const { noteId } = await createNote(env, { title: "Arşiv notu" });
    const archived = await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      archive: true,
    } as never);
    expect(archived.status).toBe("archived");
    const afterArchive = await env.db
      .selectFrom("memory_notes")
      .select(["deleted_at", "lifecycle"])
      .where("space_id", "=", env.spaceId)
      .where("id", "=", noteId)
      .executeTakeFirstOrThrow();
    expect(afterArchive.deleted_at).not.toBeNull();
    expect(afterArchive.lifecycle).toBe("archived");
    // Arşivli nota patch reddedilir.
    const blocked = await rejection(() =>
      env.writes.update(env.owner, {
        space_id: env.spaceId,
        note_id: noteId,
        expected_revision: 1,
        body: "olmamalı",
      } as never),
    );
    expect(blocked.code).toBe("memory_note_unavailable");
    // İkinci arşiv 404.
    const again = await rejection(() =>
      env.writes.update(env.owner, {
        space_id: env.spaceId,
        note_id: noteId,
        archive: true,
      } as never),
    );
    expect(again.status).toBe(404);
    const restored = await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      restore: true,
    } as never);
    expect(restored.status).toBe("restored");
    const afterRestore = await env.db
      .selectFrom("memory_notes")
      .select(["deleted_at", "lifecycle"])
      .where("space_id", "=", env.spaceId)
      .where("id", "=", noteId)
      .executeTakeFirstOrThrow();
    expect(afterRestore.deleted_at).toBeNull();
    // Audit izleri yazıldı.
    const audit = await env.db
      .selectFrom("audit_events")
      .select(["kind", "detail"])
      .where("tenant_id", "=", env.owner.tenantId)
      .where("kind", "=", "memory.update.applied")
      .execute();
    const statuses = audit.map(
      (row) => (JSON.parse(row.detail) as { status: string }).status,
    );
    expect(statuses).toContain("archived");
    expect(statuses).toContain("restored");
  } finally {
    await env.close();
  }
}, 30000);

test("link: iki uç aynı alanda, CAS, ekle/kaldır ve negatifler", async () => {
  const env = await openEnv();
  try {
    const a = await createNote(env, { title: "Kaynak" });
    const b = await createNote(env, { title: "Hedef" });
    const otherSpace = await env.service.createOrganizationSpace(
      env.owner,
      "Yabancı alan",
    );
    const c = await createNote(env, {
      title: "Yabancı alan notu",
      spaceId: otherSpace.id,
    });
    // Çapraz alan hedefi reddedilir.
    const cross = await rejection(() =>
      env.writes.link(env.owner, {
        space_id: env.spaceId,
        note_id: a.noteId,
        relation: "SUPPORTS",
        target_note_id: c.noteId,
        expected_revision: 1,
      } as never),
    );
    expect(cross.code).toBe("memory_note_unavailable");
    // Kendine bağlanamaz.
    const self = await rejection(() =>
      env.writes.link(env.owner, {
        space_id: env.spaceId,
        note_id: a.noteId,
        relation: "SUPPORTS",
        target_note_id: a.noteId,
        expected_revision: 1,
      } as never),
    );
    expect(self.code).toBe("invalid_memory_link");
    // Ekleme yeni revizyon üretir ve kenar görünür.
    const added = await env.writes.link(env.owner, {
      space_id: env.spaceId,
      note_id: a.noteId,
      relation: "SUPPORTS",
      target_note_id: b.noteId,
      expected_revision: 1,
    } as never);
    expect(Number(added.revision)).toBe(2);
    const afterAdd = await recordOf(env, a.noteId);
    expect(afterAdd.record.edges).toContainEqual({
      relation: "SUPPORTS",
      target: b.noteId,
    });
    // Yanlış CAS ile kenar eklenemez.
    const stale = await rejection(() =>
      env.writes.link(env.owner, {
        space_id: env.spaceId,
        note_id: a.noteId,
        relation: "ABOUT",
        target_note_id: b.noteId,
        expected_revision: 1,
      } as never),
    );
    expect(stale.code).toBe("memory_revision_conflict");
    // Kaldırma yeni revizyon üretir, kenar gider.
    const removed = await env.writes.link(env.owner, {
      space_id: env.spaceId,
      note_id: a.noteId,
      relation: "SUPPORTS",
      target_note_id: b.noteId,
      expected_revision: 2,
      remove: true,
    } as never);
    expect(Number(removed.revision)).toBe(3);
    const afterRemove = await recordOf(env, a.noteId);
    expect(afterRemove.record.edges).toEqual([]);
  } finally {
    await env.close();
  }
}, 30000);

test("checkpoint: otomatik done yok, yalnız task günceller, açık done", async () => {
  const env = await openEnv();
  try {
    const first = await env.writes.checkpoint(env.owner, {
      space_id: env.spaceId,
      goal: "Kabul testini bitir",
      progress: "İlk adım",
      next_step: "İkinci adım",
    } as never);
    const noteId = String(first.note_id);
    expect(first.task_status).toBe("doing");
    let record = await recordOf(env, noteId);
    expect(record.record.kind).toBe("task");
    expect(record.record.taskStatus).toBe("doing");
    expect(record.record.body).toContain("## Hedef");
    expect(record.record.body).toContain("## İlerleme");
    expect(record.record.body).toContain("## Sonraki adım");
    // İlerleme güncellemesi done demek değildir.
    const progress = await env.writes.checkpoint(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      expected_revision: Number(first.revision),
      goal: "Kabul testini bitir",
      progress: "İkinci adım tamam",
    } as never);
    expect(progress.task_status).toBe("doing");
    record = await recordOf(env, noteId);
    expect(record.record.taskStatus).toBe("doing");
    expect(record.record.body).toContain("## Sonraki adım");
    // Engel varsayılanı blocked yapar.
    const blocked = await env.writes.checkpoint(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      expected_revision: Number(progress.revision),
      goal: "Kabul testini bitir",
      blocker: "Servis kapalı",
    } as never);
    expect(blocked.task_status).toBe("blocked");
    // Yalnız açık status done yapar.
    const done = await env.writes.checkpoint(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      expected_revision: Number(blocked.revision),
      goal: "Kabul testini bitir",
      status: "done",
    } as never);
    expect(done.task_status).toBe("done");
    record = await recordOf(env, noteId);
    expect(record.record.taskStatus).toBe("done");
    // Task olmayan not checkpoint ile güncellenemez.
    const notTask = await createNote(env, { kind: "note", title: "Not" });
    const invalid = await rejection(() =>
      env.writes.checkpoint(env.owner, {
        space_id: env.spaceId,
        note_id: notTask.noteId,
        expected_revision: 1,
        goal: "Olmaz",
      } as never),
    );
    expect(invalid.code).toBe("invalid_memory_checkpoint");
    // Yanlış CAS çakışır.
    const stale = await rejection(() =>
      env.writes.checkpoint(env.owner, {
        space_id: env.spaceId,
        note_id: noteId,
        expected_revision: 1,
        goal: "Eski",
      } as never),
    );
    expect(stale.code).toBe("memory_revision_conflict");
  } finally {
    await env.close();
  }
}, 30000);

test("context: kaynaklı kartlar, bölümler, known_revisions deltası ve süreklilik", async () => {
  const env = await openEnv();
  try {
    const task = await createNote(env, {
      kind: "task",
      title: "Açık görev",
      body: "Görev gövdesi",
      task_status: "doing",
    });
    const blockedTask = await createNote(env, {
      kind: "task",
      title: "Engelli görev",
      body: "Engel gövdesi",
      task_status: "blocked",
    });
    const decision = await createNote(env, {
      kind: "decision",
      title: "Son karar",
      body: "Karar gövdesi",
    });
    const pinned = await createNote(env, {
      kind: "note",
      title: "Pinli not",
      body: "Pin gövdesi",
      pinned: true,
    });
    const pkg = await env.context.context(env.owner, { maxTokens: 2048 });
    expect(pkg.envelope.token_estimator).toContain("estimate");
    expect(pkg.cards.length).toBeGreaterThanOrEqual(3);
    const card = pkg.cards.find((item) => item.note_id === task.noteId)!;
    expect(card.revision).toBe(1);
    expect(card.match_reason).toBe("active_task");
    expect(card.sources).toEqual([]);
    expect(pkg.sections.active_tasks).toContain(task.noteId);
    expect(pkg.sections.blockers).toEqual([blockedTask.noteId]);
    expect(pkg.sections.recent_decisions).toContain(decision.noteId);
    expect(pkg.sections.pins).toContain(pinned.noteId);
    expect([task.noteId, blockedTask.noteId]).toContain(
      pkg.sections.continuation,
    );
    expect(pkg.offered.map((item) => item.note_id)).toContain(task.noteId);
    // Bilinen revizyon delta üretir; yeni revizyon geri gelir.
    const delta = await env.context.context(env.owner, {
      maxTokens: 2048,
      knownRevisions: [{ note_id: task.noteId, revision: 1 }],
    });
    expect(delta.cards.some((item) => item.note_id === task.noteId)).toBe(
      false,
    );
    const bumped = await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: task.noteId,
      expected_revision: 1,
      body: "Görev gövdesi v2",
    } as never);
    const fresh = await env.context.context(env.owner, {
      maxTokens: 2048,
      knownRevisions: [{ note_id: task.noteId, revision: 1 }],
    });
    const bumpedCard = fresh.cards.find(
      (item) => item.note_id === task.noteId,
    )!;
    expect(bumpedCard.revision).toBe(Number(bumped.revision));
  } finally {
    await env.close();
  }
}, 60000);

test("patch kaynak izlerini, bilinmeyen frontmatter'ı ve geçerlilik penceresini korumalı", async () => {
  const env = await openEnv();
  try {
    const noteId = "lossy-note";
    const content = [
      "---",
      "format_version: 1",
      `note_id: ${JSON.stringify(noteId)}`,
      `memory_space_id: ${JSON.stringify(env.spaceId)}`,
      "kind: note",
      'title: "Kaynaklı not"',
      'summary: "özet"',
      'custom_field: "korunmalı"',
      `sources: [{"id":"agz-1","kind":"agz","hash":"${"a".repeat(64)}"}]`,
      "valid_from: 1000",
      "valid_until: 2000",
      "created_at: 500",
      "---",
      "",
      "ilk gövde",
      "",
    ].join("\n");
    const { sha256Hex } = await import("../src/memory/files.js");
    const event = await env.service.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "lossy-1",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    await env.commits.commit({
      identity: env.owner,
      spaceId: env.spaceId,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId,
    });
    await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: noteId,
      expected_revision: 1,
      body: "yeni gövde",
    } as never);
    const after = await recordOf(env, noteId);
    // Kaynak izleri ve kullanıcı alanları tipik düzenlemede kaybolmamalı.
    expect(after.record.sources).toHaveLength(1);
    expect(after.record.unknown.custom_field).toBe("korunmalı");
    expect(after.record.validFrom).toBe(1000);
    expect(after.record.validUntil).toBe(2000);
    expect(after.record.body).toContain("yeni gövde");
  } finally {
    await env.close();
  }
}, 60000);

test("aynı event_key + aynı içerik replay eder; farklı içerik 409 verir", async () => {
  const env = await openEnv();
  try {
    const noteId = "retry-note";
    const content = [
      "---",
      "format_version: 1",
      `note_id: ${JSON.stringify(noteId)}`,
      `memory_space_id: ${JSON.stringify(env.spaceId)}`,
      "kind: note",
      'title: "Retry notu"',
      "---",
      "",
      "ilk gövde",
      "",
    ].join("\n");
    const { sha256Hex } = await import("../src/memory/files.js");
    const contentHash = sha256Hex(content);
    const event = await env.service.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "retry-event",
      sourceKind: "manual",
      contentHash,
    });
    // Aynı anahtar + AYNI içerik idempotenttir: önceki olay/receipt replay edilir.
    const replay = await env.service.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "retry-event",
      sourceKind: "manual",
      contentHash,
    });
    expect(replay.status).toBe("duplicate");
    expect(replay.event.id).toBe(event.event.id);
    const first = await env.commits.commit({
      identity: env.owner,
      spaceId: env.spaceId,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
    });
    // Aynı event_key + FARKLI içerik sessiz kabul edilmez; çatışma 409.
    await expect(
      env.writes.update(env.owner, {
        space_id: env.spaceId,
        note_id: noteId,
        expected_revision: first.revision,
        body: "yeni gövde",
        event_key: "retry-event",
      } as never),
    ).rejects.toMatchObject({ code: "memory_event_conflict" });
  } finally {
    await env.close();
  }
}, 60000);

test("bağlam bütçesi bölümlerle aşılmamalı (used_tokens_estimate <= max_tokens)", async () => {
  const env = await openEnv();
  try {
    for (let index = 0; index < 25; index += 1)
      await createNote(env, {
        kind: "task",
        title: `Görev ${index}`,
        body: `Gövde ${index}`,
        task_status: "doing",
      });
    for (let index = 0; index < 5; index += 1)
      await createNote(env, {
        kind: "decision",
        title: `Karar ${index}`,
        body: `Karar gövdesi ${index}`,
      });
    const pkg = await env.context.context(env.owner, { maxTokens: 128 });
    expect(pkg.envelope.budget.used_tokens_estimate).toBeLessThanOrEqual(
      pkg.envelope.budget.max_tokens,
    );
  } finally {
    await env.close();
  }
}, 60000);

test("supersede çağrısı kaynağı superseded yapıp aynı anda ona SUPERSEDES kenarı vermemeli", async () => {
  const env = await openEnv();
  try {
    const old = await createNote(env, {
      kind: "decision",
      title: "Eski karar",
    });
    const next = await createNote(env, {
      kind: "decision",
      title: "Yeni karar",
    });
    await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: next.noteId,
      expected_revision: 1,
      supersede_target: old.noteId,
    } as never);
    const updated = await recordOf(env, next.noteId);
    const supersedesOld = updated.record.edges.some(
      (edge) => edge.relation === "SUPERSEDES" && edge.target === old.noteId,
    );
    // Çelişki: aynı not hem superseded hem de hedefi SUPERSEDES ediyor.
    expect(updated.record.lifecycle === "superseded" && supersedesOld).toBe(
      false,
    );
  } finally {
    await env.close();
  }
}, 60000);
