import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { ForgeError } from "../domain/errors.js";
import {
  noteWorkingPath,
  quarantineDir,
  revisionDir,
  revisionPath,
  tempDir,
  relativeVaultPath,
} from "./paths.js";

/**
 * Issue #35 (M02): filesystem primitives for the durable Markdown pipeline.
 * Writes are temp-file + fsync + rename; immutable revision files embed the
 * content hash in the name so a CAS loser can never delete the winner's file.
 * Reads that feed the pipeline detect mid-read changes; temp GC is based on
 * owner liveness, never on age alone.
 */

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function hostToken(host = hostname()): string {
  return host.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
}

export function tempFileName(
  pid: number,
  host = hostname(),
  id = randomUUID(),
): string {
  return `${pid}.${hostToken(host)}.${id}.tmp`;
}

export function parseTempFileName(
  name: string,
): { pid: number; host: string } | null {
  const match = /^(\d+)\.([A-Za-z0-9._-]+)\.([0-9a-f-]{36})\.tmp$/.exec(name);
  if (!match) return null;
  return { pid: Number(match[1]), host: match[2]! };
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort on platforms that reject it.
  }
}

/**
 * Atomically replace `path`: write to a temp file (same filesystem), fsync,
 * rename over the target, then fsync the directory.
 */
export async function atomicWriteFile(
  path: string,
  content: string | Buffer,
  options: { tempDir?: string; mode?: number } = {},
): Promise<void> {
  const directory = options.tempDir ?? dirname(path);
  await ensureDir(directory);
  await ensureDir(dirname(path));
  const temp = join(directory, tempFileName(process.pid));
  const handle = await open(temp, "wx", options.mode ?? 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDir(dirname(path));
}

/**
 * Read a text file with a bound and a stability check: if the file changed
 * while reading (size/mtime), the caller must retry on a later turn instead
 * of ingesting a half-written document.
 */
export async function readStableText(
  path: string,
  options: { maxBytes: number },
): Promise<{ content: string; hash: string; size: number }> {
  const before = await stat(path);
  if (before.size > options.maxBytes)
    throw new ForgeError(
      "memory_file_too_large",
      "Kaynak dosya boyut sınırını aşıyor.",
      422,
      undefined,
      { size: before.size, limit: options.maxBytes },
    );
  const content = await readFile(path, "utf8");
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    throw new ForgeError(
      "memory_file_changed",
      "Dosya okuma sırasında değişti; sonraki taramada yeniden denenecek.",
      409,
    );
  return { content, hash: sha256Hex(content), size: byteSize(content) };
}

export interface PublishedRevision {
  path: string;
  relativePath: string;
  created: boolean;
}

/**
 * Publish an immutable revision file. An existing file at the same
 * revision+hash is adopted (idempotent replay); a file that exists at the
 * exact path with different bytes is never overwritten.
 */
export async function publishRevisionFile(
  root: string,
  spaceId: string,
  noteId: string,
  revision: number,
  contentHash: string,
  content: string,
): Promise<PublishedRevision> {
  const path = revisionPath(root, spaceId, noteId, revision, contentHash);
  const relativePath = relativeVaultPath(root, path);
  if (!relativePath)
    throw new ForgeError("invalid_memory_path", "Revision yolu geçersiz.", 422);
  if (await fileExists(path)) {
    const existing = await readFile(path, "utf8");
    if (sha256Hex(existing) !== contentHash)
      throw new ForgeError(
        "memory_revision_file_conflict",
        "Aynı revision yolu farklı içerikle dolu; dosya ezilmedi.",
        409,
      );
    return { path, relativePath, created: false };
  }
  await atomicWriteFile(path, content, { tempDir: tempDir(root) });
  return { path, relativePath, created: true };
}

/** Read the managed working copy, or null when it does not exist yet. */
export async function readWorkingCopy(
  root: string,
  spaceId: string,
  noteId: string,
): Promise<{ content: string; hash: string; size: number } | null> {
  const path = noteWorkingPath(root, spaceId, noteId);
  const content = await readTextIfExists(path);
  if (content === null) return null;
  return { content, hash: sha256Hex(content), size: byteSize(content) };
}

export async function listRevisionFiles(
  root: string,
  spaceId: string,
  noteId: string,
): Promise<string[]> {
  const dir = revisionDir(root, spaceId, noteId);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(dir, name));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

export async function removeFileIfExists(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

export interface TempGcOptions {
  host?: string;
  isPidAlive: (pid: number) => boolean;
  minAgeMs?: number;
  now?: () => number;
}

/**
 * Remove temp files whose owner is provably gone: same host, dead pid, and
 * older than a small guard window. Foreign hosts are never touched without an
 * explicit operator recovery.
 */
export async function gcTempFiles(
  root: string,
  options: TempGcOptions,
): Promise<string[]> {
  const dir = tempDir(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const host = options.host ?? hostname();
  const ownToken = hostToken(host);
  const now = options.now ?? Date.now;
  const minAgeMs = options.minAgeMs ?? 5000;
  const removed: string[] = [];
  for (const name of entries) {
    const parsed = parseTempFileName(name);
    if (!parsed) continue;
    if (parsed.host !== ownToken) continue; // foreign host: keep
    if (options.isPidAlive(parsed.pid)) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (now() - info.mtimeMs < minAgeMs) continue;
    await rm(path, { force: true });
    removed.push(name);
  }
  return removed;
}

export interface QuarantineEntry {
  id: string;
  reason: string;
  hash?: string | null;
  path?: string | null;
  summary?: string | null;
  created_at: number;
}

/**
 * Quarantine metadata only: hash, bounded summary and reason. Raw sensitive
 * content is never stored here.
 */
export async function writeQuarantine(
  root: string,
  entry: Omit<QuarantineEntry, "id" | "created_at"> & { id?: string },
): Promise<string> {
  const dir = quarantineDir(root);
  await ensureDir(dir);
  const id = entry.id ?? randomUUID();
  const record: QuarantineEntry = {
    id,
    reason: entry.reason.slice(0, 200),
    hash: entry.hash ?? null,
    path: entry.path ?? null,
    summary: entry.summary ? entry.summary.slice(0, 500) : null,
    created_at: Date.now(),
  };
  const path = join(dir, `${id}.json`);
  await atomicWriteFile(path, JSON.stringify(record), { tempDir: dir });
  return path;
}
