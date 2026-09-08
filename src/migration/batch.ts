import type { RemoteMigrationResult } from "./remote.js";
import { exportPackage } from "../skills/archive.js";
import { readPackageDirectory } from "../skills/paths.js";
import { createHash } from "node:crypto";
import { resolve, dirname, basename } from "node:path";
import { z } from "zod";
import { secureRead } from "../skills/paths.js";
import { MigrationImporter } from "./importer.js";
import type { Identity } from "../application/identity.js";
import { ForgeError, errorEnvelope } from "../domain/errors.js";
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export async function readMigrationJson(path: string) {
  const absolute = resolve(path);
  return JSON.parse(
    (
      await secureRead(dirname(absolute), basename(absolute), 16 * 1024 * 1024)
    ).toString("utf8"),
  ) as unknown;
}
export async function importDiscovery(
  importer: MigrationImporter | undefined,
  actor: Identity | undefined,
  rawManifest: unknown,
  rawMapping: unknown,
  upload?: (body: Record<string, unknown>) => Promise<RemoteMigrationResult>,
) {
  if (!upload && (!importer || !actor))
    throw new ForgeError(
      "migration_identity_required",
      "Yerel aktarım kimliği eksik.",
    );
  const manifest = z
    .object({
      version: z.literal(1),
      mode: z.literal("read_only"),
      checksum: sha,
      truncated: z.boolean(),
      roots: z.array(z.object({ id: z.string(), path: z.string() })).max(6),
      items: z.array(z.unknown()).max(100000),
    })
    .parse(rawManifest);
  if (digest(JSON.stringify(manifest.items)) !== manifest.checksum)
    throw new ForgeError(
      "manifest_changed",
      "Keşif manifest checksum uyuşmuyor.",
      409,
    );
  const mapping = (() => {
    try {
      return z
        .object({
          version: z.literal(1),
          owner: z.literal(upload ? "authenticated-user" : "local-owner"),
          project_ref: z.string().min(1),
          manifest_checksum: sha,
          items: z
            .array(
              z
                .object({
                  source_id: sha,
                  flags: z
                    .object({
                      managed: z.boolean(),
                      protected: z.boolean(),
                      pinned: z.boolean(),
                    })
                    .strict()
                    .optional(),
                  sessions: z.never().optional(),
                  rewrites: z.never().optional(),
                  learning: z.never().optional(),
                })
                .strict(),
            )
            .min(1)
            .max(10000),
        })
        .strict()
        .parse(rawMapping);
    } catch (error) {
      const issues =
        error && typeof error === "object" && "issues" in error
          ? (error as { issues: unknown }).issues
          : undefined;
      throw new ForgeError(
        "invalid_mapping",
        "Eşleme beklenen paket seçim şemasına uymuyor.",
        400,
        undefined,
        issues ?? undefined,
      );
    }
  })();
  if (mapping.manifest_checksum !== manifest.checksum)
    throw new ForgeError(
      "mapping_changed",
      "Eşleme başka bir keşif manifestine ait.",
      409,
    );
  const selected = new Set(mapping.items.map((x) => x.source_id));
  if (selected.size !== mapping.items.length)
    throw new ForgeError(
      "duplicate_mapping",
      "Aynı kaynak birden fazla seçilemez.",
    );
  const itemSchema = z.object({
    source_id: sha,
    source: z.string(),
    path: z.string(),
    kind: z.literal("package"),
    target_scope: z.enum(["project", "personal"]),
    status: z.enum(["ready", "review_required", "unreadable"]),
    checksum: sha.optional(),
    reason: z.string().optional(),
  });
  const items = new Map<string, z.infer<typeof itemSchema>>();
  for (const raw of manifest.items) {
    const item = itemSchema.parse(raw);
    if (items.has(item.source_id))
      throw new ForgeError(
        "duplicate_source",
        "Manifest kaynak kimliği tekrarlanıyor.",
      );
    items.set(item.source_id, item);
  }
  const roots = new Map(manifest.roots.map((root) => [root.id, root.path]));
  if (roots.size !== manifest.roots.length)
    throw new ForgeError(
      "duplicate_root",
      "Manifest kök kimliği tekrarlanıyor.",
    );
  const results = [];
  for (const selection of mapping.items) {
    try {
      const item = items.get(selection.source_id);
      if (!item || !item.checksum || item.status === "unreadable")
        throw new ForgeError(
          "package_not_importable",
          "Kaynak okunabilir paket değil.",
        );
      const root = roots.get(item.source);
      if (!root || digest(`${resolve(root)}\0${item.path}`) !== item.source_id)
        throw new ForgeError(
          "source_mapping_invalid",
          "Kaynak kök/kimlik eşlemesi geçersiz.",
        );
      if (
        !selection.flags ||
        selection.learning ||
        selection.rewrites ||
        selection.sessions
      )
        throw new ForgeError(
          "package_mapping_required",
          "Paket için üç açık yönetim bayrağı gerekiyor.",
        );
      const expectedScope =
        item.source === "project-skills"
          ? "project"
          : ["home-skills", "home-config-skills"].includes(item.source)
            ? "personal"
            : undefined;
      if (!expectedScope || expectedScope !== item.target_scope)
        throw new ForgeError(
          "scope_mapping_invalid",
          "Ev verisi kişisel kalmalı; kaynak kapsamı değiştirilemez.",
        );
      if (item.reason?.includes("collision"))
        throw new ForgeError(
          "source_collision",
          "Kaynak ad çakışması çözülmeli.",
        );
      let result;
      if (upload) {
        const files = await readPackageDirectory(resolve(root, item.path));
        const manifest = Object.keys(files)
          .sort()
          .map((path) => ({
            path,
            bytes: files[path]!.length,
            sha256: digest(files[path]!),
          }));
        if (digest(JSON.stringify(manifest)) !== item.checksum)
          throw new ForgeError(
            "source_changed",
            "Kaynak paket checksum değişti.",
            409,
          );
        result = await upload({
          kind: "package",
          project_ref: mapping.project_ref,
          source_id: item.source_id,
          checksum: item.checksum,
          content_base64: exportPackage(item.path, files).toString("base64"),
          scope: expectedScope,
          flags: selection.flags,
        });
      } else {
        result = await importer!.importPackage(actor!, {
          source_root: root,
          path: item.path,
          checksum: item.checksum,
          scope: expectedScope,
          project_ref: mapping.project_ref,
          flags: selection.flags,
        });
      }
      results.push({
        source_id: selection.source_id,
        status: "recorded",
        ...result,
      });
    } catch (error) {
      results.push({
        source_id: selection.source_id,
        status: "failed",
        ...errorEnvelope(error),
      });
    }
  }
  return {
    version: 1,
    manifest_checksum: manifest.checksum,
    project_ref: mapping.project_ref,
    source_truncated: manifest.truncated,
    selected: results.length,
    failed: results.filter((x) => x.status !== "recorded").length,
    results,
  };
}
