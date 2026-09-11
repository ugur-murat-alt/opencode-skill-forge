import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M02 (#35) HTTP kabul testleri.
 *
 * - GET uçları hiçbir run/olay/audit satırı üretmez (salt okunur).
 * - Mutasyonlar ACL + audit taşır; hata kodları sözleşmeye uyar.
 * - İkinci bir kiracı oturumu, sahibinin alanına/notuna erişemez (404) ve
 *   bu denemeler audit üretmez.
 * - POST /api/memory/ingest kalıcı kabulden sonra döner; receipt ancak worker
 *   commit'inden sonra `committed` olur; GET not detayı kabul edilen içeriği
 *   verir.
 *
 * SQLite ve (scratch) PostgreSQL üzerinde koşar.
 */

const HOST = (config: { url: string }) => new URL(config.url).host;

function localHeaders(config: { url: string; token: string }) {
  return {
    host: HOST(config),
    authorization: `Bearer ${config.token}`,
  } as Record<string, string>;
}

function sessionHeaders(
  config: { url: string; token: string },
  token: string,
  tenantId: string,
) {
  return {
    host: HOST(config),
    cookie: `forge_session=${token}; forge_tenant=${tenantId}`,
    "x-forge-tenant": tenantId,
    "x-forge-csrf": createHash("sha256").update(token).digest("hex"),
  } as Record<string, string>;
}

async function request(
  base: string,
  headers: Record<string, string>,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.body ? { "content-type": "application/json" } : {}),
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
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error("beklenen koşul zaman aşımına uğradı");
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
] as const) {
  test(`#35 bağımsız HTTP: GET salt okunur, mutasyon audit + ACL, kiracı izolasyonu (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-m02-http-ind-"));
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
      { mode: 0o600 },
    );
    let admin: PgClient | undefined;
    let databaseName: string | undefined;
    let postgresUrl: string | undefined;
    if (backend === "postgres") {
      databaseName = `forge_m02_http_ind_${crypto.randomUUID().replaceAll("-", "")}`;
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const baseConfig = await localConfig(root);
    const config = { ...baseConfig, postgresUrl };
    const app = await createHttpServer(config);
    const storage = await openDatabase({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
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
      const ownerHeaders = localHeaders(config);

      // Kimliksiz: 401.
      const anonymous = await fetch(`${base}/api/memory/spaces`, {
        headers: { host: HOST(config) },
      });
      expect(anonymous.status).toBe(401);

      // GET salt okunur: tüm GET uçları run/olay/audit sayısını değiştirmez.
      const counts = async () => {
        const [runs, events, audit] = await Promise.all([
          storage.db
            .selectFrom("runs")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("tenant_id", "=", owner.tenantId)
            .executeTakeFirstOrThrow(),
          storage.db
            .selectFrom("memory_events")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("tenant_id", "=", owner.tenantId)
            .executeTakeFirstOrThrow(),
          storage.db
            .selectFrom("audit_events")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("tenant_id", "=", owner.tenantId)
            .executeTakeFirstOrThrow(),
        ]);
        return [Number(runs.n), Number(events.n), Number(audit.n)];
      };
      const before = await counts();
      const getPaths = [
        "/api/memory/spaces",
        `/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
        `/api/memory/notes/missing-note?space_id=${encodeURIComponent(space.id)}`,
        `/api/memory/events?space_id=${encodeURIComponent(space.id)}&source_event_key=yok`,
        "/api/memory/sources",
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}`,
      ];
      for (const path of getPaths) {
        const response = await request(base, ownerHeaders, path);
        expect([200, 404]).toContain(response.status);
      }
      expect(await counts()).toEqual(before);

      // Mutasyon: ingests kalıcı kabulden sonra döner, receipt worker ile dolar.
      const content = [
        "---",
        "format_version: 1",
        'note_id: "http-ind-note"',
        `memory_space_id: ${JSON.stringify(space.id)}`,
        "kind: note",
        'title: "HTTP bağımsız"',
        "---",
        "",
        "HTTP gövdesi.",
        "",
      ].join("\n");
      const ingest = await request(base, ownerHeaders, "/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: "http-ind-evt",
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
      expect(accepted).toMatchObject({
        status: "accepted",
        run_state: "queued",
      });
      const receipt = await until(async () => {
        const response = await request(
          base,
          ownerHeaders,
          `/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
            `&source_event_key=http-ind-evt`,
        );
        if (response.status !== 200) return null;
        const payload = (await response.json()) as {
          state: string;
          indexed: boolean;
          receipt: { revision: number; fileHash: string } | null;
        };
        // #35: `indexed` ayrı ve sonraki aşamadır; yalnız `committed` görüp
        // hemen `indexed` okumak işaret yazımıyla yarışır (yük altında
        // gözlendi). İkisini birlikte bekle.
        return payload.state === "committed" && payload.indexed
          ? payload
          : null;
      });
      expect(receipt.receipt?.revision).toBe(1);
      expect(receipt.indexed).toBe(true);
      const detail = await request(
        base,
        ownerHeaders,
        `/api/memory/notes/http-ind-note?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(detail.status).toBe(200);
      const detailPayload = (await detail.json()) as {
        content: string;
        revision: { revision: number };
      };
      expect(detailPayload.revision.revision).toBe(1);
      expect(detailPayload.content).toContain("HTTP gövdesi.");

      // Duplicate ve çakışma: audit yalnız başarılı kabul/duplicate yazar.
      const duplicate = await request(
        base,
        ownerHeaders,
        "/api/memory/ingest",
        {
          method: "POST",
          body: JSON.stringify({
            space_id: space.id,
            source_event_key: "http-ind-evt",
            source_kind: "manual",
            content,
          }),
        },
      );
      expect(duplicate.status).toBe(200);
      expect(
        ((await duplicate.json()) as { status: string; run_id: string }).run_id,
      ).toBe(accepted.run_id);
      const conflict = await request(base, ownerHeaders, "/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: "http-ind-evt",
          source_kind: "manual",
          content: `${content}\nDeğişti.`,
        }),
      });
      expect(conflict.status).toBe(409);
      const ingestAudit = await storage.db
        .selectFrom("audit_events")
        .select(["detail"])
        .where("tenant_id", "=", owner.tenantId)
        .where("kind", "=", "memory.ingest.accepted")
        .execute();
      expect(ingestAudit).toHaveLength(2);
      const auditDetails = ingestAudit.map(
        (row) => JSON.parse(row.detail) as { duplicate: boolean },
      );
      expect(
        auditDetails.filter((detail) => detail.duplicate === false),
      ).toHaveLength(1);
      expect(
        auditDetails.filter((detail) => detail.duplicate === true),
      ).toHaveLength(1);

      // Hata kodları.
      const badBody = await request(base, ownerHeaders, "/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: "eksik",
          content,
        }),
      });
      expect(badBody.status).toBe(400);
      const unknownSpace = await request(
        base,
        ownerHeaders,
        "/api/memory/ingest",
        {
          method: "POST",
          body: JSON.stringify({
            space_id: "yok-böyle-alan",
            source_event_key: "yok",
            source_kind: "manual",
            content: "yok",
          }),
        },
      );
      expect(unknownSpace.status).toBe(404);
      const archiveUnknown = await request(
        base,
        ownerHeaders,
        "/api/memory/notes/yok/archive",
        {
          method: "POST",
          body: JSON.stringify({ space_id: space.id }),
        },
      );
      expect(archiveUnknown.status).toBe(404);
      const scanUnknown = await request(
        base,
        ownerHeaders,
        "/api/memory/sources/yok/scan",
        { method: "POST", body: JSON.stringify({ limit: 5 }) },
      );
      expect(scanUnknown.status).toBe(404);

      // İkinci kiracı oturumu: sızıntısız 404, audit yok.
      await storage.db
        .insertInto("tenants")
        .values({ id: "ind-tenant-b", name: "B", created_at: Date.now() })
        .execute();
      await storage.db
        .insertInto("users")
        .values({
          id: "ind-user-b",
          subject: "ind-user-b",
          display_name: "B",
          created_at: Date.now(),
        })
        .execute();
      await storage.db
        .insertInto("memberships")
        .values({
          tenant_id: "ind-tenant-b",
          user_id: "ind-user-b",
          role: "founder",
        })
        .execute();
      const tokenB = await identities.issueSession(
        "ind-user-b",
        "session",
        3600_000,
      );
      const bHeaders = sessionHeaders(config, tokenB, "ind-tenant-b");
      const bSpaces = await request(base, bHeaders, "/api/memory/spaces");
      expect(bSpaces.status).toBe(200);
      const bSpacePayload = (await bSpaces.json()) as {
        items: { id: string }[];
      };
      expect(bSpacePayload.items.some((item) => item.id === space.id)).toBe(
        false,
      );
      const bRead = await request(
        base,
        bHeaders,
        `/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(bRead.status).toBe(404);
      const bIngest = await request(base, bHeaders, "/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: "b-evt",
          source_kind: "manual",
          content: "yabancı",
        }),
      });
      expect(bIngest.status).toBe(404);
      const bArchive = await request(
        base,
        bHeaders,
        "/api/memory/notes/http-ind-note/archive",
        { method: "POST", body: JSON.stringify({ space_id: space.id }) },
      );
      expect(bArchive.status).toBe(404);
      const bAudit = await storage.db
        .selectFrom("audit_events")
        .select(["id"])
        .where("tenant_id", "=", "ind-tenant-b")
        .execute();
      expect(bAudit).toHaveLength(0);
    } finally {
      await app.close();
      await storage.close();
      if (admin && databaseName) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  test(`#35 bağımsız HTTP: kaynak/scan/çatışma ve arşiv/restore audit izi (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-m02-http-ind2-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "forge-m02-http-src-"));
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
      { mode: 0o600 },
    );
    await writeFile(join(sourceRoot, "kaynak.md"), "kaynak içeriği");
    let admin: PgClient | undefined;
    let databaseName: string | undefined;
    let postgresUrl: string | undefined;
    if (backend === "postgres") {
      databaseName = `forge_m02_http_ind2_${crypto.randomUUID().replaceAll("-", "")}`;
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const baseConfig = await localConfig(root);
    const config = { ...baseConfig, postgresUrl };
    const app = await createHttpServer(config);
    const storage = await openDatabase({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
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
      const headers = localHeaders(config);

      const registered = await request(base, headers, "/api/memory/sources", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          root_path: sourceRoot,
          mode: "read_only",
        }),
      });
      expect(registered.status).toBe(200);
      const source = (await registered.json()) as { id: string };
      const scanned = await request(
        base,
        headers,
        `/api/memory/sources/${source.id}/scan`,
        { method: "POST", body: JSON.stringify({ limit: 10 }) },
      );
      expect(scanned.status).toBe(200);
      expect(await scanned.json()).toMatchObject({
        scanned: 1,
        candidates: 1,
        done: true,
      });
      const conflicts = await request(
        base,
        headers,
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}&state=bogus`,
      );
      // Geçersiz state 400; geçerli sorgu adayı getirir.
      expect(conflicts.status).toBe(400);
      const candidates = await request(
        base,
        headers,
        `/api/memory/conflicts?space_id=${encodeURIComponent(space.id)}`,
      );
      expect(candidates.status).toBe(200);
      expect((await candidates.json()) as { items: unknown[] }).toMatchObject({
        items: [{ path: "kaynak.md", state: "candidate" }],
      });

      // Arşiv/restore: audit izi.
      const content = [
        "---",
        "format_version: 1",
        'note_id: "http-ind-archive"',
        `memory_space_id: ${JSON.stringify(space.id)}`,
        "kind: note",
        'title: "Arşiv"',
        "---",
        "",
        "Gövde.",
        "",
      ].join("\n");
      const ingest = await request(base, headers, "/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: "http-ind-archive-evt",
          source_kind: "manual",
          content,
        }),
      });
      expect(ingest.status).toBe(200);
      await until(async () => {
        const response = await request(
          base,
          headers,
          `/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
            `&source_event_key=http-ind-archive-evt`,
        );
        if (response.status !== 200) return null;
        const payload = (await response.json()) as { state: string };
        return payload.state === "committed" ? payload : null;
      });
      const archived = await request(
        base,
        headers,
        "/api/memory/notes/http-ind-archive/archive",
        { method: "POST", body: JSON.stringify({ space_id: space.id }) },
      );
      expect(archived.status).toBe(200);
      const restored = await request(
        base,
        headers,
        "/api/memory/notes/http-ind-archive/restore",
        { method: "POST", body: JSON.stringify({ space_id: space.id }) },
      );
      expect(restored.status).toBe(200);
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
      expect(new Set(audit.map((row) => row.kind))).toEqual(
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
      if (admin && databaseName) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  }, 60000);
}
