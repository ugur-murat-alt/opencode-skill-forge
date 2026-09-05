import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import {
  readPackageDirectory,
  secureRead,
  validatePackagePath,
} from "../skills/paths.js";
import { validatePackage } from "../skills/validate.js";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type DiscoveryItem = {
  source_id: string;
  source: string;
  path: string;
  kind: "package" | "state";
  target_scope: "project" | "personal";
  status: "ready" | "review_required" | "unreadable";
  checksum?: string;
  files?: { path: string; bytes: number; sha256: string }[];
  reason?: string;
  summary?: { records: number; malformed: number };
  duplicate_of?: string;
};
export async function discoverLegacy(input: {
  projectRoot: string;
  home?: string;
  maxEntries?: number;
}) {
  const maxEntries = input.maxEntries ?? 4096;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000)
    throw Error("scan_limit must be 1–100000");
  const project = resolve(input.projectRoot),
    home = resolve(input.home ?? homedir());
  const sources = [
    {
      id: "project-skills",
      path: join(project, ".opencode", "skills"),
      kind: "package" as const,
      scope: "project" as const,
    },
    {
      id: "home-config-skills",
      path: join(home, ".config", "opencode", "skills"),
      kind: "package" as const,
      scope: "personal" as const,
    },
    {
      id: "home-skills",
      path: join(home, ".opencode", "skills"),
      kind: "package" as const,
      scope: "personal" as const,
    },
    {
      id: "project-state",
      path: join(project, ".opencode", ".skill-power"),
      kind: "state" as const,
      scope: "project" as const,
    },
    {
      id: "home-state",
      path: join(home, ".opencode", ".skill-power"),
      kind: "state" as const,
      scope: "personal" as const,
    },
    {
      id: "home-config-state",
      path: join(home, ".config", "opencode", ".skill-power"),
      kind: "state" as const,
      scope: "personal" as const,
    },
  ];
  const items: DiscoveryItem[] = [],
    roots: { id: string; path: string; status: string }[] = [];
  let entries = 0,
    totalBytes = 0,
    truncated = false;
  const checksums = new Map<string, string>();
  for (const source of sources) {
    if (entries >= maxEntries || totalBytes > 128 * 1024 * 1024) {
      truncated = true;
      roots.push({
        id: source.id,
        path: source.path,
        status: "not_scanned_limit",
      });
      continue;
    }
    try {
      for (
        let ancestor = resolve(source.path);
        ;
        ancestor = dirname(ancestor)
      ) {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw Error("unsafe_root");
        if (dirname(ancestor) === ancestor) break;
      }
      const stat = await lstat(source.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        roots.push({ id: source.id, path: source.path, status: "unsafe_root" });
        continue;
      }
    } catch (error) {
      roots.push({
        id: source.id,
        path: source.path,
        status:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "absent"
            : "unreadable",
      });
      continue;
    }
    roots.push({ id: source.id, path: source.path, status: "scanned" });
    const names = new Set<string>();
    async function walk(relative: string, depth: number) {
      if (depth > 12) {
        truncated = true;
        return;
      }
      const directory = await opendir(join(source.path, relative), {
        bufferSize: 32,
      });
      for await (const entry of directory) {
        if (++entries > maxEntries || totalBytes > 128 * 1024 * 1024) {
          truncated = true;
          return;
        }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const item: DiscoveryItem = {
          source_id: digest(`${source.path}\0${path}`),
          source: source.id,
          path,
          kind: source.kind,
          target_scope: source.scope,
          status: "unreadable",
        };
        try {
          validatePackagePath(path);
          if (
            entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())
          )
            throw Error("unsafe_file");
          if (source.kind === "state" && entry.isDirectory()) {
            await walk(path, depth + 1);
            continue;
          }
          if (source.kind === "package" && !entry.isDirectory())
            throw Error("unexpected_root_file");
          if (source.kind === "package") {
            const folded = entry.name.normalize("NFKC").toLowerCase();
            const collision = names.has(folded);
            names.add(folded);
            const files = await readPackageDirectory(join(source.path, path));
            item.files = Object.keys(files)
              .sort()
              .map((path) => ({
                path,
                bytes: files[path]!.length,
                sha256: digest(files[path]!),
              }));
            totalBytes += item.files.reduce((n, file) => n + file.bytes, 0);
            item.checksum = digest(JSON.stringify(item.files));
            try {
              validatePackage(entry.name, files);
              item.status = collision ? "review_required" : "ready";
              if (collision) item.reason = "case_collision";
            } catch (error) {
              item.status = "review_required";
              item.reason =
                (error as { code?: string }).code ?? "invalid_package";
            }
          } else {
            if (/(?:learn\.md|rewrites\.jsonl|session-flags\.json)$/.test(path))
              item.target_scope = "personal";
            const bytes = await secureRead(source.path, path, 16 * 1024 * 1024);
            totalBytes += bytes.length;
            item.checksum = digest(bytes);
            item.files = [{ path, bytes: bytes.length, sha256: item.checksum }];
            item.status = "review_required";
            if (path.endsWith(".jsonl")) {
              let records = 0,
                malformed = 0;
              for (const line of bytes
                .toString("utf8")
                .split(/\r?\n/)
                .filter((line) => line.trim())) {
                try {
                  const value = JSON.parse(line);
                  if (!value || typeof value !== "object")
                    throw Error("record");
                  if (
                    path.endsWith("rewrites.jsonl") &&
                    (typeof value.original !== "string" ||
                      typeof value.rewritten !== "string" ||
                      typeof value.sessionID !== "string" ||
                      typeof value.messageID !== "string")
                  )
                    throw Error("rewrite");
                  records++;
                } catch {
                  malformed++;
                }
              }
              item.summary = { records, malformed };
              item.reason = malformed
                ? "malformed_records"
                : "explicit_owner_mapping_required";
            } else if (path.endsWith(".json")) {
              try {
                JSON.parse(bytes.toString("utf8"));
                item.reason = "explicit_flags_mapping_required";
              } catch {
                item.reason = "malformed_json";
              }
            } else
              item.reason = path.endsWith("learn.md")
                ? "private_learning_mapping_required"
                : "state_mapping_required";
          }
        } catch (error) {
          item.reason =
            (error as { code?: string }).code ??
            (error instanceof Error ? error.message : "unreadable");
        }
        items.push(item);
      }
    }
    try {
      await walk("", 0);
      if (truncated) roots[roots.length - 1]!.status = "partial_limit";
    } catch {
      roots[roots.length - 1]!.status = "partial_unreadable";
    }
  }
  items.sort((a, b) => a.source_id.localeCompare(b.source_id));
  for (const item of items) {
    if (
      item.kind === "package" &&
      item.status !== "unreadable" &&
      items.some(
        (other) =>
          other.source === item.source &&
          other.source_id !== item.source_id &&
          other.path.normalize("NFKC").toLowerCase() ===
            item.path.normalize("NFKC").toLowerCase(),
      )
    ) {
      item.status = "review_required";
      item.reason = "case_collision";
    }
    if (item.checksum) {
      const prior = checksums.get(item.checksum);
      if (prior) item.duplicate_of = prior;
      else checksums.set(item.checksum, item.source_id);
    }
  }

  return {
    version: 1,
    mode: "read_only" as const,
    captured_at: new Date().toISOString(),
    project_root: project,
    roots,
    items,
    total_bytes_read: totalBytes,
    truncated,
    checksum: digest(JSON.stringify(items)),
    mapping_policy:
      "Explicit destination identity required; home data remains personal; originals preserved.",
  };
}
