import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ForgeError } from "../domain/errors.js";

/**
 * Issue #35 (M02): vault layout and canonical paths.
 *
 * Identity is always ID/hash based (`spaces/<spaceId>/notes/<noteId>.md`,
 * `.../revisions/<noteId>/<revision>-<contentHash>.md`). Readable folders
 * (decisions/tasks/notes) are presentation only: they may be offered by a UI,
 * but moving a file between them never changes `note_id`, and no folder name
 * grants identity or authority. Every join goes through `safeJoin`, so a
 * note/source path can never escape the vault root.
 */

export const MEMORY_VAULT_DIRNAME = "memory";
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;

function invalidPath(message: string): never {
  throw new ForgeError("invalid_memory_path", message, 422);
}

export function assertPathSegment(
  segment: string,
  label = "yol parçası",
): string {
  if (
    typeof segment !== "string" ||
    !SEGMENT.test(segment) ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  )
    invalidPath(`Geçersiz ${label}.`);
  return segment;
}

/** Resolve `...segments` under `root`, rejecting anything outside it. */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  for (const segment of segments) assertPathSegment(segment);
  const candidate = resolve(resolvedRoot, ...segments);
  const rel = relative(resolvedRoot, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    invalidPath("Yol vault kökünün dışında.");
  return candidate;
}

export function vaultRoot(dataDir: string): string {
  return join(resolve(dataDir), MEMORY_VAULT_DIRNAME);
}

export function spaceRoot(root: string, spaceId: string): string {
  return safeJoin(root, "spaces", spaceId);
}

/** The service-published working copy (canonical identity path). */
export function noteWorkingPath(
  root: string,
  spaceId: string,
  noteId: string,
): string {
  return safeJoin(root, "spaces", spaceId, "notes", `${noteId}.md`);
}

export function revisionDir(
  root: string,
  spaceId: string,
  noteId: string,
): string {
  return safeJoin(root, "spaces", spaceId, "revisions", noteId);
}

/**
 * Immutable revision file. The content hash is part of the name, so two
 * writers racing for the same revision never collide on the winner's file.
 */
export function revisionPath(
  root: string,
  spaceId: string,
  noteId: string,
  revision: number,
  contentHash: string,
): string {
  if (!Number.isInteger(revision) || revision < 1)
    invalidPath("Revision numarası geçersiz.");
  if (!HASH.test(contentHash)) invalidPath("İçerik hash'i geçersiz.");
  return safeJoin(
    root,
    "spaces",
    spaceId,
    "revisions",
    noteId,
    `${revision}-${contentHash}.md`,
  );
}

export function revisionFileName(
  revision: number,
  contentHash: string,
): string {
  if (!Number.isInteger(revision) || revision < 1)
    invalidPath("Revision numarası geçersiz.");
  if (!HASH.test(contentHash)) invalidPath("İçerik hash'i geçersiz.");
  return `${revision}-${contentHash}.md`;
}

export function tempDir(root: string): string {
  return safeJoin(root, ".tmp");
}

export function quarantineDir(root: string): string {
  return safeJoin(root, ".quarantine");
}

export function writerLockPath(root: string): string {
  return safeJoin(root, ".writer.lock");
}

/** Resolve a vault-relative POSIX path (e.g. a stored `file_path`). */
export function resolveVaultRelative(
  root: string,
  relativePath: string,
): string {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\")
  )
    invalidPath("Vault göreli yol geçersiz.");
  return safeJoin(root, ...relativePath.split("/"));
}

/** Vault-relative POSIX path, or null when `absolute` is outside the root. */
export function relativeVaultPath(
  root: string,
  absolute: string,
): string | null {
  const rel = relative(resolve(root), resolve(absolute));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

const KIND_FOLDERS: Readonly<Record<string, string>> = {
  decision: "decisions",
  task: "tasks",
  session: "sessions",
  preference: "preferences",
  research: "research",
  procedure: "procedures",
  context: "context",
  fact: "facts",
  note: "notes",
};

export function kindFolder(kind: string): string {
  return KIND_FOLDERS[kind] ?? "notes";
}

function slugify(title: string): string {
  const map: Record<string, string> = {
    ç: "c",
    ğ: "g",
    ı: "i",
    İ: "i",
    ö: "o",
    ş: "s",
    ü: "u",
    Ç: "c",
    Ğ: "g",
    Ö: "o",
    Ş: "s",
    Ü: "u",
  };
  const slug = title
    .split("")
    .map((char) => map[char] ?? char)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "not";
}

/**
 * Presentation path for a UI list. Never used for writes; the canonical file
 * stays at `noteWorkingPath`, so renaming/title edits do not move identity.
 */
export function noteDisplayPath(
  spaceId: string,
  kind: string,
  title: string,
  noteId: string,
): string {
  return `spaces/${spaceId}/${kindFolder(kind)}/${slugify(title)}-${noteId}.md`;
}
