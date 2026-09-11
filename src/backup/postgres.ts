import { pinPostgres, type BackupRevision } from "./pins.js";
import { Client } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PRODUCT_VERSION } from "../cli/config.js";
import { secureRead } from "../skills/paths.js";
import {
  copyReferences,
  references,
  fresh,
  save,
  fail,
  hash,
  limit,
  type Manifest,
} from "./sqlite.js";
import { memoryBackupSummary, reconcileRestoredMemory } from "./memory.js";
const exec = promisify(execFile);
async function connect(url: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
    statement_timeout: 600000,
  });
  await client.connect();
  return client;
}
async function command(
  tool: "pg_dump" | "pg_restore",
  url: string,
  args: string[],
) {
  // Credentials stay out of argv and returned errors. Operator may select a matching client version.
  const executable =
    process.env[
      tool === "pg_dump" ? "SKILL_FORGE_PG_DUMP" : "SKILL_FORGE_PG_RESTORE"
    ] ?? tool;
  const address = new URL(url);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
  );
  Object.assign(env, {
    PGHOST: address.hostname,
    PGPORT: address.port || "5432",
    PGUSER: decodeURIComponent(address.username),
    PGPASSWORD: decodeURIComponent(address.password),
    PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "10",
  });
  const parameters: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    channel_binding: "PGCHANNELBINDING",
    application_name: "PGAPPNAME",
  };
  for (const [key, value] of address.searchParams) {
    if (!parameters[key])
      fail("PostgreSQL URL parametresi backup aracında desteklenmiyor.");
    env[parameters[key]!] = value;
  }
  try {
    const result = await exec(executable, args, {
      env,
      timeout: 600000,
      maxBuffer: 1024 * 1024,
    });
    if (result.stderr.trim())
      fail(`${tool} uyarı üretti; yedek kabul edilmedi.`);
  } catch {
    fail(
      `${tool} başarısız; bağlantı, araç/server sürümü ve yetkileri kontrol edin.`,
    );
  }
}
export async function backupPostgres(
  source: string,
  destination: string,
  url: string,
) {
  source = resolve(source);
  destination = resolve(destination);
  const db = await connect(url);
  let pinClient: Client | undefined;
  let unpin: (() => Promise<void>) | undefined;
  let created = false;
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await db.query("SELECT pg_export_snapshot() AS id"))
      .rows[0].id as string;
    const revisions = (
      await db.query(
        "SELECT tenant_id, skill_id, revision FROM skill_revisions LIMIT 100000",
      )
    ).rows as BackupRevision[];
    if (revisions.length >= 100000) fail("Yedek revision sınırı aşıldı.");
    pinClient = await connect(url);
    unpin = await pinPostgres(pinClient, revisions);
    const refs = await references(
      source,
      async (sql) => (await db.query(sql)).rows,
    );
    const memorySummary = await memoryBackupSummary(
      async (sql) => (await db.query(sql)).rows,
    );
    await fresh(destination, source);
    created = true;
    await command("pg_dump", url, [
      "--no-password",
      "--format=custom",
      `--snapshot=${snapshot}`,
      "--file",
      join(destination, "postgres.dump"),
    ]);
    await chmod(join(destination, "postgres.dump"), 0o600);
    const files = await copyReferences(source, destination, refs);
    await references(destination, async (sql) => (await db.query(sql)).rows);
    const dump = await secureRead(destination, "postgres.dump", 1024 ** 3);
    files.push({ path: "postgres.dump", bytes: dump.length, hash: hash(dump) });
    await db.query("COMMIT");
    await unpin();
    unpin = undefined;
    const manifest: Manifest = {
      format: 1,
      backend: "postgres",
      product: PRODUCT_VERSION,
      created_at: new Date().toISOString(),
      files,
      memory: memorySummary,
    };
    await save(
      destination,
      "backup.json",
      Buffer.from(JSON.stringify(manifest)),
    );
    return {
      status: "created",
      backend: "postgres",
      files: files.length,
      destination,
    };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      await unpin?.();
    } finally {
      try {
        await pinClient?.end();
      } finally {
        await db.end();
      }
    }
  }
}
export async function restorePostgres(
  source: string,
  destination: string,
  adminUrl: string,
  databaseName: string,
) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName))
    fail("Yeni DB adı küçük harf, rakam ve alt çizgi içermelidir.");
  source = resolve(source);
  destination = resolve(destination);
  const manifest = JSON.parse(
    (await secureRead(source, "backup.json", 32 * 1024 ** 2)).toString(),
  ) as Manifest;
  if (
    manifest.format !== 1 ||
    manifest.backend !== "postgres" ||
    manifest.product !== PRODUCT_VERSION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100000
  )
    fail("Yedek formatı/sürümü uyumsuz.");
  const admin = await connect(adminUrl);
  let created = false,
    databaseCreated = false,
    completed = false;
  try {
    if (
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          databaseName,
        ])
      ).rowCount
    )
      fail("Hedef DB zaten var; üzerine yazılmaz.");
    await fresh(destination, source);
    created = true;
    let total = 0;
    for (const entry of manifest.files) {
      if (
        entry.path === "owner-token" ||
        entry.path === "backup.json" ||
        entry.path === "local.sqlite"
      )
        fail("Yedek envanteri geçersiz.");
      const bytes = await secureRead(
        source,
        entry.path,
        entry.path === "postgres.dump" ? 1024 ** 3 : limit,
      );
      total += bytes.length;
      if (
        total > 11 * 1024 ** 3 ||
        bytes.length !== entry.bytes ||
        hash(bytes) !== entry.hash
      )
        fail("Yedek hash/boyut doğrulaması başarısız.");
      await save(destination, entry.path, bytes);
    }
    // Validate presence before creating any database.
    await secureRead(destination, "postgres.dump", 1024 ** 3);
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    await command("pg_restore", target.toString(), [
      "--no-password",
      "--dbname",
      "",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      join(destination, "postgres.dump"),
    ]);
    const db = await connect(target.toString());
    try {
      const refs = await references(
        destination,
        async (sql) => (await db.query(sql)).rows,
      );
      for (const [path, expected] of refs) {
        const bytes = await secureRead(destination, path, limit);
        if (
          (expected.bytes !== undefined && expected.bytes !== bytes.length) ||
          (expected.hash && hash(bytes) !== expected.hash)
        )
          fail("Restore revision doğrulaması başarısız.");
      }
      await db.query("UPDATE auth_sessions SET revoked = 1");
      if (
        (
          await db.query(
            "SELECT to_regclass('public.revision_readers') AS present",
          )
        ).rows[0].present
      )
        await db.query("DELETE FROM revision_readers");
    } finally {
      await db.end();
    }
    await save(
      destination,
      "owner-token",
      Buffer.from(randomBytes(32).toString("hex")),
    );
    await rm(join(destination, "postgres.dump"));
    const memory = await reconcileRestoredMemory({
      dataDir: destination,
      postgresUrl: target.toString(),
      backend: "postgres",
      manifestCreatedAt: manifest.created_at ?? null,
      memory: manifest.memory ?? null,
    });
    completed = true;
    return {
      status: "restored",
      backend: "postgres",
      database: databaseName,
      destination,
      sessions_revoked: true,
      memory,
    };
  } finally {
    try {
      if (!completed && databaseCreated)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      if (!completed && created)
        await rm(destination, { recursive: true, force: true });
    } finally {
      await admin.end();
    }
  }
}
