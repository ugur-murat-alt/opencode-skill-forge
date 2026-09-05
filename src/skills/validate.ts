import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { posix } from "node:path";
import { ForgeError } from "../domain/errors.js";
import { validateInventory, validatePackagePath } from "./paths.js";
export const entrySchema = z
  .object({
    runtime: z.enum(["node", "python", "typescript"]),
    path: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().min(100).max(120000).default(10000),
    memoryMb: z.number().int().min(32).max(1024).default(128),
    maxOutputBytes: z.number().int().min(100).max(1048576).default(65536),
    idempotent: z.boolean().default(false),
    network: z.array(z.string()).max(20).default([]),
    tests: z
      .array(
        z
          .object({
            name: z.string().min(1),
            input: z.unknown(),
            expected: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export const executionManifestSchema = z
  .object({
    version: z.literal(1),
    entrypoints: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), entrySchema)
      .refine(
        (entries) => Object.keys(entries).length <= 8,
        "En fazla 8 giriş desteklenir.",
      ),
    dependencies: z
      .object({
        runtime: z.enum(["node", "python"]),
        lockfile: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  })
  .strict();
export type ExecutionManifest = z.infer<typeof executionManifestSchema>;
export interface PackageManifest {
  name: string;
  description: string;
  hash: string;
  files: { path: string; hash: string; bytes: number }[];
  execution: ExecutionManifest | null;
}
export function validatePackage(
  name: string,
  files: Record<string, Buffer>,
): PackageManifest {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new ForgeError(
      "invalid_skill_name",
      "Skill adı 1–64 karakter lowercase-kebab-case olmalıdır.",
    );
  validateInventory(Object.keys(files));
  const skill = files["SKILL.md"]?.toString("utf8");
  if (!skill || !/^---\r?\n/.test(skill))
    throw new ForgeError(
      "frontmatter_required",
      "SKILL.md frontmatter gerekiyor.",
    );
  const closing = /\r?\n---(?:\r?\n|$)/g;
  closing.lastIndex = 4;
  const end = closing.exec(skill)?.index ?? -1;
  if (end < 0)
    throw new ForgeError("invalid_frontmatter", "Frontmatter kapatılmamış.");
  let meta: { name: string; description: string };
  try {
    meta = z
      .object({
        name: z.literal(name),
        description: z.string().min(1).max(1024),
      })
      .passthrough()
      .parse(parse(skill.slice(4, end), { maxAliasCount: 10 }));
  } catch {
    throw new ForgeError(
      "invalid_frontmatter",
      "Ad/klasör veya description geçersiz.",
    );
  }
  let total = 0;
  const inventory = Object.keys(files)
    .sort()
    .map((path) => {
      const value = files[path]!;
      total += value.length;
      if (total > 4 * 1024 * 1024)
        throw new ForgeError("package_limit", "Paket 4 MiB sınırını aşıyor.");
      return {
        path,
        bytes: value.length,
        hash: createHash("sha256").update(value).digest("hex"),
      };
    });
  for (const [path, value] of Object.entries(files))
    if (path.endsWith(".md")) {
      for (const match of value
        .toString("utf8")
        .matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#")) continue;
        let decoded: string;
        try {
          decoded = decodeURIComponent(link.split("#")[0]!.split("?")[0]!);
        } catch {
          throw new ForgeError(
            "invalid_link",
            "Relative bağlantı kodlaması geçersiz.",
          );
        }
        if (decoded.startsWith("/") || decoded.includes("\\"))
          throw new ForgeError(
            "unsafe_link",
            "Bağlantı paket sınırında kalmalıdır.",
          );
        const target = posix.normalize(
          posix.join(posix.dirname(path), decoded),
        );
        validatePackagePath(target);
        if (!files[target])
          throw new ForgeError(
            "missing_reference",
            `Paket referansı bulunamadı: ${target}`,
          );
      }
    }
  let execution: ExecutionManifest | null = null;
  if (files["forge.json"]) {
    try {
      execution = executionManifestSchema.parse(
        JSON.parse(files["forge.json"].toString("utf8")),
      );
    } catch {
      throw new ForgeError(
        "invalid_manifest",
        "forge.json giriş sözleşmesi geçersiz.",
      );
    }
    for (const entry of Object.values(execution.entrypoints)) {
      validatePackagePath(entry.path);
      if (!files[entry.path] || !entry.path.startsWith("scripts/"))
        throw new ForgeError(
          "invalid_entrypoint",
          "Script girişi scripts/ içindeki bir dosyayı göstermeli.",
        );
    }
    if (execution.dependencies) {
      const dependency = execution.dependencies;
      validatePackagePath(dependency.lockfile);
      if (
        !files[dependency.lockfile] ||
        createHash("sha256")
          .update(files[dependency.lockfile]!)
          .digest("hex") !== dependency.sha256
      )
        throw new ForgeError(
          "dependency_hash_mismatch",
          "Bağımlılık kilidi/hash uyuşmuyor.",
        );
    }
  }
  if (
    Object.keys(files).some((path) => path.startsWith("scripts/")) &&
    (!execution || !Object.keys(execution.entrypoints).length)
  )
    throw new ForgeError(
      "script_manifest_required",
      "Script paketi giriş manifesti gerektirir.",
    );
  return {
    name,
    description: meta.description,
    hash: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    files: inventory,
    execution,
  };
}
