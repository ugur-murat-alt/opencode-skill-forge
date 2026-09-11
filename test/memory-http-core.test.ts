import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import {
  noteWorkingPath,
  resolveVaultRelative,
  vaultRoot,
} from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";

/**
 * Issue #35 (M02): real HTTP surface. GET endpoints are read-only; the ingest
 * mutation is explicit POST with ACL + audit and returns after the queue
 * accepted the event. The receipt only reports `committed` once the worker
 * wrote the immutable revision; the note read returns the accepted content.
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

test("#35 HTTP: explicit ingest, durable receipt, read-only GETs and audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-http-"));
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

    // Yetkisiz istek reddedilir.
    const anonymous = await fetch(`${base}/api/memory/spaces`, {
      headers: { host: HOST(config) },
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(401);

    const content = [
      "---",
      "format_version: 1",
      'note_id: "http-note"',
      `memory_space_id: ${JSON.stringify(space.id)}`,
      "kind: note",
      'title: "HTTP notu"',
      "---",
      "",
      "HTTP üzerinden kabul edilen gövde.",
      "",
    ].join("\n");
    const ingest = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        source_event_key: "http-evt-1",
        source_kind: "manual",
        content,
      }),
    });
    expect(ingest.status).toBe(200);
    const accepted = (await ingest.json()) as {
      status: string;
      run_id: string;
      run_state: string;
    };
    expect(accepted.status).toBe("accepted");
    expect(accepted.run_state).toBe("queued");

    // Kuyruk kabulü = kalıcı kabul; receipt olayı handler'a kadar 404 kalır.
    const receipt = await until(async () => {
      const response = await request(
        base,
        config,
        `/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
          `&source_event_key=http-evt-1`,
      );
      if (response.status === 404) return null;
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        state: string;
        indexed: boolean;
        committed_revision: number | null;
        receipt: {
          noteId: string;
          revision: number;
          fileHash: string;
          filePath: string;
          indexed: boolean;
        } | null;
      };
      if (payload.state !== "committed") return null;
      return payload;
    });
    expect(receipt.indexed).toBe(true);
    expect(receipt.committed_revision).toBe(1);
    expect(receipt.receipt?.revision).toBe(1);
    // Receipt'in hash'i immutable revision dosyasının baytlarıyla birebir
    // eşleşir (HTTP gövdesi kanonik serileştirmeyle yeniden yazılır).
    expect(receipt.receipt?.fileHash).toBe(
      sha256Hex(
        await readFile(
          resolveVaultRelative(vaultRoot(root), receipt.receipt!.filePath),
          "utf8",
        ),
      ),
    );

    // GET salt okunur: not listesi/detayı kabul edilen içeriği verir.
    const list = await request(
      base,
      config,
      `/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      items: { id: string; display_path: string }[];
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.id).toBe("http-note");
    expect(listed.items[0]!.display_path).toContain("http-note");
    const detail = await request(
      base,
      config,
      `/api/memory/notes/http-note?space_id=${encodeURIComponent(space.id)}`,
    );
    expect(detail.status).toBe(200);
    const detailPayload = (await detail.json()) as {
      content: string;
      revision: { revision: number };
    };
    expect(detailPayload.revision.revision).toBe(1);
    expect(detailPayload.content).toContain("kabul edilen gövde");
    const disk = await readFile(
      noteWorkingPath(vaultRoot(root), space.id, "http-note"),
      "utf8",
    );
    expect(ios(detailPayload.content)).toBe(ios(disk));

    // Aynı olay yeniden gönderilir: duplicate, aynı run, yeni revision yok.
    const duplicate = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        source_event_key: "http-evt-1",
        source_kind: "manual",
        content,
      }),
    });
    expect(duplicate.status).toBe(200);
    const duplicatePayload = (await duplicate.json()) as {
      status: string;
      run_id: string;
    };
    expect(duplicatePayload.status).toBe("duplicate");
    expect(duplicatePayload.run_id).toBe(accepted.run_id);
    // Aynı anahtar farklı içerik: açık 409.
    const conflict = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        source_event_key: "http-evt-1",
        source_kind: "manual",
        content: `${content}\nDeğişti.`,
      }),
    });
    expect(conflict.status).toBe(409);

    // GET çağrıları hiçbir run/olay üretmez (salt okunur).
    const runsBefore = await storage.db
      .selectFrom("runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", owner.tenantId)
      .executeTakeFirstOrThrow();
    await request(base, config, "/api/memory/spaces");
    await request(
      base,
      config,
      `/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
    );
    await request(
      base,
      config,
      `/api/memory/notes/http-note?space_id=${encodeURIComponent(space.id)}`,
    );
    const runsAfter = await storage.db
      .selectFrom("runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", owner.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(runsAfter.n)).toBe(Number(runsBefore.n));

    // Audit: mutasyon açıkça kaydedildi.
    const audit = await storage.db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "=", "memory.ingest.accepted")
      .execute();
    // İlk kabul ve duplicate kabul audit'e yazılır; 409 çakışması yazılmaz.
    expect(audit).toHaveLength(2);
    const details = audit.map(
      (row) => JSON.parse(row.detail) as Record<string, unknown>,
    );
    expect(details.filter((detail) => detail.duplicate === false)).toHaveLength(
      1,
    );
    expect(details.filter((detail) => detail.duplicate === true)).toHaveLength(
      1,
    );
    for (const detail of details)
      expect(detail).toMatchObject({
        space_id: space.id,
        source_event_key: "http-evt-1",
      });

    // Başka kiracının alanı: sızıntısız 404.
    await storage.db
      .insertInto("tenants")
      .values({ id: "http-tenant-b", name: "B", created_at: Date.now() })
      .execute();
    await storage.db
      .insertInto("users")
      .values({
        id: "http-user-b",
        subject: "http-user-b",
        display_name: "B",
        created_at: Date.now(),
      })
      .execute();
    await storage.db
      .insertInto("memberships")
      .values({
        tenant_id: "http-tenant-b",
        user_id: "http-user-b",
        role: "founder",
      })
      .execute();
    const foreign = await new MemoryService(storage.db).createOrganizationSpace(
      { tenantId: "http-tenant-b", userId: "http-user-b" },
      "Yabancı",
    );
    const denied = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: foreign.id,
        source_event_key: "http-evt-foreign",
        source_kind: "manual",
        content: "yabancı",
      }),
    });
    expect(denied.status).toBe(404);
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

/** Satır sonu farkını normalize eder. */
function ios(value: string | null): string {
  return (value ?? "").replace(/\r\n/g, "\n");
}

test("#35 HTTP: source registration/scan/conflicts and explicit archive/restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-http-src-"));
  const sourceRoot = await mkdtemp(
    join(tmpdir(), "forge-memory-http-src-root-"),
  );
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  await writeFile(join(sourceRoot, "not.md"), "kaynak dosyası");
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

    const registered = await request(base, config, "/api/memory/sources", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        root_path: sourceRoot,
        mode: "read_only",
      }),
    });
    expect(registered.status).toBe(200);
    const source = (await registered.json()) as {
      id: string;
      root_path: string;
    };
    expect(source.root_path).toContain("forge-memory-http-src-root-");

    const scanned = await request(
      base,
      config,
      `/api/memory/sources/${source.id}/scan`,
      { method: "POST", body: JSON.stringify({ limit: 20 }) },
    );
    expect(scanned.status).toBe(200);
    const report = (await scanned.json()) as {
      scanned: number;
      candidates: number;
      done: boolean;
    };
    expect(report).toMatchObject({ scanned: 1, candidates: 1, done: true });

    const conflicts = await request(
      base,
      config,
      `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}`,
    );
    expect(conflicts.status).toBe(200);
    const conflictPayload = (await conflicts.json()) as {
      items: { path: string; state: string }[];
    };
    expect(conflictPayload.items).toHaveLength(1);
    expect(conflictPayload.items[0]).toMatchObject({
      path: "not.md",
      state: "candidate",
    });

    // Bir not commit edilir, sonra açık arşiv/restore uygulanır.
    const content = [
      "---",
      "format_version: 1",
      'note_id: "http-archive"',
      `memory_space_id: ${JSON.stringify(space.id)}`,
      "kind: note",
      'title: "Arşiv notu"',
      "---",
      "",
      "Arşivlenebilir gövde.",
      "",
    ].join("\n");
    const ingest = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        source_event_key: "http-archive-evt",
        source_kind: "manual",
        content,
      }),
    });
    expect(ingest.status).toBe(200);
    await until(async () => {
      const response = await request(
        base,
        config,
        `/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
          `&source_event_key=http-archive-evt`,
      );
      if (response.status !== 200) return null;
      const payload = (await response.json()) as { state: string };
      return payload.state === "committed" ? payload : null;
    });

    const archived = await request(
      base,
      config,
      "/api/memory/notes/http-archive/archive",
      { method: "POST", body: JSON.stringify({ space_id: space.id }) },
    );
    expect(archived.status).toBe(200);
    expect(
      (
        await storage.db
          .selectFrom("memory_notes")
          .select(["deleted_at"])
          .where("id", "=", "http-archive")
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).not.toBeNull();
    // Arşivli nota yeni revision commit edilemez (tombstone).
    const blocked = await request(base, config, "/api/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        source_event_key: "http-archive-evt-2",
        source_kind: "manual",
        content: content.replace("Arşivlenebilir gövde.", "Yeni gövde."),
        base_revision: 1,
      }),
    });
    expect(blocked.status).toBe(200);
    const blockedRunId = ((await blocked.json()) as { run_id: string }).run_id;
    const failedRun = await until(async () => {
      const row = await storage.db
        .selectFrom("runs")
        .select(["state", "error_code"])
        .where("id", "=", blockedRunId)
        .executeTakeFirst();
      return row && row.state === "failed" ? row : null;
    });
    expect(failedRun.error_code).toBe("memory_note_deleted");

    const restored = await request(
      base,
      config,
      "/api/memory/notes/http-archive/restore",
      { method: "POST", body: JSON.stringify({ space_id: space.id }) },
    );
    expect(restored.status).toBe(200);
    expect(
      (
        await storage.db
          .selectFrom("memory_notes")
          .select(["deleted_at"])
          .where("id", "=", "http-archive")
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).toBeNull();

    const audit = await storage.db
      .selectFrom("audit_events")
      .select(["kind"])
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "in", [
        "memory.source.registered",
        "memory.source.scanned",
        "memory.note.archived",
        "memory.note.restored",
      ])
      .execute();
    const kinds = new Set(audit.map((row) => row.kind));
    expect(kinds).toEqual(
      new Set([
        "memory.source.registered",
        "memory.source.scanned",
        "memory.note.archived",
        "memory.note.restored",
      ]),
    );
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
}, 30000);
