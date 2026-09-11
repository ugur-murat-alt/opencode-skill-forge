import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "../../storage/schema.js";
import { ForgeError } from "../../domain/errors.js";
import type { MemoryCuratePayload } from "../../domain/curator.js";

/**
 * Issue #39 (M06): `source_read` backend.
 *
 * The tool can only read files that belong to a source registered to the
 * job's memory space, and only with a path relative to that registered root.
 * Absolute host paths, `..` escapes and symlinked targets are rejected; the
 * read is byte-bounded.
 */

export interface CuratorSourceExcerpt {
  source_id: string;
  path: string | null;
  section: string | null;
  text: string;
  hash: string;
  bytes: number;
  truncated: boolean;
}

export function sourceRefKey(ref: {
  source_id: string;
  path?: string | null;
  section?: string | null;
}): string {
  return `${ref.source_id}\u0000${ref.path ?? ""}\u0000${ref.section ?? ""}`;
}

function extractSection(text: string, section: string): string {
  const lines = text.split("\n");
  const wanted = section.trim().toLowerCase();
  let start = -1;
  let level = 7;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]!.trim());
    if (match && match[2]!.trim().toLowerCase() === wanted) {
      start = index;
      level = match[1]!.length;
      break;
    }
  }
  if (start < 0)
    throw new ForgeError(
      "memory_source_unavailable",
      "İstenen bölüm kaynakta bulunamadı.",
      422,
    );
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]!.trim());
    if (match && match[1]!.length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export class CuratorSourceReader {
  private readonly allowed: Set<string>;
  constructor(
    readonly db: Kysely<DB>,
    readonly tenantId: string,
    readonly spaceId: string,
    readonly refs: MemoryCuratePayload["source_refs"],
    readonly maxBytes: number,
  ) {
    this.allowed = new Set(refs.map(sourceRefKey));
  }

  async readAll(): Promise<{
    excerpts: CuratorSourceExcerpt[];
    fingerprint: string;
  }> {
    const excerpts: CuratorSourceExcerpt[] = [];
    for (const ref of this.refs) excerpts.push(await this.readOne(ref));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          excerpts
            .map((excerpt) => ({
              source_id: excerpt.source_id,
              path: excerpt.path,
              section: excerpt.section,
              hash: excerpt.hash,
            }))
            .sort((a, b) =>
              `${a.source_id}${a.path}${a.section}`.localeCompare(
                `${b.source_id}${b.path}${b.section}`,
              ),
            ),
        ),
      )
      .digest("hex");
    return { excerpts, fingerprint };
  }

  async readOne(
    ref: MemoryCuratePayload["source_refs"][number],
  ): Promise<CuratorSourceExcerpt> {
    if (!this.allowed.has(sourceRefKey(ref)))
      throw new ForgeError(
        "invalid_input",
        "Kaynak bu işin yetkili referansları arasında değil.",
        403,
      );
    if (ref.path && (isAbsolute(ref.path) || ref.path.includes("\0")))
      throw new ForgeError(
        "invalid_input",
        "Kaynak yolu göreli olmalıdır.",
        403,
      );
    const row = await this.db
      .selectFrom("memory_sources")
      .select(["id", "root_path"])
      .where("tenant_id", "=", this.tenantId)
      .where("space_id", "=", this.spaceId)
      .where("id", "=", ref.source_id)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "memory_source_unavailable",
        "Kaynak bu hafıza alanında kayıtlı değil.",
        404,
      );
    const root = await realpath(row.root_path).catch(() => null);
    if (!root)
      throw new ForgeError(
        "memory_source_unavailable",
        "Kaynak kökü okunamadı.",
        404,
      );
    const target = ref.path ? resolve(root, ref.path) : root;
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new ForgeError(
        "invalid_input",
        "Kaynak yolu kök dışına çıkıyor.",
        403,
      );
    const stat = await lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink())
      throw new ForgeError(
        "memory_source_unavailable",
        "Kaynak dosyası okunamadı.",
        404,
      );
    const handle = await open(target, "r");
    let raw: Buffer;
    try {
      const buffer = Buffer.allocUnsafe(this.maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, this.maxBytes + 1, 0);
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const truncated = raw.byteLength > this.maxBytes;
    let text = raw.subarray(0, this.maxBytes).toString("utf8");
    if (ref.section) text = extractSection(text, ref.section);
    return {
      source_id: ref.source_id,
      path: ref.path ?? null,
      section: ref.section ?? null,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
      truncated,
    };
  }
}
