// src/skills/archive-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/skills/archive.ts
import { unzipSync, zipSync } from "fflate";

// src/domain/errors.ts
class ForgeError extends Error {
  code;
  status;
  retryAfter;
  constructor(code, message, status = 400, retryAfter) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.name = "ForgeError";
  }
}

// src/skills/paths.ts
function validatePackagePath(path) {
  if (!path || path.length > 500 || path !== path.normalize("NFC") || path.includes("\\") || path.startsWith("/") || /[\x00-\x1f\x7f<>:"|?*]/.test(path))
    throw new ForgeError("unsafe_path", "Paket yolu geçersiz.");
  for (const segment of path.split("/"))
    if (!segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment) || segment.toLowerCase() === ".git")
      throw new ForgeError("unsafe_path", "Paket yolu platformda güvenli değil.");
  return path;
}
function validateInventory(paths) {
  if (paths.length > 256)
    throw new ForgeError("package_limit", "Paket en fazla 256 dosya içerebilir.");
  const seen = new Set;
  for (const path of paths) {
    validatePackagePath(path);
    const folded = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(folded))
      throw new ForgeError("path_collision", "Unicode veya case çakışan paket yolu.");
    seen.add(folded);
    for (const other of paths)
      if (other !== path && other.toLowerCase().startsWith(`${path.toLowerCase()}/`))
        throw new ForgeError("path_collision", "Aynı yol hem dosya hem dizin olamaz.");
  }
}

// src/skills/validate.ts
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { posix } from "node:path";
var entrySchema = z.object({
  runtime: z.enum(["node", "python", "typescript"]),
  path: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().min(100).max(120000).default(1e4),
  memoryMb: z.number().int().min(32).max(1024).default(128),
  maxOutputBytes: z.number().int().min(100).max(1048576).default(65536),
  idempotent: z.boolean().default(false),
  network: z.array(z.string()).max(20).default([]),
  tests: z.array(z.object({
    name: z.string().min(1),
    input: z.unknown(),
    expected: z.unknown()
  }).strict()).min(1).max(30)
}).strict();
var executionManifestSchema = z.object({
  version: z.literal(1),
  entrypoints: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), entrySchema).refine((entries) => Object.keys(entries).length <= 8, "En fazla 8 giriş desteklenir."),
  dependencies: z.object({
    runtime: z.enum(["node", "python"]),
    lockfile: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).optional()
}).strict();
function validatePackage(name, files) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new ForgeError("invalid_skill_name", "Skill adı 1–64 karakter lowercase-kebab-case olmalıdır.");
  validateInventory(Object.keys(files));
  const skill = files["SKILL.md"]?.toString("utf8");
  if (!skill || !/^---\r?\n/.test(skill))
    throw new ForgeError("frontmatter_required", "SKILL.md frontmatter gerekiyor.");
  const closing = /\r?\n---(?:\r?\n|$)/g;
  closing.lastIndex = 4;
  const end = closing.exec(skill)?.index ?? -1;
  if (end < 0)
    throw new ForgeError("invalid_frontmatter", "Frontmatter kapatılmamış.");
  let meta;
  try {
    meta = z.object({
      name: z.literal(name),
      description: z.string().min(1).max(1024)
    }).passthrough().parse(parse(skill.slice(4, end), { maxAliasCount: 10 }));
  } catch {
    throw new ForgeError("invalid_frontmatter", "Ad/klasör veya description geçersiz.");
  }
  let total = 0;
  const inventory = Object.keys(files).sort().map((path) => {
    const value = files[path];
    total += value.length;
    if (total > 4 * 1024 * 1024)
      throw new ForgeError("package_limit", "Paket 4 MiB sınırını aşıyor.");
    return {
      path,
      bytes: value.length,
      hash: createHash("sha256").update(value).digest("hex")
    };
  });
  for (const [path, value] of Object.entries(files))
    if (path.endsWith(".md")) {
      for (const match of value.toString("utf8").matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#"))
          continue;
        let decoded;
        try {
          decoded = decodeURIComponent(link.split("#")[0].split("?")[0]);
        } catch {
          throw new ForgeError("invalid_link", "Relative bağlantı kodlaması geçersiz.");
        }
        if (decoded.startsWith("/") || decoded.includes("\\"))
          throw new ForgeError("unsafe_link", "Bağlantı paket sınırında kalmalıdır.");
        const target = posix.normalize(posix.join(posix.dirname(path), decoded));
        validatePackagePath(target);
        if (!files[target])
          throw new ForgeError("missing_reference", `Paket referansı bulunamadı: ${target}`);
      }
    }
  let execution = null;
  if (files["forge.json"]) {
    try {
      execution = executionManifestSchema.parse(JSON.parse(files["forge.json"].toString("utf8")));
    } catch {
      throw new ForgeError("invalid_manifest", "forge.json giriş sözleşmesi geçersiz.");
    }
    for (const entry of Object.values(execution.entrypoints)) {
      validatePackagePath(entry.path);
      if (!files[entry.path] || !entry.path.startsWith("scripts/"))
        throw new ForgeError("invalid_entrypoint", "Script girişi scripts/ içindeki bir dosyayı göstermeli.");
    }
    if (execution.dependencies) {
      const dependency = execution.dependencies;
      validatePackagePath(dependency.lockfile);
      if (!files[dependency.lockfile] || createHash("sha256").update(files[dependency.lockfile]).digest("hex") !== dependency.sha256)
        throw new ForgeError("dependency_hash_mismatch", "Bağımlılık kilidi/hash uyuşmuyor.");
    }
  }
  if (Object.keys(files).some((path) => path.startsWith("scripts/")) && (!execution || !Object.keys(execution.entrypoints).length))
    throw new ForgeError("script_manifest_required", "Script paketi giriş manifesti gerektirir.");
  return {
    name,
    description: meta.description,
    hash: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    files: inventory,
    execution
  };
}

// src/skills/archive.ts
function importPackage(archive) {
  if (archive.length > 5 * 1024 * 1024 || archive.length < 22)
    throw new ForgeError("archive_limit", "ZIP boyutu geçersiz.");
  let end = -1;
  for (let i = archive.length - 22;i >= Math.max(0, archive.length - 65557); i--)
    if (archive.readUInt32LE(i) === 101010256 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) {
      end = i;
      break;
    }
  if (end < 0)
    throw new ForgeError("invalid_archive", "ZIP dizini bulunamadı.");
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12);
  let at = archive.readUInt32LE(end + 16);
  if (count > 512 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || count !== archive.readUInt16LE(end + 8) || at + centralSize !== end)
    throw new ForgeError("archive_limit", "ZIP64/çoklu disk veya dosya sınırı desteklenmiyor.");
  const centralNames = [];
  for (let i = 0;i < count; i++) {
    if (at + 46 > end || archive.readUInt32LE(at) !== 33639248)
      throw new ForgeError("invalid_archive", "ZIP merkezi kayıt hatalı.");
    const mode = archive.readUInt32LE(at + 38) >>> 16, type = mode & 61440;
    if (type && type !== 32768 && type !== 16384 || archive.readUInt16LE(at + 8) & 1)
      throw new ForgeError("unsafe_archive", "Şifreli, symlink veya özel dosyalı ZIP reddedildi.");
    const length = archive.readUInt16LE(at + 28), name2 = archive.subarray(at + 46, at + 46 + length).toString("utf8");
    if (at + 46 + length > end)
      throw new ForgeError("invalid_archive", "ZIP adı taşmış.");
    validatePackagePath(name2.endsWith("/") ? name2.slice(0, -1) : name2);
    centralNames.push(name2);
    at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  if (at !== end || new Set(centralNames).size !== centralNames.length)
    throw new ForgeError("invalid_archive", "ZIP dizini yinelenen veya tutarsız kayıt içeriyor.");
  let total = 0;
  const names = [];
  let extracted;
  try {
    extracted = unzipSync(archive, {
      filter: (file) => {
        if (!centralNames.includes(file.name))
          throw new ForgeError("invalid_archive", "ZIP yerel/merkezi envanter uyuşmuyor.");
        if (file.name.endsWith("/"))
          return false;
        names.push(file.name);
        validateInventory(names);
        total += file.originalSize;
        if (total > 4194304 || file.originalSize > 4194304 || ![0, 8].includes(file.compression))
          throw new ForgeError("archive_limit", "ZIP açılımı 4 MiB sınırını aşıyor.");
        return true;
      }
    });
  } catch (error) {
    if (error instanceof ForgeError)
      throw error;
    throw new ForgeError("invalid_archive", "ZIP açılamadı.");
  }
  const roots = new Set(names.map((path) => path.split("/")[0]));
  if (roots.size !== 1 || names.some((path) => !path.includes("/")))
    throw new ForgeError("package_root_required", "ZIP tek klasik skill klasörü içermeli.");
  const name = [...roots][0], files = Object.fromEntries(Object.entries(extracted).map(([path, bytes]) => [
    path.slice(name.length + 1),
    Buffer.from(bytes)
  ]));
  validatePackage(name, files);
  return { name, files };
}

// src/skills/archive-worker.ts
try {
  const result = importPackage(Buffer.from(workerData));
  parentPort?.postMessage({ ok: true, name: result.name, files: result.files });
} catch (error) {
  parentPort?.postMessage({ ok: false, code: error instanceof ForgeError ? error.code : "invalid_archive", message: error instanceof ForgeError ? error.message : "ZIP açılamadı." });
}
