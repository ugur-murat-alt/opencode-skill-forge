import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";

/**
 * Issue #37 (M04) phase A: additive read-only UI endpoints. Space bootstrap
 * (personal/project/organization), immutable revision history and the
 * note-scoped candidate filter are exercised against the real HTTP server.
 */

const HOST = (config: { url: string }) => new URL(config.url).host;

async function request(
  base: string,
  config: { url: string; token: string },
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: HOST(config),
      authorization: `Bearer ${config.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function until<T>(
  check: () => Promise<T | null>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("receipt did not become durable in time");
}

function noteContent(spaceId: string, noteId: string, body: string) {
  return [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(noteId)}`,
    `memory_space_id: ${JSON.stringify(spaceId)}`,
    "kind: note",
    'title: "UI notu"',
    "---",
    "",
    body,
    "",
  ].join("\n");
}

test("#37 HTTP: space bootstrap and immutable revision history", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-ui-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const memory = new MemoryService(storage.db, identities, vaultRoot(root));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    const base = `http://127.0.0.1:${address.port}`;

    // Yetkisiz istek yeni uçlarda da reddedilir.
    const anonymous = await fetch(`${base}/api/memory/notes/x/revisions`, {
      headers: { host: HOST(config) },
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(401);

    // Kişisel alan ilk çağrıda açılır, sonraki çağrı aynı kimliği verir.
    const personalResponse = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "personal" }),
    });
    expect(personalResponse.status).toBe(200);
    const personal = (await personalResponse.json()) as {
      id: string;
      kind: string;
      name: string;
    };
    expect(personal.kind).toBe("personal");
    const personalAgain = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "personal" }),
    });
    expect(((await personalAgain.json()) as { id: string }).id).toBe(
      personal.id,
    );

    // Organizasyon alanı adla açıkça oluşturulur; ad kimlik değildir.
    const orgOne = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "organization", name: "Ortak alan" }),
    });
    expect(orgOne.status).toBe(200);
    const orgSpace = (await orgOne.json()) as { id: string; kind: string };
    expect(orgSpace.kind).toBe("organization");
    const orgTwo = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "organization", name: "Ortak alan" }),
    });
    expect(((await orgTwo.json()) as { id: string }).id).not.toBe(orgSpace.id);

    // Proje alanı gerçek project_id ister.
    const missingProject = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "project" }),
    });
    expect(missingProject.status).toBe(422);
    expect(
      ((await missingProject.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_memory_space");
    const project = (await (
      await request(base, config, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "UI projesi" }),
      })
    ).json()) as { id: string };
    const projectSpace = await request(base, config, "/api/memory/spaces", {
      method: "POST",
      body: JSON.stringify({ kind: "project", project_id: project.id }),
    });
    expect(projectSpace.status).toBe(200);
    expect(
      ((await projectSpace.json()) as { project_id: string }).project_id,
    ).toBe(project.id);

    // Alan listesinde üç tür de görünür.
    const spaces = (await (
      await request(base, config, "/api/memory/spaces")
    ).json()) as { items: { id: string; kind: string }[] };
    expect(new Set(spaces.items.map((row) => row.kind))).toEqual(
      new Set(["personal", "project", "organization"]),
    );

    // Audit: alan açma mutasyonları kayda geçer.
    const audit = await storage.db
      .selectFrom("audit_events")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "=", "memory.space.ensured")
      .executeTakeFirstOrThrow();
    expect(Number(audit.n)).toBeGreaterThanOrEqual(4);

    // İki revision commit edilir; ikincisi base_revision ile ilerler.
    const firstBody = "Birinci gövde.";
    const ingest = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: personal.id,
        source_event_key: "ui-evt-1",
        source_kind: "ui",
        content: noteContent(personal.id, "ui-note", firstBody),
      }),
    });
    expect(ingest.status).toBe(200);
    const committed = async (key: string) =>
      until(async () => {
        const response = await request(
          base,
          config,
          `/api/memory/events?space_id=${encodeURIComponent(personal.id)}` +
            `&source_event_key=${encodeURIComponent(key)}`,
        );
        if (response.status === 404) return null;
        const payload = (await response.json()) as { state: string };
        return payload.state === "committed" ? payload : null;
      });
    await committed("ui-evt-1");

    const secondBody = "İkinci gövde.";
    await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: personal.id,
        source_event_key: "ui-evt-2",
        source_kind: "ui",
        content: noteContent(personal.id, "ui-note", secondBody),
        note_id: "ui-note",
        base_revision: 1,
      }),
    });
    await committed("ui-evt-2");

    const revisions = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note/revisions` +
          `?space_id=${encodeURIComponent(personal.id)}`,
      )
    ).json()) as {
      items: { revision: number; content_hash: string; title: string }[];
      next: number | null;
    };
    expect(revisions.items.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions.next).toBeNull();
    for (const row of revisions.items)
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Keyset ilerleme: after son sürümü atlar, limit next döner.
    const afterOne = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note/revisions` +
          `?space_id=${encodeURIComponent(personal.id)}&after=1`,
      )
    ).json()) as { items: { revision: number }[] };
    expect(afterOne.items.map((row) => row.revision)).toEqual([2]);
    const limited = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note/revisions` +
          `?space_id=${encodeURIComponent(personal.id)}&limit=1`,
      )
    ).json()) as { items: { revision: number }[]; next: number | null };
    expect(limited.items.map((row) => row.revision)).toEqual([1]);
    expect(limited.next).toBe(1);

    // Eski sürüm içeriği değişmez ve dosya hash'i ile eşleşir.
    const oldRevision = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note/revisions/1` +
          `?space_id=${encodeURIComponent(personal.id)}`,
      )
    ).json()) as {
      revision: { revision: number; content_hash: string };
      content: string;
    };
    expect(oldRevision.revision.revision).toBe(1);
    expect(oldRevision.content).toContain(firstBody);
    expect(oldRevision.content).not.toContain(secondBody);
    expect(oldRevision.revision.content_hash).toBe(
      sha256Hex(oldRevision.content),
    );

    // Güncel sürüm ikinci gövdeyi verir.
    const newRevision = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note/revisions/2` +
          `?space_id=${encodeURIComponent(personal.id)}`,
      )
    ).json()) as { revision: { base_revision: number }; content: string };
    expect(newRevision.revision.base_revision).toBe(1);
    expect(newRevision.content).toContain(secondBody);

    // Eski temele dayanan güncelleme commit'te reddedilir; receipt bunu run
    // alanlarıyla görünür kılar (M04 çatışma paneli bu sözleşmeyi kullanır).
    const staleKey = "ui-evt-stale";
    await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: personal.id,
        source_event_key: staleKey,
        source_kind: "ui",
        content: noteContent(personal.id, "ui-note", "Üçüncü gövde."),
        note_id: "ui-note",
        base_revision: 1,
      }),
    });
    const staleReceipt = await until(async () => {
      const response = await request(
        base,
        config,
        `/api/memory/events?space_id=${encodeURIComponent(personal.id)}` +
          `&source_event_key=${staleKey}`,
      );
      if (response.status !== 200) return null;
      const payload = (await response.json()) as {
        state: string;
        run_state: string | null;
        run_error_code: string | null;
        error_code: string | null;
      };
      return payload.state === "rejected" ? payload : null;
    });
    expect(staleReceipt.run_state).toBe("failed");
    expect(staleReceipt.run_error_code).toBe("memory_revision_conflict");
    expect(staleReceipt.error_code).toBe("memory_revision_conflict");
    // Reddedilen olay yeni revision üretmedi.
    const unchanged = (await (
      await request(
        base,
        config,
        `/api/memory/notes/ui-note?space_id=${encodeURIComponent(personal.id)}`,
      )
    ).json()) as { revision: { revision: number } };
    expect(unchanged.revision.revision).toBe(2);

    // Olmayan sürüm ve yabancı tenant sızıntısız 404.
    const missing = await request(
      base,
      config,
      `/api/memory/notes/ui-note/revisions/99` +
        `?space_id=${encodeURIComponent(personal.id)}`,
    );
    expect(missing.status).toBe(404);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("memory_revision_unavailable");
    await storage.db
      .insertInto("tenants")
      .values({ id: "ui-tenant-b", name: "B", created_at: Date.now() })
      .execute();
    await storage.db
      .insertInto("users")
      .values({
        id: "ui-user-b",
        subject: "ui-user-b",
        display_name: "B",
        created_at: Date.now(),
      })
      .execute();
    await storage.db
      .insertInto("memberships")
      .values({
        tenant_id: "ui-tenant-b",
        user_id: "ui-user-b",
        role: "founder",
      })
      .execute();
    const foreign = await memory.createOrganizationSpace(
      { tenantId: "ui-tenant-b", userId: "ui-user-b" },
      "Yabancı",
    );
    const foreignRead = await request(
      base,
      config,
      `/api/memory/notes/ui-note/revisions` +
        `?space_id=${encodeURIComponent(foreign.id)}`,
    );
    expect(foreignRead.status).toBe(404);
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("#37 HTTP: note-scoped candidate filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-ui-cand-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const memory = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await memory.ensureSpace(owner, { type: "personal" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    const base = `http://127.0.0.1:${address.port}`;

    // Kaynak ve iki aday doğrudan yazılır: filtre gerçek satırlar üzerinde
    // doğrulanır (aday üretimi M02 kapsamındadır).
    const now = Date.now();
    await storage.db
      .insertInto("memory_sources")
      .values({
        tenant_id: owner.tenantId,
        id: "ui-source",
        space_id: space.id,
        root_path: join(root, "source"),
        mode: "read_only",
        cursor_json: null,
        checkpoint: null,
        last_scan_at: null,
        status: "present",
        created_by: owner.userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await storage.db
      .insertInto("memory_change_candidates")
      .values([
        {
          tenant_id: owner.tenantId,
          id: "cand-a1",
          source_id: "ui-source",
          path: "a.md",
          note_id: "note-a",
          previous_hash: null,
          observed_hash: "a".repeat(64),
          base_revision: null,
          state: "candidate",
          reason: "new_file",
          created_at: now,
          updated_at: now,
        },
        {
          tenant_id: owner.tenantId,
          id: "cand-a2",
          source_id: "ui-source",
          path: "a.md",
          note_id: "note-a",
          previous_hash: "b".repeat(64),
          observed_hash: "c".repeat(64),
          base_revision: 1,
          state: "conflict",
          reason: "changed",
          created_at: now,
          updated_at: now,
        },
        {
          tenant_id: owner.tenantId,
          id: "cand-b1",
          source_id: "ui-source",
          path: "b.md",
          note_id: "note-b",
          previous_hash: null,
          observed_hash: "d".repeat(64),
          base_revision: null,
          state: "candidate",
          reason: "new_file",
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const filtered = (await (
      await request(
        base,
        config,
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}` +
          `&note_id=note-a`,
      )
    ).json()) as { items: { id: string; note_id: string }[] };
    expect(filtered.items.map((row) => row.id)).toEqual(["cand-a1", "cand-a2"]);
    const conflictsOnly = (await (
      await request(
        base,
        config,
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}` +
          `&note_id=note-a&state=conflict`,
      )
    ).json()) as { items: { id: string }[] };
    expect(conflictsOnly.items.map((row) => row.id)).toEqual(["cand-a2"]);
    const all = (await (
      await request(
        base,
        config,
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}`,
      )
    ).json()) as { items: unknown[] };
    expect(all.items).toHaveLength(3);

    // Okuma hiçbir run/olay üretmez.
    const runs = await storage.db
      .selectFrom("runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(runs.n)).toBe(0);
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
