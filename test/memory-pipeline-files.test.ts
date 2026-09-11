import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noteDisplayPath,
  noteWorkingPath,
  revisionPath,
  safeJoin,
  tempDir,
  vaultRoot,
} from "../src/memory/paths.js";
import {
  atomicWriteFile,
  gcTempFiles,
  publishRevisionFile,
  readStableText,
  readWorkingCopy,
  sha256Hex,
  tempFileName,
  writeQuarantine,
} from "../src/memory/files.js";

/**
 * Issue #35 (M02): vault path and file primitives. Real files only; the
 * atomic publish, idempotent adoption, bounded stable read, ownership-based
 * temp GC and quarantine metadata are all exercised against the filesystem.
 */

const uuid = () => crypto.randomUUID();
const HASH_A = "a".repeat(64);

test("#35 safe join keeps every path inside the vault and rejects traversal", () => {
  const root = join(tmpdir(), "forge-memory-paths");
  expect(safeJoin(root, "spaces", uuid(), "notes", "n1.md")).toContain(root);
  for (const bad of [
    [".."],
    ["spaces", "..", "escape"],
    ["/etc/passwd"],
    ["spaces", ""],
    ["spaces", "a/b"],
    ["spaces", "a\\b"],
  ])
    expect(() => safeJoin(root, ...bad)).toThrow();
  expect(() => revisionPath(root, "space", "note", 0, HASH_A)).toThrow();
  expect(() => revisionPath(root, "space", "note", 1, "not-a-hash")).toThrow();
  // Presentation folders never change identity: the canonical working path
  // stays ID-based.
  const spaceId = uuid();
  const noteId = uuid();
  expect(noteWorkingPath(root, spaceId, noteId)).toEndWith(
    join("spaces", spaceId, "notes", `${noteId}.md`),
  );
  expect(noteDisplayPath(spaceId, "decision", "İlk Karar", noteId)).toContain(
    `decisions/ilk-karar-${noteId}.md`,
  );
});

test("#35 atomic write replaces content without leaving temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-atomic-"));
  try {
    const target = join(root, "notes", "n1.md");
    await atomicWriteFile(target, "ilk içerik", { tempDir: tempDir(root) });
    expect(await readStableText(target, { maxBytes: 1024 })).toMatchObject({
      content: "ilk içerik",
      hash: sha256Hex("ilk içerik"),
    });
    await atomicWriteFile(target, "ikinci", { tempDir: tempDir(root) });
    expect((await readStableText(target, { maxBytes: 1024 })).content).toBe(
      "ikinci",
    );
    expect(await readdir(tempDir(root))).toEqual([]);
    await expect(readStableText(target, { maxBytes: 2 })).rejects.toMatchObject(
      { code: "memory_file_too_large", status: 422 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 revision publication adopts the same hash and never overwrites a different file", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-revision-"));
  try {
    const spaceId = uuid(),
      noteId = uuid();
    const content = "---\nformat_version: 1\n---\nGövde\n";
    const hash = sha256Hex(content);
    const first = await publishRevisionFile(
      root,
      spaceId,
      noteId,
      1,
      hash,
      content,
    );
    expect(first.created).toBe(true);
    const second = await publishRevisionFile(
      root,
      spaceId,
      noteId,
      1,
      hash,
      content,
    );
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    // A different body at the same revision+hash path is tampering, not a
    // silent overwrite.
    await writeFile(first.path, "başka içerik");
    await expect(
      publishRevisionFile(root, spaceId, noteId, 1, hash, content),
    ).rejects.toMatchObject({ code: "memory_revision_file_conflict" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 working copy read is tenant-independent and reports its hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-copy-"));
  try {
    const spaceId = uuid(),
      noteId = uuid();
    expect(await readWorkingCopy(root, spaceId, noteId)).toBeNull();
    await atomicWriteFile(
      noteWorkingPath(root, spaceId, noteId),
      "çalışma kopyası",
      { tempDir: tempDir(root) },
    );
    expect(await readWorkingCopy(root, spaceId, noteId)).toMatchObject({
      content: "çalışma kopyası",
      hash: sha256Hex("çalışma kopyası"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 temp GC removes only dead owned temp files, never foreign or live ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-gc-"));
  try {
    const dir = tempDir(root);
    await atomicWriteFile(join(root, "seed"), "x", { tempDir: dir });
    const host = "test-host";
    const dead = tempFileName(424242, host);
    const live = tempFileName(process.pid, host);
    const foreign = tempFileName(424243, "other-host");
    for (const name of [dead, live, foreign])
      await writeFile(join(dir, name), "tmp");
    // Age guard: make everything old enough for the GC window.
    const old = Date.now() - 60_000;
    const { utimes } = await import("node:fs/promises");
    for (const name of [dead, live, foreign])
      await utimes(join(dir, name), old / 1000, old / 1000);
    const removed = await gcTempFiles(root, {
      host,
      isPidAlive: (pid) => pid === process.pid,
      minAgeMs: 1000,
    });
    expect(removed).toEqual([dead]);
    const left = await readdir(dir);
    expect(left).toContain(live);
    expect(left).toContain(foreign);
    expect(left).not.toContain(dead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 quarantine keeps hash and reason, never raw content", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-quarantine-"));
  try {
    const path = await writeQuarantine(root, {
      reason: "symlink",
      hash: HASH_A,
      path: "kök/dış/link.md",
      summary: "Sembolik bağ reddedildi.",
    });
    const { readFile } = await import("node:fs/promises");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(record.reason).toBe("symlink");
    expect(record.hash).toBe(HASH_A);
    expect(record.summary).toBe("Sembolik bağ reddedildi.");
    expect(JSON.stringify(record)).not.toContain("gizli içerik");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 vault root lives under dataDir/memory", () => {
  expect(vaultRoot("/tmp/data")).toBe("/tmp/data/memory");
});
