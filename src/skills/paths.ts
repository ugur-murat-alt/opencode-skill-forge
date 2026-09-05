import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { ForgeError } from "../domain/errors.js";
export function validatePackagePath(path: string): string {
  if (
    !path ||
    path.length > 500 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    // Reject control bytes in package paths, including NUL.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f<>:"|?*]/.test(path)
  )
    throw new ForgeError("unsafe_path", "Paket yolu geçersiz.");
  for (const segment of path.split("/"))
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment) ||
      segment.toLowerCase() === ".git"
    )
      throw new ForgeError(
        "unsafe_path",
        "Paket yolu platformda güvenli değil.",
      );
  return path;
}
export function validateInventory(paths: string[]) {
  if (paths.length > 256)
    throw new ForgeError(
      "package_limit",
      "Paket en fazla 256 dosya içerebilir.",
    );
  const seen = new Set<string>();
  for (const path of paths) {
    validatePackagePath(path);
    const folded = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(folded))
      throw new ForgeError(
        "path_collision",
        "Unicode veya case çakışan paket yolu.",
      );
    seen.add(folded);
    for (const other of paths)
      if (
        other !== path &&
        other.toLowerCase().startsWith(`${path.toLowerCase()}/`)
      )
        throw new ForgeError(
          "path_collision",
          "Aynı yol hem dosya hem dizin olamaz.",
        );
  }
}
export interface PackageDirectoryReader {
  read(path: string, maxBytes?: number): Promise<Buffer>;
  inventory(): Promise<string[]>;
}
/** Hold the same root inode for inventory and reads; never retain package contents. */
export async function withPackageDirectory<T>(
  root: string,
  callback: (reader: PackageDirectoryReader) => Promise<T>,
): Promise<T> {
  root = resolve(root);
  const roots: Awaited<ReturnType<typeof open>>[] = [];
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  try {
    let anchor = root;
    if (process.platform === "linux") {
      anchor = "/";
      for (const segment of ["", ...root.split("/").filter(Boolean)]) {
        const handle = await open(
          segment ? join(anchor, segment) : anchor,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOTDIR" || error.code === "ELOOP")
            throw new ForgeError(
              "unsafe_path",
              "Paket kökü yönlendirilmiş veya dizin dışı olamaz.",
            );
          throw error;
        });
        roots.push(handle);
        anchor = `/proc/self/fd/${handle.fd}`;
        // The child descriptor now owns the path anchor; ancestors need not stay open.
        if (roots.length > 1) {
          await roots[0]!.close();
          roots.shift();
        }
      }
    } else {
      for (let ancestor = root; ; ancestor = dirname(ancestor)) {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ForgeError(
            "unsafe_path",
            "Paket kökü yönlendirilmiş olamaz.",
          );
        if (dirname(ancestor) === ancestor) break;
      }
      roots.push(
        await open(
          root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
    }
    function tracked<R>(run: () => Promise<R>): Promise<R> {
      if (closed)
        return Promise.reject(
          new ForgeError("reader_closed", "Paket okuyucusu kapandı."),
        );
      const operation = run();
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    }
    const reader: PackageDirectoryReader = {
      read: (path, maxBytes = 4 * 1024 * 1024) =>
        tracked(() => readAnchored(anchor, path, maxBytes)),
      inventory: () => tracked(() => inventoryAnchored(anchor)),
    };
    return await callback(reader);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "unsafe_or_missing_file",
      "Paket dizini güvenli biçimde okunamadı.",
      422,
    );
  } finally {
    closed = true;
    await Promise.allSettled(pending);
    await Promise.allSettled(roots.reverse().map((handle) => handle.close()));
  }
}
async function readAnchored(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  validatePackagePath(path);
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  let current = root;
  try {
    for (const segment of path.split("/").slice(0, -1)) {
      const handle = await open(
        join(current, segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      if (handles.length > 1) {
        await handles[0]!.close();
        handles.shift();
      }
      current =
        process.platform === "linux"
          ? `/proc/self/fd/${handle.fd}`
          : join(current, segment);
    }
    const file = await open(
      join(current, basename(path)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
        throw new ForgeError(
          "unsafe_file",
          "Dosya tipi/link sayısı/boyutu güvenli değil.",
        );
      const bytes = await file.readFile();
      const after = await file.stat();
      if (
        bytes.length > maxBytes ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new ForgeError(
          "file_changed",
          "Dosya okuma sırasında değişti.",
          409,
        );
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "unsafe_or_missing_file",
      "Paket dosyası güvenli biçimde okunamadı.",
      422,
    );
  } finally {
    await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
  }
}
async function inventoryAnchored(root: string): Promise<string[]> {
  const paths: string[] = [],
    relativeParts: string[] = [];
  let entries = 0;
  async function walk(anchor: string, depth: number) {
    if (depth > 12)
      throw new ForgeError("package_limit", "Dizin derinliği aşıldı.");
    const directory = await opendir(anchor, { bufferSize: 32 });
    for await (const entry of directory) {
      if (++entries > 1280)
        throw new ForgeError(
          "package_limit",
          "Paket dizin/dosya sınırı aşıldı.",
        );
      const relative = [...relativeParts, entry.name].join("/");
      validatePackagePath(relative);
      const child = join(anchor, entry.name),
        stat = await lstat(child);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new ForgeError(
          "unsafe_file",
          "Paket link veya özel dosya içeremez.",
        );
      if (stat.isDirectory()) {
        const handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        relativeParts.push(entry.name);
        try {
          await walk(
            process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : child,
            depth + 1,
          );
        } finally {
          relativeParts.pop();
          await handle.close();
        }
      } else {
        if (stat.size > 4 * 1024 * 1024)
          throw new ForgeError("package_limit", "Paket dosya boyutu aşıldı.");
        paths.push(relative);
        if (paths.length > 256)
          throw new ForgeError("package_limit", "Paket dosya sınırı aşıldı.");
      }
    }
  }
  await walk(root, 0);
  validateInventory(paths);
  return paths.sort();
}
export async function secureRead(
  root: string,
  relativePath: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  validatePackagePath(relativePath);
  return withPackageDirectory(root, (reader) =>
    reader.read(relativePath, maxBytes),
  );
}
export async function packageInventory(root: string): Promise<string[]> {
  return withPackageDirectory(root, (reader) => reader.inventory());
}
export async function readPackageDirectory(root: string) {
  return withPackageDirectory(root, async (reader) => {
    const files: Record<string, Buffer> = {};
    let total = 0;
    for (const path of await reader.inventory()) {
      files[path] = await reader.read(path);
      total += files[path]!.length;
      if (total > 4 * 1024 * 1024)
        throw new ForgeError("package_limit", "Paket boyut sınırı aşıldı.");
    }
    return files;
  });
}
