import { test, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  publishRevisionFile,
  sha256Hex,
} from "../src/memory/files.js";
import {
  noteWorkingPath,
  revisionDir,
  revisionPath,
  safeJoin,
  spaceRoot,
  tempDir,
  vaultRoot,
  writerLockPath,
} from "../src/memory/paths.js";

/**
 * Bağımsız M02 (#35) dosya katmanı testleri.
 *
 * Pozitifler: atomik yazım geçici dosya bırakmaz, aynı revision yolu farklı
 * içerikle ezilmez, safeJoin kök dışına çıkmaz.
 *
 * Açık uç (`test.failing`): vault içindeki bir ara dizin symlink'e
 * çevrildiğinde `publishRevisionFile` dosyayı vault kökünün dışına yazar;
 * yazma yolu symlink ara dizinleri reddetmiyor (okuma/tarama reddediyor).
 */

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
  throw new Error("hata beklenirken çağrı başarılı oldu");
}

test("#35 bağımsız: atomik yazım geçici dosya bırakmaz ve içeriği değiştirir", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-files-"));
  try {
    const target = join(root, "hedef.md");
    await atomicWriteFile(target, "birinci");
    await atomicWriteFile(target, "ikinci");
    expect(await Bun.file(target).text()).toBe("ikinci");
    expect(await readdir(root)).toEqual(["hedef.md"]);
    expect(await readdir(tempDir(root)).catch(() => [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 bağımsız: aynı revision yolu farklı baytlarla ezilmez", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-files-"));
  try {
    const spaceId = "space-1";
    const noteId = "note-1";
    const content = "---\nformat_version: 1\n---\nGövde.\n";
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
    const again = await publishRevisionFile(
      root,
      spaceId,
      noteId,
      1,
      hash,
      content,
    );
    expect(again.created).toBe(false);
    // Aynı yol, farklı içerik: ezme yok, açık 409.
    await writeFile(first.path, "kurcalanmış");
    const conflict = await rejection(() =>
      publishRevisionFile(root, spaceId, noteId, 1, hash, content),
    );
    expect(conflict.code).toBe("memory_revision_file_conflict");
    expect(conflict.status).toBe(409);
    expect(await Bun.file(first.path).text()).toBe("kurcalanmış");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 bağımsız: safeJoin kök dışına çıkmaz", () => {
  const root = "/tmp/safe-join-root";
  expect(safeJoin(root, "a", "b.md")).toBe(join(root, "a", "b.md"));
  for (const bad of ["..", ".", "../x", "/etc/passwd", "a/../..", "a\\b"]) {
    expect(() => safeJoin(root, bad)).toThrow();
  }
  expect(() => safeJoin(root, "a", "")).toThrow();
  expect(vaultRoot("/tmp/d")).toBe(join("/tmp/d", "memory"));
  expect(noteWorkingPath(root, "s", "n").startsWith(`${root}/`)).toBe(true);
  expect(writerLockPath(root)).toBe(join(root, ".writer.lock"));
});

test.failing(
  "#35 bağımsız (bekleyen): symlink'li ara dizin üzerinden vault dışına yazılmamalı",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "forge-m02-files-sym-"));
    const outside = await mkdtemp(join(tmpdir(), "forge-m02-files-out-"));
    try {
      const spaceId = "space-1";
      const noteId = "note-1";
      const content = "---\nformat_version: 1\n---\nGövde.\n";
      const hash = sha256Hex(content);
      await mkdir(spaceRoot(vault, spaceId), { recursive: true });
      await mkdir(join(spaceRoot(vault, spaceId), "revisions"), {
        recursive: true,
      });
      await symlink(outside, revisionDir(vault, spaceId, noteId));
      let threw = false;
      try {
        await publishRevisionFile(vault, spaceId, noteId, 1, hash, content);
      } catch {
        threw = true;
      }
      const outsideEntries = await readdir(outside);
      // Yazım ya reddedilmeli ya da vault dışına dosya bırakmamalı.
      expect(threw || outsideEntries.length === 0).toBe(true);
      // Dosyanın beklenen vault yolu gerçekten symlink olmayan bir dizin
      // olmalı; aksi halde okuma tarafı da yolu çözemez.
      expect(revisionPath(vault, spaceId, noteId, 1, hash)).toContain(
        "revisions",
      );
    } finally {
      await rm(vault, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
  15000,
);
