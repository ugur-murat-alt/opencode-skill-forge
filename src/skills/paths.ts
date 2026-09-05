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
/** On Linux, descriptor-relative traversal prevents ancestor replacement races. */
export async function secureRead(
  root: string,
  relativePath: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  validatePackagePath(relativePath);
  root = resolve(root);
  const directoryHandles: Awaited<ReturnType<typeof open>>[] = [];
  let current = root;
  try {
    // Reject redirected ancestors before anchoring the root directory.
    let ancestor = root;
    while (true) {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ForgeError(
          "unsafe_path",
          "Paket kökü symlink/dizin dışı hedef olamaz.",
        );
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const segments = relativePath.split("/");
    for (const segment of ["", ...segments.slice(0, -1)]) {
      if (segment) current = join(current, segment);
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directoryHandles.push(handle);
      if (process.platform === "linux") current = `/proc/self/fd/${handle.fd}`;
    }
    const file = await open(
      join(current, basename(relativePath)),
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
    await Promise.allSettled(directoryHandles.map((handle) => handle.close()));
  }
}
export async function packageInventory(root: string): Promise<string[]> {
  root = resolve(root);
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ForgeError("unsafe_path", "Paket kökü yönlendirilmiş olamaz.");
    if (dirname(ancestor) === ancestor) break;
  }
  const paths: string[] = [];
  let entries = 0;
  async function walk(path: string, depth: number) {
    if (depth > 12)
      throw new ForgeError("package_limit", "Dizin derinliği aşıldı.");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const anchored =
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
      const directory = await opendir(anchored, { bufferSize: 32 });
      for await (const entry of directory) {
        if (++entries > 1280)
          throw new ForgeError(
            "package_limit",
            "Paket dizin/dosya sınırı aşıldı.",
          );
        const relative = relativeParts.length
          ? `${relativeParts.join("/")}/${entry.name}`
          : entry.name;
        validatePackagePath(relative);
        const child = join(anchored, entry.name),
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
          relativeParts.push(entry.name);
          try {
            await walk(child, depth + 1);
          } finally {
            relativeParts.pop();
          }
        } else {
          if (stat.size > 4 * 1024 * 1024)
            throw new ForgeError("package_limit", "Paket dosya boyutu aşıldı.");
          paths.push(relative);
          if (paths.length > 256)
            throw new ForgeError("package_limit", "Paket dosya sınırı aşıldı.");
        }
      }
    } finally {
      await handle.close();
    }
  }
  const relativeParts: string[] = [];
  await walk(resolve(root), 0);
  validateInventory(paths);
  return paths.sort();
}
export async function readPackageDirectory(root: string) {
  const files: Record<string, Buffer> = {};
  let total = 0;
  for (const path of await packageInventory(root)) {
    files[path] = await secureRead(root, path);
    total += files[path]!.length;
    if (total > 4 * 1024 * 1024)
      throw new ForgeError("package_limit", "Paket boyut sınırı aşıldı.");
  }
  return files;
}
