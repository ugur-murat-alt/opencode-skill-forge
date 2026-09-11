import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import {
  clearMemorySnapshot,
  emptyMemorySnapshot,
  memoryDraftIdentity,
  memoryScopeKey,
  noteIdOfDraftKey,
  pendingCount,
  pendingForNote,
  readMemorySnapshot,
  unpublishedWork,
  writeMemorySnapshot,
  type MemoryDraft,
  type MemoryPendingSave,
} from "../web/src/memory/drafts.js";
import {
  applyNoteEdits,
  buildMemoryDocument,
  readFrontmatterField,
  splitMemoryDocument,
} from "../web/src/memory/document.js";

/**
 * Bağımsız M04-A doğrulaması (ee6b6c0, 61c7a52, d0daee3).
 *
 * Bölüm 1: taslak kapsam anahtarı (tenant+space+note+base), yayımlanmamış iş
 * sayımı ve belge düzenlemenin kayıpsızlığı — tarayıcı gerektirmeyen saf
 * modüller.
 * Bölüm 2: gerçek HTTP uçları — salt-okunur sürüm geçmişi, kiracı izolasyonu,
 * 409 çakışma + yeniden tabanlama sözleşmesi, açık alan oluşturma + audit.
 */

function draft(noteId: string, baseRevision: number | null): MemoryDraft {
  return {
    noteId,
    title: "taslak başlık",
    summary: "taslak özet",
    body: "taslak gövde",
    kind: "note",
    baseRevision,
    server: {
      title: "sunucu başlık",
      summary: "sunucu özet",
      body: "sunucu gövde",
      kind: "note",
      revision: baseRevision,
    },
    updatedAt: 7,
  };
}

function pending(
  eventKey: string,
  noteId: string,
  status: MemoryPendingSave["status"],
): MemoryPendingSave {
  return {
    eventKey,
    runId: `run-${eventKey}`,
    noteId,
    baseRevision: 1,
    submitted: { title: "t", summary: "s", body: "b", document: "d" },
    status,
    indexed: false,
    errorCode: null,
    committedRevision: null,
    updatedAt: 3,
  };
}

describe("M04 taslak istemcisi (saf)", () => {
  test("taslak kimliği tenant+space+note+base bileşenlerini ayırır", () => {
    const base = memoryDraftIdentity("tenant-1", "space-1", "note-1", 2);
    expect(base).toBe(memoryDraftIdentity("tenant-1", "space-1", "note-1", 2));
    expect(base).not.toBe(
      memoryDraftIdentity("tenant-2", "space-1", "note-1", 2),
    );
    expect(base).not.toBe(
      memoryDraftIdentity("tenant-1", "space-2", "note-1", 2),
    );
    expect(base).not.toBe(
      memoryDraftIdentity("tenant-1", "space-1", "note-2", 2),
    );
    expect(base).not.toBe(
      memoryDraftIdentity("tenant-1", "space-1", "note-1", 3),
    );
    const fresh = memoryDraftIdentity("tenant-1", "space-1", "note-1", null);
    expect(fresh).toContain("\u0000new");
    expect(noteIdOfDraftKey(base)).toBe("note-1");
    expect(memoryScopeKey("t", "s")).not.toBe(memoryScopeKey("t", "s2"));
  });

  test("anlık görüntü kopya döner ve yayımlanmamış iş doğru sayılır", () => {
    const key = `scope-${crypto.randomUUID()}`;
    clearMemorySnapshot(key);
    expect(readMemorySnapshot(key)).toBeNull();
    const snapshot = emptyMemorySnapshot();
    snapshot.drafts["k1"] = draft("note-1", 1);
    snapshot.pending["p1"] = pending("e1", "note-1", "queued");
    writeMemorySnapshot(key, snapshot);
    const loaded = readMemorySnapshot(key)!;
    expect(loaded).not.toBeNull();
    expect(unpublishedWork(loaded)).toBe(true);
    expect(pendingCount(loaded)).toBe(1);
    expect(pendingForNote(loaded, "note-1")).toHaveLength(1);
    // Kopya üzerinde değişiklik depoyu etkilemez.
    loaded.drafts["k1"]!.title = "kurcalandı";
    loaded.pending["p1"]!.status = "committed";
    expect(readMemorySnapshot(key)!.drafts["k1"]!.title).toBe("taslak başlık");
    expect(unpublishedWork(readMemorySnapshot(key)!)).toBe(true);
    // Yalnız committed bekleyen varsa yayımlanmamış iş kalmaz.
    const clean = emptyMemorySnapshot();
    clean.pending["p2"] = pending("e2", "note-2", "committed");
    expect(unpublishedWork(clean)).toBe(false);
    expect(pendingCount(clean)).toBe(0);
    // Temizlik: boş anlık görüntü kaydı silinir.
    writeMemorySnapshot(key, emptyMemorySnapshot());
    expect(readMemorySnapshot(key)).toBeNull();
    clearMemorySnapshot(key);
  });

  test("belge düzenleme bilinmeyen frontmatter ve edge'leri kayıpsız korur", () => {
    const noteId = "m04-note";
    const spaceId = "m04-space";
    const withExtras = [
      "---",
      "format_version: 1",
      `note_id: ${JSON.stringify(noteId)}`,
      `memory_space_id: ${JSON.stringify(spaceId)}`,
      "kind: decision",
      'title: "İlk"',
      'summary: "özet"',
      'custom_field: "korunmalı"',
      'sources: [{"id":"src-1","hash":"a"}]',
      'edges: [{"relation":"SUPPORTS","target":"note-2"}]',
      "---",
      "",
      "ilk gövde",
      "",
    ].join("\n");
    const edits = applyNoteEdits(withExtras, {
      title: "Yeni başlık",
      summary: "yeni özet",
      kind: "fact",
      body: "yeni gövde",
    });
    expect(edits.frontmatter).not.toBeNull();
    expect(edits.document).toContain('custom_field: "korunmalı"');
    expect(edits.document).toContain('sources: [{"id":"src-1","hash":"a"}]');
    expect(edits.document).toContain(
      'edges: [{"relation":"SUPPORTS","target":"note-2"}]',
    );
    expect(readFrontmatterField(edits.frontmatter!, "title")).toBe(
      "Yeni başlık",
    );
    expect(readFrontmatterField(edits.frontmatter!, "kind")).toBe("fact");
    expect(edits.document).toContain("yeni gövde");
    expect(edits.document).not.toContain("ilk gövde");
    // Bölme/toplama turu anlamı korur.
    const split = splitMemoryDocument(edits.document);
    expect(split.frontmatter).toContain("custom_field");
    expect(split.body.trimEnd()).toBe("yeni gövde");
    const rebuilt = buildMemoryDocument(split.frontmatter, split.body);
    expect(splitMemoryDocument(rebuilt).body.trimEnd()).toBe("yeni gövde");
  });
});

async function bootMemoryServer() {
  const root = await mkdtemp(join(tmpdir(), "forge-m04-ind-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  await app.listen({ host: config.host, port: config.port });
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const headers = {
    host: new URL(config.url).host,
    authorization: `Bearer ${config.token}`,
  };
  const http = async (path: string, init: RequestInit = {}) =>
    fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return {
    root,
    config,
    app,
    storage,
    identities,
    owner,
    headers,
    http,
    close: async () => {
      await app.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function sessionHeaders(
  config: { url: string },
  token: string,
  tenantId: string,
) {
  return {
    host: new URL(config.url).host,
    cookie: `forge_session=${token}; forge_tenant=${tenantId}`,
    "x-forge-tenant": tenantId,
    "x-forge-csrf": createHash("sha256").update(token).digest("hex"),
  } as Record<string, string>;
}

describe("M04 HTTP uçları (gerçek sunucu)", () => {
  test("sürüm geçmişi salt okunur, kiracı izole, 409 çakışma yeniden tabanlanır", async () => {
    const env = await bootMemoryServer();
    try {
      const created = await env.http("/api/memory/update", {
        method: "POST",
        body: JSON.stringify({
          kind: "decision",
          title: "UI notu",
          body: "ilk sürüm",
          space_id: "",
        }),
      });
      // space_id zorunlu: önce kişisel alanı aç.
      expect(created.status).toBe(400);
      const spaceResponse = await env.http("/api/memory/spaces", {
        method: "POST",
        body: JSON.stringify({ kind: "personal" }),
      });
      expect(spaceResponse.status).toBe(200);
      const space = (await spaceResponse.json()) as { id: string };
      const first = await env.http("/api/memory/update", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          kind: "decision",
          title: "UI notu",
          body: "ilk sürüm",
        }),
      });
      expect(first.status).toBe(200);
      const firstPayload = (await first.json()) as {
        note_id: string;
        revision: number;
      };
      const noteId = firstPayload.note_id;
      // Salt-okunur sayaçlar.
      const counts = async () => {
        const [runs, events, audit] = await Promise.all([
          env.storage.db
            .selectFrom("runs")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .executeTakeFirstOrThrow(),
          env.storage.db
            .selectFrom("memory_events")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .executeTakeFirstOrThrow(),
          env.storage.db
            .selectFrom("audit_events")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .executeTakeFirstOrThrow(),
        ]);
        return [Number(runs.n), Number(events.n), Number(audit.n)];
      };
      const before = await counts();
      const list = await env.http(
        `/api/memory/notes/${noteId}/revisions?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(list.status).toBe(200);
      const listPayload = (await list.json()) as {
        items: { revision: number; content_hash: string }[];
      };
      expect(listPayload.items.map((item) => item.revision)).toEqual([1]);
      const detail = await env.http(
        `/api/memory/notes/${noteId}/revisions/1?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(detail.status).toBe(200);
      const detailPayload = (await detail.json()) as {
        revision: { revision: number };
        content: string;
      };
      expect(detailPayload.revision.revision).toBe(1);
      expect(detailPayload.content).toContain("ilk sürüm");
      const missing = await env.http(
        `/api/memory/notes/${noteId}/revisions/9?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(missing.status).toBe(404);
      expect(await counts()).toEqual(before);

      // İkinci kiracı oturumu sürümleri göremez.
      await env.storage.db
        .insertInto("tenants")
        .values({ id: "m04-tenant-b", name: "B", created_at: Date.now() })
        .execute();
      await env.storage.db
        .insertInto("users")
        .values({
          id: "m04-user-b",
          subject: "m04-user-b",
          display_name: "B",
          created_at: Date.now(),
        })
        .execute();
      await env.storage.db
        .insertInto("memberships")
        .values({
          tenant_id: "m04-tenant-b",
          user_id: "m04-user-b",
          role: "founder",
        })
        .execute();
      const tokenB = await env.identities.issueSession(
        "m04-user-b",
        "session",
        3600_000,
      );
      const bHeaders = await sessionHeaders(env.config, tokenB, "m04-tenant-b");
      const foreignList = await fetch(
        `${env.config.url}/api/memory/notes/${noteId}/revisions?space_id=${encodeURIComponent(space.id)}`,
        { headers: bHeaders },
      );
      expect(foreignList.status).toBe(404);
      const foreignDetail = await fetch(
        `${env.config.url}/api/memory/notes/${noteId}/revisions/1?space_id=${encodeURIComponent(space.id)}`,
        { headers: bHeaders },
      );
      expect(foreignDetail.status).toBe(404);

      // UI akışı: eski revision ile yaz → 409; güncel revision ile yeniden tabanla.
      const stale = await env.http("/api/memory/update", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          note_id: noteId,
          expected_revision: 99,
          body: "çakışan sürüm",
        }),
      });
      expect(stale.status).toBe(409);
      const stalePayload = (await stale.json()) as {
        error: { code: string };
      };
      expect(stalePayload.error.code).toBe("memory_revision_conflict");
      const current = await env.http(
        `/api/memory/notes/${noteId}?space_id=${encodeURIComponent(space.id)}`,
      );
      const currentPayload = (await current.json()) as {
        revision: { revision: number };
      };
      const rebased = await env.http("/api/memory/update", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          note_id: noteId,
          expected_revision: currentPayload.revision.revision,
          body: "yeniden tabanlanmış gövde",
        }),
      });
      expect(rebased.status).toBe(200);
      const rebasedPayload = (await rebased.json()) as { revision: number };
      expect(rebasedPayload.revision).toBe(2);
      const audit = await env.storage.db
        .selectFrom("audit_events")
        .select(["kind"])
        .where("kind", "=", "memory.update.applied")
        .execute();
      expect(audit.length).toBeGreaterThanOrEqual(2);
    } finally {
      await env.close();
    }
  }, 90000);

  test("açık alan oluşturma audit taşır; eksik ad 422", async () => {
    const env = await bootMemoryServer();
    try {
      const organization = await env.http("/api/memory/spaces", {
        method: "POST",
        body: JSON.stringify({ kind: "organization", name: "M04 Ortak" }),
      });
      expect(organization.status).toBe(200);
      const organizationPayload = (await organization.json()) as {
        kind: string;
        name: string;
      };
      expect(organizationPayload.kind).toBe("organization");
      expect(organizationPayload.name).toBe("M04 Ortak");
      const missingName = await env.http("/api/memory/spaces", {
        method: "POST",
        body: JSON.stringify({ kind: "organization" }),
      });
      expect(missingName.status).toBe(422);
      const audit = await env.storage.db
        .selectFrom("audit_events")
        .select(["detail"])
        .where("kind", "=", "memory.space.ensured")
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.detail)).toMatchObject({
        kind: "organization",
        name: "M04 Ortak",
      });
    } finally {
      await env.close();
    }
  }, 60000);
});
