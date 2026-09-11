import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import type {
  DB,
  MemoryChangeCandidate,
  MemorySource,
  MemorySourceMode,
} from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import { parseMemoryDocument } from "../domain/memory.js";
import { MemoryService } from "./service.js";
import { isUniqueViolation } from "./service.js";
import { readStableText, writeQuarantine } from "./files.js";
import { safeJoin } from "./paths.js";

/**
 * Issue #35 (M02): source roots, bounded cursor reconciliation and visible
 * change candidates.
 *
 * The watcher is only a hint; correctness comes from a cursor/checkpoint walk
 * that reads file contents only for the bounded number of entries processed
 * per turn. Unknown files become `candidate` rows, divergence between an
 * external file and the accepted head becomes a `conflict`, and a missing
 * file only flips the note's source state (tombstones are never revived).
 */

export const MEMORY_SOURCE_MAX_FILE_BYTES = 1024 * 1024;
export const MEMORY_SCAN_DEFAULT_LIMIT = 200;

export interface ScanReport {
  space_id: string;
  /** Whether the registered root existed and was readable this turn. */
  root_state: "present" | "missing";
  scanned: number;
  read: number;
  unchanged: number;
  candidates: number;
  conflicts: number;
  skipped: number;
  errors: number;
  missing: number;
  /** True when the walk reached the end; the cursor resets for a full pass. */
  done: boolean;
  cursor: string | null;
}

export interface MemorySourceServiceDeps {
  db: Kysely<DB>;
  vaultRoot: string;
  service?: MemoryService;
  now?: () => number;
  maxFileBytes?: number;
}

interface WalkEntry {
  relative: string;
  absolute: string;
  kind: "file" | "symlink" | "other";
  size: number;
}

export class MemorySourceService {
  readonly service: MemoryService;
  private readonly now: () => number;
  private readonly maxFileBytes: number;

  constructor(readonly deps: MemorySourceServiceDeps) {
    this.service = deps.service ?? new MemoryService(deps.db);
    this.now = deps.now ?? (() => Date.now());
    this.maxFileBytes = deps.maxFileBytes ?? MEMORY_SOURCE_MAX_FILE_BYTES;
  }

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  /**
   * Register a canonical source root. The root must exist, be a directory,
   * and live outside the memory vault (no self-scan loops). Re-registering
   * the same (space, root) returns the existing row.
   */
  async registerSource(
    identity: Identity,
    input: { spaceId: string; rootPath: string; mode: MemorySourceMode },
  ): Promise<MemorySource> {
    await this.service.authorizeSpace(identity, input.spaceId, "write");
    if (!isAbsolute(input.rootPath))
      throw new ForgeError(
        "invalid_memory_source",
        "Kaynak kökü mutlak yol olmalıdır.",
        422,
      );
    if (input.mode !== "read_only" && input.mode !== "managed")
      throw new ForgeError(
        "invalid_memory_source",
        "Kaynak modu read_only veya managed olmalıdır.",
        422,
      );
    let canonical: string;
    try {
      canonical = await realpath(input.rootPath);
    } catch {
      throw new ForgeError(
        "memory_source_unavailable",
        "Kaynak kökü bulunamadı.",
        404,
      );
    }
    const info = await lstat(canonical);
    if (!info.isDirectory())
      throw new ForgeError(
        "invalid_memory_source",
        "Kaynak kökü dizin olmalıdır.",
        422,
      );
    const vault = resolve(this.deps.vaultRoot);
    const rel = relative(vault, canonical);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new ForgeError(
        "invalid_memory_source",
        "Kaynak kökü hafıza vault'u içinde olamaz.",
        422,
      );
    const existing = await this.db
      .selectFrom("memory_sources")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("root_path", "=", canonical)
      .executeTakeFirst();
    if (existing) return existing;
    const now = this.now();
    const source: MemorySource = {
      tenant_id: identity.tenantId,
      id: randomUUID(),
      space_id: input.spaceId,
      root_path: canonical,
      mode: input.mode,
      cursor_json: null,
      checkpoint: null,
      last_scan_at: null,
      status: "active",
      created_by: identity.userId,
      created_at: now,
      updated_at: now,
    };
    try {
      return await this.db
        .insertInto("memory_sources")
        .values(source)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db
        .selectFrom("memory_sources")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("root_path", "=", canonical)
        .executeTakeFirst();
      if (raced) return raced;
      throw error;
    }
  }

  async listSources(
    identity: Identity,
    input: { spaceId?: string } = {},
  ): Promise<MemorySource[]> {
    if (input.spaceId)
      await this.service.authorizeSpace(identity, input.spaceId, "read");
    const spaces = input.spaceId
      ? [{ id: input.spaceId }]
      : (await this.service.listSpaces(identity)).items;
    if (spaces.length === 0) return [];
    let query = this.db
      .selectFrom("memory_sources")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where(
        "space_id",
        "in",
        spaces.map((space) => space.id),
      );
    query = query.orderBy("id").limit(100);
    return query.execute();
  }

  /** Bounded, cursor-based reconciliation turn for one source root. */
  async scan(
    identity: Identity,
    input: { sourceId: string; limit?: number },
  ): Promise<ScanReport> {
    const limit = Math.min(
      Math.max(input.limit ?? MEMORY_SCAN_DEFAULT_LIMIT, 1),
      1000,
    );
    const source = await this.db
      .selectFrom("memory_sources")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", input.sourceId)
      .executeTakeFirst();
    if (!source)
      throw new ForgeError(
        "memory_source_unavailable",
        "Kaynak bulunamadı.",
        404,
      );
    await this.service.authorizeSpace(identity, source.space_id, "write");

    const cursor = parseCursor(source.cursor_json);
    const report: ScanReport = {
      space_id: source.space_id,
      root_state: "present",
      scanned: 0,
      read: 0,
      unchanged: 0,
      candidates: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      missing: 0,
      done: false,
      cursor: cursor,
    };
    // Silinmiş/erişilemeyen kök ham ENOENT fırlatmaz: kaynak durumu işaretlenir
    // ve gerçek sayaçlarla rapor döner; not otomatik silinmez.
    try {
      await readdir(source.root_path);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code !== "ENOENT" &&
        code !== "ENOTDIR" &&
        code !== "EACCES" &&
        code !== "EPERM"
      )
        throw error;
      const now = this.now();
      await this.db
        .updateTable("memory_sources")
        .set({
          status: "missing",
          cursor_json: null,
          checkpoint: null,
          last_scan_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", source.id)
        .execute();
      return {
        ...report,
        root_state: "missing",
        errors: 1,
        done: true,
        cursor: null,
      };
    }
    const openCandidates = await this.openCandidates(
      source.id,
      identity.tenantId,
    );
    let lastEntry: string | null = cursor;
    let budget = limit;
    const walk = walkEntries(source.root_path, cursor, limit * 10);

    for await (const entry of walk.entries) {
      lastEntry = entry.relative;
      if (entry.kind === "other") {
        continue;
      }
      if (entry.kind === "symlink") {
        report.scanned += 1;
        report.skipped += 1;
        budget -= 1;
        await this.upsertCandidate(identity, source, entry.relative, {
          noteId: null,
          previousHash: null,
          observedHash: null,
          baseRevision: null,
          state: "quarantined",
          reason: "symlink",
        });
        await writeQuarantine(this.deps.vaultRoot, {
          reason: "source_symlink",
          path: entry.relative,
          summary: "Sembolik bağ tarama dışı bırakıldı.",
        });
        if (budget <= 0) break;
        continue;
      }
      report.scanned += 1;
      budget -= 1;
      if (entry.size > this.maxFileBytes) {
        report.skipped += 1;
        await this.upsertCandidate(identity, source, entry.relative, {
          noteId: null,
          previousHash: null,
          observedHash: null,
          baseRevision: null,
          state: "quarantined",
          reason: "too_large",
        });
        await writeQuarantine(this.deps.vaultRoot, {
          reason: "source_too_large",
          path: entry.relative,
          summary: "Dosya boyut sınırını aşıyor; içerik okunmadı.",
        });
        if (budget <= 0) break;
        continue;
      }
      let content: string;
      let hash: string;
      try {
        const stable = await readStableText(entry.absolute, {
          maxBytes: this.maxFileBytes,
        });
        content = stable.content;
        hash = stable.hash;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "memory_file_changed") {
          // Yarım yazım: bu turda atlanır, sonraki tur yeniden dener.
          report.skipped += 1;
          if (budget <= 0) break;
          continue;
        }
        report.errors += 1;
        if (budget <= 0) break;
        continue;
      }
      report.read += 1;
      await this.classifyFile(
        identity,
        source,
        entry,
        content,
        hash,
        report,
        openCandidates,
      );
      if (budget <= 0) break;
    }

    // Directories fully enumerated in this turn are checked for missing
    // bound files; a stopped-inside directory is checked next turn.
    const closedDirs = walk.state.closedDirs;
    if (closedDirs.size > 0)
      report.missing += await this.markMissing(
        identity,
        source,
        closedDirs,
        report,
      );

    const done = walk.state.done;
    const now = this.now();
    await this.db
      .updateTable("memory_sources")
      .set({
        status: "active",
        cursor_json: done ? null : JSON.stringify({ path: lastEntry }),
        checkpoint: done ? null : lastEntry,
        last_scan_at: now,
        updated_at: now,
      })
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", source.id)
      .execute();
    report.done = done;
    report.cursor = done ? null : lastEntry;
    return report;
  }

  private async openCandidates(sourceId: string, tenantId: string) {
    const rows = await this.db
      .selectFrom("memory_change_candidates")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("source_id", "=", sourceId)
      .where("state", "in", ["candidate", "conflict"])
      .execute();
    return new Map(rows.map((row) => [row.path, row]));
  }

  private async classifyFile(
    identity: Identity,
    source: MemorySource,
    entry: WalkEntry,
    content: string,
    hash: string,
    report: ScanReport,
    openCandidates: Map<string, MemoryChangeCandidate>,
  ): Promise<void> {
    const note = await this.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", source.space_id)
      .where("source_id", "=", source.id)
      .where("source_path", "=", entry.relative)
      .executeTakeFirst();
    if (note?.deleted_at) {
      // Tombstone: yeniden tarama silinmiş notu diriltmez.
      report.skipped += 1;
      return;
    }
    if (note && note.source_hash === hash) {
      if (note.source_state !== "present")
        await this.markSourceState(identity, note, "present");
      report.unchanged += 1;
      return;
    }
    if (!note) {
      // Bilinmeyen dosya: açık inceleme adayı; read_only kaynağa yazılmaz.
      const duplicate = await this.findDuplicateNoteId(
        identity,
        source,
        content,
        entry.relative,
      );
      if (duplicate) {
        report.conflicts += 1;
        await this.upsertCandidate(identity, source, entry.relative, {
          noteId: duplicate.noteId,
          previousHash: null,
          observedHash: hash,
          baseRevision: duplicate.baseRevision,
          state: "conflict",
          reason: "duplicate_note_id",
        });
        return;
      }
      const caseConflict = await this.findCaseConflict(
        identity,
        source,
        entry.relative,
      );
      if (caseConflict) {
        report.conflicts += 1;
        await this.upsertCandidate(identity, source, entry.relative, {
          noteId: null,
          previousHash: null,
          observedHash: hash,
          baseRevision: null,
          state: "conflict",
          reason: "case_conflict",
        });
        return;
      }
      report.candidates += 1;
      await this.upsertCandidate(identity, source, entry.relative, {
        noteId: null,
        previousHash: null,
        observedHash: hash,
        baseRevision: null,
        state: "candidate",
        reason: "new",
      });
      return;
    }
    // Bağlı notun içeriği dışarıda değişmiş: kabul edilmiş head de
    // ilerlemişse sessiz son-yazan-kazanmaz; çatışma görünür olur.
    const previous = openCandidates.get(entry.relative) ?? null;
    const bothChanged =
      previous !== null &&
      previous.base_revision !== null &&
      (note.current_revision ?? 0) > previous.base_revision;
    const duplicate = await this.findDuplicateNoteId(
      identity,
      source,
      content,
      entry.relative,
    );
    if (duplicate) {
      report.conflicts += 1;
      await this.upsertCandidate(identity, source, entry.relative, {
        noteId: duplicate.noteId,
        previousHash: note.source_hash,
        observedHash: hash,
        baseRevision: note.current_revision,
        state: "conflict",
        reason: "duplicate_note_id",
      });
      return;
    }
    if (bothChanged) {
      report.conflicts += 1;
      await this.upsertCandidate(identity, source, entry.relative, {
        noteId: note.id,
        previousHash: note.source_hash,
        observedHash: hash,
        baseRevision: previous?.base_revision ?? note.current_revision,
        state: "conflict",
        reason: "external_and_accepted_changed",
      });
      return;
    }
    report.candidates += 1;
    await this.upsertCandidate(identity, source, entry.relative, {
      noteId: note.id,
      previousHash: note.source_hash,
      observedHash: hash,
      baseRevision: note.current_revision,
      state: "candidate",
      reason: "updated",
    });
  }

  private async findDuplicateNoteId(
    identity: Identity,
    source: MemorySource,
    content: string,
    path: string,
  ): Promise<{ noteId: string; baseRevision: number | null } | null> {
    const parsed = parseMemoryDocument(content);
    if (parsed.status !== "ok") return null;
    const owner = await this.db
      .selectFrom("memory_notes")
      .select(["id", "source_path", "current_revision"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", source.space_id)
      .where("id", "=", parsed.record.noteId)
      .executeTakeFirst();
    if (!owner) return null;
    if (owner.source_path === path) return null;
    return {
      noteId: parsed.record.noteId,
      baseRevision: owner.current_revision,
    };
  }

  private async findCaseConflict(
    identity: Identity,
    source: MemorySource,
    path: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom("memory_change_candidates")
      .select(["path"])
      .where("tenant_id", "=", identity.tenantId)
      .where("source_id", "=", source.id)
      .where(sql<boolean>`lower(path) = lower(${path})`)
      .where("path", "!=", path)
      .executeTakeFirst();
    return row?.path ?? null;
  }

  private async markSourceState(
    identity: Identity,
    note: { id: string; space_id: string },
    state: "present" | "missing",
  ): Promise<void> {
    await this.db
      .updateTable("memory_notes")
      .set({ source_state: state, updated_at: this.now() })
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", note.space_id)
      .where("id", "=", note.id)
      .execute();
  }

  private async markMissing(
    identity: Identity,
    source: MemorySource,
    closedDirs: Set<string>,
    report: ScanReport,
  ): Promise<number> {
    const seen = await this.seenPaths(source, closedDirs);
    const notes = await this.db
      .selectFrom("memory_notes")
      .select(["id", "space_id", "source_path", "source_state"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", source.space_id)
      .where("source_id", "=", source.id)
      .where("source_state", "=", "present")
      .execute();
    let missing = 0;
    for (const note of notes) {
      if (!note.source_path) continue;
      const dir = dirname(note.source_path);
      const dirKey = dir === "." ? "" : dir;
      if (!closedDirs.has(dirKey)) continue;
      if (seen.has(note.source_path)) continue;
      missing += 1;
      report.candidates += 1;
      await this.markSourceState(identity, note, "missing");
      await this.upsertCandidate(identity, source, note.source_path, {
        noteId: note.id,
        previousHash: null,
        observedHash: null,
        baseRevision: null,
        state: "candidate",
        reason: "source_missing",
      });
    }
    return missing;
  }

  private async seenPaths(
    source: MemorySource,
    closedDirs: Set<string>,
  ): Promise<Set<string>> {
    const seen = new Set<string>();
    for (const dir of closedDirs) {
      const absolute = dir
        ? safeJoin(source.root_path, ...dir.split("/"))
        : source.root_path;
      const entries = await readdir(absolute, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        seen.add(rel);
      }
    }
    return seen;
  }

  private async upsertCandidate(
    identity: Identity,
    source: MemorySource,
    path: string,
    values: {
      noteId: string | null;
      previousHash: string | null;
      observedHash: string | null;
      baseRevision: number | null;
      state: "candidate" | "conflict" | "quarantined";
      reason: string;
    },
  ): Promise<void> {
    const now = this.now();
    const existing = await this.db
      .selectFrom("memory_change_candidates")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("source_id", "=", source.id)
      .where("path", "=", path)
      .where("state", "in", ["candidate", "conflict", "quarantined"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (existing) {
      await this.db
        .updateTable("memory_change_candidates")
        .set({
          note_id: values.noteId,
          previous_hash: values.previousHash,
          observed_hash: values.observedHash,
          base_revision: values.baseRevision,
          state: values.state,
          reason: values.reason,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", existing.id)
        .execute();
      return;
    }
    await this.db
      .insertInto("memory_change_candidates")
      .values({
        tenant_id: identity.tenantId,
        id: randomUUID(),
        source_id: source.id,
        path,
        note_id: values.noteId,
        previous_hash: values.previousHash,
        observed_hash: values.observedHash,
        base_revision: values.baseRevision,
        state: values.state,
        reason: values.reason,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  /** Bounded candidate view; open items first. */
  async listCandidates(
    identity: Identity,
    input: {
      spaceId?: string;
      sourceId?: string;
      state?: string;
      limit?: number;
      after?: string;
    } = {},
  ): Promise<{ items: MemoryChangeCandidate[]; next: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    let spaceIds: string[];
    if (input.spaceId) {
      await this.service.authorizeSpace(identity, input.spaceId, "read");
      spaceIds = [input.spaceId];
    } else {
      spaceIds = (await this.service.listSpaces(identity)).items.map(
        (space) => space.id,
      );
    }
    if (spaceIds.length === 0) return { items: [], next: null };
    let query = this.db
      .selectFrom("memory_change_candidates as c")
      .innerJoin("memory_sources as s", (join) =>
        join
          .onRef("s.tenant_id", "=", "c.tenant_id")
          .onRef("s.id", "=", "c.source_id"),
      )
      .selectAll("c")
      .where("c.tenant_id", "=", identity.tenantId)
      .where("s.space_id", "in", spaceIds);
    if (input.sourceId) query = query.where("c.source_id", "=", input.sourceId);
    if (input.state) query = query.where("c.state", "=", input.state as never);
    if (input.after) query = query.where("c.id", ">", input.after);
    const rows = await query
      .orderBy("c.id")
      .limit(limit + 1)
      .execute();
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
}

function parseCursor(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path ? parsed.path : null;
  } catch {
    return null;
  }
}

interface WalkState {
  closedDirs: Set<string>;
  done: boolean;
}

interface WalkResult {
  entries: AsyncGenerator<WalkEntry>;
  state: WalkState;
}

/**
 * Lexicographic depth-first walk. Contents are never read here; the caller
 * reads at most `limit` files per turn and persists the last relative path as
 * the cursor, so the next turn continues from there. Directories always get
 * descended (their children are compared against the full cursor path), while
 * file entries at or before the cursor are skipped.
 */
function walkEntries(
  root: string,
  cursor: string | null,
  maxEntries: number,
): WalkResult {
  const state: WalkState = { closedDirs: new Set(), done: false };
  const entries = (async function* (): AsyncGenerator<WalkEntry> {
    let processed = 0;
    const stack: {
      absolute: string;
      relative: string;
      entries: { name: string; isFile: boolean }[];
      index: number;
    }[] = [];
    const rootEntries = await readdir(root, { withFileTypes: true });
    stack.push({
      absolute: root,
      relative: "",
      entries: rootEntries
        .map((entry) => ({ name: entry.name, isFile: entry.isFile() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      index: 0,
    });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.entries.length) {
        stack.pop();
        state.closedDirs.add(frame.relative);
        continue;
      }
      const entry = frame.entries[frame.index++]!;
      const relative = frame.relative
        ? `${frame.relative}/${entry.name}`
        : entry.name;
      // Only files can be skipped by the cursor; directories must be
      // descended so a cursor inside them can resume correctly.
      if (entry.isFile && relative <= (cursor ?? "")) continue;
      if (processed >= maxEntries) return;
      processed += 1;
      const absolute = join(frame.absolute, entry.name);
      if (entry.isFile) {
        const info = await lstat(absolute).catch(() => null);
        if (!info) continue;
        if (info.isSymbolicLink()) {
          yield { relative, absolute, kind: "symlink", size: 0 };
          continue;
        }
        if (!info.isFile()) {
          yield { relative, absolute, kind: "other", size: 0 };
          continue;
        }
        yield { relative, absolute, kind: "file", size: info.size };
        continue;
      }
      const childInfo = await lstat(absolute).catch(() => null);
      if (!childInfo) continue;
      if (childInfo.isSymbolicLink()) {
        yield { relative, absolute, kind: "symlink", size: 0 };
        continue;
      }
      if (!childInfo.isDirectory()) {
        yield { relative, absolute, kind: "other", size: 0 };
        continue;
      }
      const children = await readdir(absolute, { withFileTypes: true });
      stack.push({
        absolute,
        relative,
        entries: children
          .map((child) => ({ name: child.name, isFile: child.isFile() }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        index: 0,
      });
    }
    state.done = true;
  })();
  return { entries, state };
}
