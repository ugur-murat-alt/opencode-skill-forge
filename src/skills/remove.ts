import { constants } from "node:fs";
import { open, lstat, readdir, unlink, rmdir } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { validatePackagePath } from "./paths.js";
import { ForgeError } from "../domain/errors.js";
/** Anchor every parent before recursive removal. No path-only fallback on unsupported OS. */
export async function removeRevision(
  root: string,
  tenant: string,
  path: string,
  skillId: string,
  revision: string,
) {
  if (process.platform !== "linux")
    throw new ForgeError(
      "safe_delete_unavailable",
      "Bu platformda güvenli kalıcı silme adapter'ı hazır değil.",
      503,
    );
  validatePackagePath(path);
  if (
    !path.startsWith(
      `tenants/${createHash("sha256").update(tenant).digest("hex")}/packages/`,
    )
  )
    throw new ForgeError(
      "unsafe_path",
      "Silme yolu tenant paket köküne ait değil.",
    );
  const parts = path.split("/");
  if (
    parts.length !== 8 ||
    !/^[a-f0-9]{20}$/.test(parts[3]!) ||
    parts[4] !== skillId ||
    parts[5] !== "revisions" ||
    parts[6] !== revision ||
    !/^[a-f0-9]{64}$/.test(revision)
  )
    throw new ForgeError(
      "unsafe_path",
      "Silme yolu beklenen skill/revision kimliğiyle eşleşmiyor.",
    );
  root = resolve(root);
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    let current = "/";
    for (const segment of [
      "",
      ...root.split("/").filter(Boolean),
      ...path.split("/").slice(0, -1),
    ]) {
      if (segment) current = join(current, segment);
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    const target = join(current, basename(path));
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ForgeError("unsafe_path", "Revision dizini yönlendirilmiş.");
    let visited = 0;
    async function erase(parent: string, name: string): Promise<void> {
      if (++visited > 10000)
        throw new ForgeError(
          "cleanup_limit",
          "Revision temizlik sınırı aşıldı.",
        );
      try {
        const child = join(parent, name),
          info = await lstat(child);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          await unlink(child);
          return;
        }
        const handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const anchor = `/proc/self/fd/${handle.fd}`;
          for (const entry of await readdir(anchor)) await erase(anchor, entry);
        } finally {
          await handle.close();
        }
        await rmdir(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await erase(current, basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
  }
}
