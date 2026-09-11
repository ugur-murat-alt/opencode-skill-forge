import { validatePackagePath } from "../skills/paths.js";
import { openDatabase } from "../storage/database.js";
import { vaultRoot } from "../memory/paths.js";
import {
  applyPurgesFromBackup,
  rebuildDerivedAfterRestore,
  recordRestoreReceipt,
} from "../memory/retention.js";

/**
 * Issue #41 (M08): memory section of the existing backup format.
 *
 * Accepted Markdown revision files join the same consistent snapshot as the
 * operational DB, and the manifest carries head/revision hashes, migration
 * version, counts and the durable purge receipts. Restore is only complete
 * after derived search/graph/context is rebuilt; a manifest without the purge
 * section demands operator reconciliation before automatic writes start.
 */

export interface MemoryBackupSummary {
  counts: {
    spaces: number;
    notes: number;
    revisions: number;
    revision_files: number;
    events_pending: number;
    events_terminal: number;
    purges: number;
  };
  db_migration: string | null;
  purges: {
    tenant_id: string;
    space_id: string;
    note_id: string;
    purged_at: number;
    reason: string;
  }[];
}

export async function memoryBackupSummary(
  query: (sql: string) => Promise<unknown[]>,
): Promise<MemoryBackupSummary | null> {
  try {
    const [spaces, notes, revisions, files, pending, terminal, purges, runs] =
      await Promise.all([
        query("SELECT COUNT(*) AS n FROM memory_spaces"),
        query("SELECT COUNT(*) AS n FROM memory_notes"),
        query("SELECT COUNT(*) AS n FROM memory_note_revisions"),
        query(
          "SELECT COUNT(*) AS n FROM memory_note_revisions WHERE file_path IS NOT NULL",
        ),
        query(
          "SELECT COUNT(*) AS n FROM memory_events WHERE state = 'pending'",
        ),
        query(
          "SELECT COUNT(*) AS n FROM memory_events WHERE state <> 'pending'",
        ),
        query("SELECT COUNT(*) AS n FROM memory_purges"),
        query("SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1"),
      ]);
    const count = (rows: unknown[]) =>
      Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    const purgeRows = (await query(
      "SELECT tenant_id, space_id, note_id, purged_at, reason FROM memory_purges LIMIT 100000",
    )) as MemoryBackupSummary["purges"];
    return {
      counts: {
        spaces: count(spaces),
        notes: count(notes),
        revisions: count(revisions),
        revision_files: count(files),
        events_pending: count(pending),
        events_terminal: count(terminal),
        purges: count(purges),
      },
      db_migration:
        (runs[0] as { name?: unknown } | undefined)?.name !== undefined
          ? String((runs[0] as { name: unknown }).name)
          : null,
      purges: purgeRows
        .filter(
          (row) =>
            typeof row?.tenant_id === "string" &&
            typeof row?.space_id === "string" &&
            typeof row?.note_id === "string" &&
            typeof row?.purged_at === "number",
        )
        .map((row) => ({
          tenant_id: row.tenant_id,
          space_id: row.space_id,
          note_id: row.note_id,
          purged_at: row.purged_at,
          reason: String(row.reason ?? "unknown").slice(0, 500),
        })),
    };
  } catch {
    // A pre-memory schema (or a hand-built test DB) has no memory section.
    return null;
  }
}

export async function memoryReferences(
  query: (sql: string) => Promise<unknown[]>,
): Promise<Map<string, { bytes?: number; hash?: string }>> {
  const files = new Map<string, { bytes?: number; hash?: string }>();
  try {
    const rows = (await query(
      "SELECT file_path, content_hash, byte_size FROM memory_note_revisions WHERE file_path IS NOT NULL LIMIT 200000",
    )) as {
      file_path: string;
      content_hash: string | null;
      byte_size: number | null;
    }[];
    for (const row of rows) {
      const path = `memory/${row.file_path}`;
      validatePackagePath(path);
      files.set(path, {
        bytes: row.byte_size ?? undefined,
        hash: row.content_hash ?? undefined,
      });
    }
  } catch {
    // No memory tables; nothing to copy.
  }
  return files;
}

export async function reconcileRestoredMemory(input: {
  dataDir: string;
  postgresUrl?: string;
  backend: "sqlite" | "postgres";
  manifestCreatedAt: string | null;
  memory: MemoryBackupSummary | null | undefined;
}): Promise<{
  purges_applied: number;
  indexed: number;
  reconciliation_required: boolean;
}> {
  const storage = await openDatabase({
    dataDir: input.dataDir,
    ...(input.postgresUrl ? { postgresUrl: input.postgresUrl } : {}),
  });
  try {
    const purgesApplied = input.memory
      ? await applyPurgesFromBackup(storage.db, input.memory.purges)
      : 0;
    const rebuilt = await rebuildDerivedAfterRestore(
      storage.db,
      vaultRoot(input.dataDir),
    );
    await recordRestoreReceipt(storage.db, {
      backend: input.backend,
      manifestCreatedAt: input.manifestCreatedAt,
      purgesIncluded: Boolean(input.memory),
      purgesApplied,
    });
    return {
      purges_applied: purgesApplied,
      indexed: rebuilt.indexed,
      reconciliation_required: !input.memory,
    };
  } finally {
    await storage.close();
  }
}
