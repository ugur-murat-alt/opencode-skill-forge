import type { BackupRevision } from "./pins.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, lstat, readdir, chmod } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { secureRead, validatePackagePath } from "../skills/paths.js";
import { SecretVault } from "../storage/secrets.js";
import { PRODUCT_VERSION } from "../cli/config.js";
import { ForgeError } from "../domain/errors.js";
import type { PackageManifest } from "../skills/validate.js";
import {
  memoryBackupSummary,
  memoryReferences,
  reconcileRestoredMemory,
  type MemoryBackupSummary,
} from "./memory.js";
export const hash = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export interface Entry {
  path: string;
  bytes: number;
  hash: string;
}
export interface Manifest {
  format: 1;
  product: string;
  backend: "sqlite" | "postgres";
  created_at: string;
  files: Entry[];
  /** Issue #41: accepted Markdown head/revision map and purge receipts. */
  memory?: MemoryBackupSummary | null;
}
export const limit = 128 * 1024 * 1024;
export function fail(message: string): never {
  throw new ForgeError("backup_invalid", message);
}
async function native(path: string, readonly = true) {
  if (typeof Bun !== "undefined")
    fail("Backup/restore Node çalışma zamanı gerektirir.");
  const { default: Database } = await import("better-sqlite3");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    fail("SQLite dosyası güvenli değil.");
  let parent = dirname(path);
  while (true) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("Veri yolu symlink içeremez.");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const database = new Database(path, { readonly, fileMustExist: true });
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}
export async function references(
  root: string,
  query: (sql: string) => Promise<unknown[]>,
) {
  const files = new Map<string, { bytes?: number; hash?: string }>();
  for (const row of (await query(
    "SELECT revision, package_path, manifest_json FROM skill_revisions",
  )) as {
    revision: string;
    package_path: string;
    manifest_json: string;
  }[]) {
    const manifest = JSON.parse(row.manifest_json) as PackageManifest;
    if (
      manifest.hash !== row.revision ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 256
    )
      fail("Revision manifest geçersiz.");
    for (const file of manifest.files) {
      const path = `${row.package_path}/${file.path}`;
      validatePackagePath(path);
      files.set(path, { bytes: file.bytes, hash: file.hash });
    }
  }
  const secrets = (await query(
    "SELECT tenant_id, user_id, secret_ref FROM provider_profiles WHERE secret_ref IS NOT NULL",
  )) as { tenant_id: string; user_id: string; secret_ref: string }[];
  if (secrets.length) {
    // Reading must never synthesize a missing key.
    await secureRead(root, "secrets/master.key", 32);
    const vault = await SecretVault.open(root);
    files.set("secrets/master.key", {});
    for (const row of secrets) {
      await vault.get(row.tenant_id, row.user_id, row.secret_ref);
      const scope = createHash("sha256")
        .update(JSON.stringify([row.tenant_id, row.user_id]))
        .digest("hex");
      files.set(`secrets/${scope}-${row.secret_ref}.json`, {});
    }
  }
  for (const row of (await query(
    "SELECT result_json FROM executions WHERE result_json IS NOT NULL",
  )) as { result_json: string }[]) {
    const result = JSON.parse(row.result_json);
    for (const artifact of result.artifacts ?? []) {
      if (!result.sandbox_execution_id)
        fail("Artifact execution kimliği eksik.");
      const path = `execution/${result.sandbox_execution_id}/artifacts/${artifact.path}`;
      validatePackagePath(path);
      files.set(path, { bytes: artifact.bytes });
    }
    if (result.result_artifact_path) {
      const path = `execution/${result.sandbox_execution_id}/artifacts/${result.result_artifact_path}`;
      validatePackagePath(path);
      files.set(path, { bytes: result.result_bytes });
    }
  }
  for (const [path, expected] of await memoryReferences(query))
    files.set(path, expected);
  return files;
}
export async function fresh(path: string, source: string) {
  const rel = relative(source, path);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    fail("Hedef kaynak dizin içinde olamaz.");
  // Parent must already exist; never recursively create an ambiguous target.
  let parent = dirname(path);
  while (true) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Hedef üst dizini güvenli değil.");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  await mkdir(path, { mode: 0o700 });
}
export async function save(root: string, path: string, bytes: Buffer) {
  validatePackagePath(path);
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { flag: "wx", mode: 0o600 });
}
export async function backupSqlite(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  const db = await native(join(source, "local.sqlite"), false);
  let created = false;
  let unpin: (() => void) | undefined;
  try {
    await fresh(destination, source);
    created = true;
    await db.backup(join(destination, "local.sqlite"));
    await chmod(join(destination, "local.sqlite"), 0o600);
    const snapshot = await native(join(destination, "local.sqlite"));
    const files: Entry[] = [];
    let memorySummary: MemoryBackupSummary | null = null;
    try {
      const revisions = snapshot
        .prepare(
          "SELECT tenant_id, skill_id, revision FROM skill_revisions LIMIT 100000",
        )
        .all() as BackupRevision[];
      if (revisions.length >= 100000) fail("Yedek revision sınırı aşıldı.");
      const pins = revisions.map((row) => ({ ...row, id: randomUUID() }));
      db.transaction(() => {
        const insert = db.prepare(
          "INSERT INTO revision_readers (tenant_id, id, skill_id, revision, created_at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const pin of pins)
          insert.run(
            pin.tenant_id,
            pin.id,
            pin.skill_id,
            pin.revision,
            Date.now(),
          );
      })();
      unpin = () =>
        db.transaction(() => {
          const remove = db.prepare(
            "DELETE FROM revision_readers WHERE tenant_id = ? AND id = ?",
          );
          for (const pin of pins) remove.run(pin.tenant_id, pin.id);
        })();
      const refs = await sqliteReferences(source, snapshot);
      files.push(...(await copyReferences(source, destination, refs)));
      memorySummary = await memoryBackupSummary(async (sql) =>
        snapshot.prepare(sql).all(),
      );
    } finally {
      snapshot.close();
    }
    const verification = await native(join(destination, "local.sqlite"));
    try {
      await sqliteReferences(destination, verification);
    } finally {
      verification.close();
    }
    const bytes = await secureRead(destination, "local.sqlite", 1024 ** 3);
    files.push({
      path: "local.sqlite",
      bytes: bytes.length,
      hash: hash(bytes),
    });
    unpin?.();
    unpin = undefined;
    const manifest: Manifest = {
      format: 1,
      product: PRODUCT_VERSION,
      backend: "sqlite",
      created_at: new Date().toISOString(),
      files,
      memory: memorySummary,
    };
    await save(
      destination,
      "backup.json",
      Buffer.from(JSON.stringify(manifest)),
    );
    return { status: "created", files: files.length, destination };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      unpin?.();
    } finally {
      db.close();
    }
  }
}
export async function restoreSqlite(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  const manifest = JSON.parse(
    (await secureRead(source, "backup.json", 32 * 1024 ** 2)).toString(),
  ) as Manifest;
  if (
    manifest.format !== 1 ||
    manifest.backend !== "sqlite" ||
    manifest.product !== PRODUCT_VERSION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100000
  )
    fail("Yedek formatı veya ürün sürümü uyumsuz.");
  if (manifest.memory != null && typeof manifest.memory !== "object")
    fail("Yedek hafıza bölümü geçersiz.");
  let created = false;
  try {
    await fresh(destination, source);
    created = true;
    for (const entry of manifest.files) {
      if (entry.path === "owner-token" || entry.path === "backup.json")
        fail("Yedek envanteri geçersiz.");
      const bytes = await secureRead(
        source,
        entry.path,
        entry.path === "local.sqlite" ? 1024 ** 3 : limit,
      );
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.hash)
        fail("Yedek dosyası eksik veya hash uyuşmuyor.");
      await save(destination, entry.path, bytes);
    }
    const db = await native(join(destination, "local.sqlite"), false);
    try {
      const refs = await sqliteReferences(destination, db);
      for (const [path, expected] of refs) {
        const bytes = await secureRead(destination, path, limit);
        if (
          (expected.bytes !== undefined && bytes.length !== expected.bytes) ||
          (expected.hash && hash(bytes) !== expected.hash)
        )
          fail("Restore revision doğrulaması başarısız.");
      }
      db.prepare("UPDATE auth_sessions SET revoked = 1").run();
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revision_readers'",
          )
          .get()
      )
        db.prepare("DELETE FROM revision_readers").run();
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    await save(
      destination,
      "owner-token",
      Buffer.from(randomBytes(32).toString("hex")),
    );
    const memory = await reconcileRestoredMemory({
      dataDir: destination,
      backend: "sqlite",
      manifestCreatedAt: manifest.created_at ?? null,
      memory: manifest.memory ?? null,
    });
    return {
      status: "restored",
      destination,
      sessions_revoked: true,
      memory,
    };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function sqliteReferences(
  root: string,
  db: Awaited<ReturnType<typeof native>>,
) {
  if (
    db.pragma("integrity_check", { simple: true }) !== "ok" ||
    (db.pragma("foreign_key_check") as unknown[]).length
  )
    fail("Veritabanı bütünlüğü başarısız.");
  return references(root, async (sql) => db.prepare(sql).all());
}
export async function copyReferences(
  source: string,
  destination: string,
  refs: Map<string, { bytes?: number; hash?: string }>,
) {
  // Installation recovery records and execution artifacts are user data; caches are rebuildable.
  async function tree(path: string) {
    let entries;
    try {
      entries = await readdir(join(source, path), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      validatePackagePath(child);
      if (refs.size > 99999) fail("Yedek dosya sınırı aşıldı.");
      if (entry.isDirectory()) await tree(child);
      else if (entry.isFile()) refs.set(child, {});
      else fail("Yedekte symlink/özel dosya kabul edilmez.");
    }
  }
  await tree("installations");
  try {
    await lstat(join(source, "policy.json"));
    refs.set("policy.json", {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files: Entry[] = [];
  let total = 0;
  for (const [path, expected] of refs) {
    const bytes = await secureRead(source, path, limit);
    total += bytes.length;
    if (refs.size > 99999 || total > 10 * 1024 ** 3)
      fail("Yedek boyut sınırı aşıldı.");
    const digest = hash(bytes);
    if (
      (expected.bytes !== undefined && expected.bytes !== bytes.length) ||
      (expected.hash && expected.hash !== digest)
    )
      fail("Revision dosyası eksik veya bozuk.");
    await save(destination, path, bytes);
    files.push({ path, bytes: bytes.length, hash: digest });
  }

  return files;
}
