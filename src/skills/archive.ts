import { unzipSync, zipSync } from "fflate";
import { validateInventory, validatePackagePath } from "./paths.js";
import { validatePackage } from "./validate.js";
import { ForgeError } from "../domain/errors.js";
export function exportPackage(name: string, files: Record<string, Buffer>) {
  validatePackage(name, files);
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, bytes]) => [
          `${name}/${path}`,
          bytes,
        ]),
      ),
      { level: 6 },
    ),
  );
}
export function importPackage(archive: Buffer): {
  name: string;
  files: Record<string, Buffer>;
} {
  if (archive.length > 5 * 1024 * 1024 || archive.length < 22)
    throw new ForgeError("archive_limit", "ZIP boyutu geçersiz.");
  // Read central directory attributes before decompression; reject Unix symlinks/special files and ZIP64.
  let end = -1;
  for (
    let i = archive.length - 22;
    i >= Math.max(0, archive.length - 65557);
    i--
  )
    if (
      archive.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + archive.readUInt16LE(i + 20) === archive.length
    ) {
      end = i;
      break;
    }
  if (end < 0)
    throw new ForgeError("invalid_archive", "ZIP dizini bulunamadı.");
  const count = archive.readUInt16LE(end + 10),
    centralSize = archive.readUInt32LE(end + 12);
  let at = archive.readUInt32LE(end + 16);
  if (
    count > 512 ||
    archive.readUInt16LE(end + 4) ||
    archive.readUInt16LE(end + 6) ||
    count !== archive.readUInt16LE(end + 8) ||
    at + centralSize !== end
  )
    throw new ForgeError(
      "archive_limit",
      "ZIP64/çoklu disk veya dosya sınırı desteklenmiyor.",
    );
  const centralNames: string[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50)
      throw new ForgeError("invalid_archive", "ZIP merkezi kayıt hatalı.");
    const mode = archive.readUInt32LE(at + 38) >>> 16,
      type = mode & 0xf000;
    if (
      (type && type !== 0x8000 && type !== 0x4000) ||
      archive.readUInt16LE(at + 8) & 1
    )
      throw new ForgeError(
        "unsafe_archive",
        "Şifreli, symlink veya özel dosyalı ZIP reddedildi.",
      );
    const length = archive.readUInt16LE(at + 28),
      name = archive.subarray(at + 46, at + 46 + length).toString("utf8");
    if (at + 46 + length > end)
      throw new ForgeError("invalid_archive", "ZIP adı taşmış.");
    validatePackagePath(name.endsWith("/") ? name.slice(0, -1) : name);
    centralNames.push(name);
    at +=
      46 +
      length +
      archive.readUInt16LE(at + 30) +
      archive.readUInt16LE(at + 32);
  }
  if (at !== end || new Set(centralNames).size !== centralNames.length)
    throw new ForgeError(
      "invalid_archive",
      "ZIP dizini yinelenen veya tutarsız kayıt içeriyor.",
    );
  let total = 0;
  const names: string[] = [];
  let extracted;
  try {
    extracted = unzipSync(archive, {
      filter: (file) => {
        if (!centralNames.includes(file.name))
          throw new ForgeError(
            "invalid_archive",
            "ZIP yerel/merkezi envanter uyuşmuyor.",
          );
        if (file.name.endsWith("/")) return false;
        names.push(file.name);
        validateInventory(names);
        total += file.originalSize;
        if (
          total > 4194304 ||
          file.originalSize > 4194304 ||
          ![0, 8].includes(file.compression)
        )
          throw new ForgeError(
            "archive_limit",
            "ZIP açılımı 4 MiB sınırını aşıyor.",
          );
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError("invalid_archive", "ZIP açılamadı.");
  }
  const roots = new Set(names.map((path) => path.split("/")[0]!));
  if (roots.size !== 1 || names.some((path) => !path.includes("/")))
    throw new ForgeError(
      "package_root_required",
      "ZIP tek klasik skill klasörü içermeli.",
    );
  const name = [...roots][0]!,
    files = Object.fromEntries(
      Object.entries(extracted).map(([path, bytes]) => [
        path.slice(name.length + 1),
        Buffer.from(bytes),
      ]),
    );
  validatePackage(name, files);
  return { name, files };
}

/** Untrusted decompression never occupies the service event loop; resource and time limits are real. */
let activeImports = 0;
export async function importPackageBounded(archive: Buffer) {
  if (archive.length > 5 * 1024 * 1024) throw new ForgeError("archive_limit", "ZIP boyutu aşıldı.");
  if (activeImports >= 2) throw new ForgeError("archive_busy", "Paket açma kapasitesi dolu; yeniden deneyin.", 429, 1);
  activeImports++;
  try {
    const { Worker } = await import("node:worker_threads"), { existsSync } = await import("node:fs"), { fileURLToPath } = await import("node:url");
    const built = new URL("./archive-worker.js", import.meta.url), source = new URL("./archive-worker.ts", import.meta.url);
    const worker = new Worker(existsSync(fileURLToPath(built)) ? built : source, { workerData: archive, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    return await new Promise<{ name: string; files: Record<string, Buffer> }>((resolve, reject) => {
      let completed = false;
      const finish = (error?: Error, value?: { name: string; files: Record<string, Buffer> }) => { if (completed) return; completed = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(value!); };
      const timer = setTimeout(() => finish(new ForgeError("archive_timeout", "ZIP açma CPU/süre sınırını aştı.", 422)), 3000);
      worker.once("message", value => { if (!value.ok) finish(new ForgeError(value.code, value.message)); else finish(undefined, { name: value.name, files: Object.fromEntries(Object.entries(value.files).map(([path, bytes]) => [path, Buffer.from(bytes as Uint8Array)])) }); });
      worker.once("error", () => finish(new ForgeError("archive_worker_failed", "İzole arşiv işçisi başarısız.", 422)));
      worker.once("exit", () => { if (!completed) finish(new ForgeError("archive_worker_failed", "Arşiv işçisi sonuç üretmeden kapandı.", 422)); });
    });
  } finally { activeImports--; }
}
