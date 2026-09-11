/**
 * #40 (M07) FAZ 2: dry-run → stage → apply → doğrulama → rollback hattı.
 *
 * Apply, M02'nin yetkili commit yolunu (`MemoryCommitService`) kullanır:
 * dosya + DB sırası, tek yazıcı, CAS ve kalıcı receipt oradan gelir. Bu
 * modül ek olarak import düzeyinde stage doğrulaması, snapshot hash
 * kontrolü, idempotent öğe uygulaması, kalıcı import receipt'i, kısmi hata
 * devamı ve yalnız değişmemiş hedeflerde rollback sağlar.
 *
 * Kalıcı receipt `<stageDir>/receipt.json` dosyasındadır; her revision ve
 * her öğe sonrası atomik yazılır. Crash sonrası resume aynı receipt'i
 * tamamlar; ikinci aynı import yeni not/revision/olay üretmez (M02 event
 * anahtarı + replay yolu).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Identity } from "../../application/identity.js";
import { ForgeError } from "../../domain/errors.js";
import { MemoryCommitService } from "../commit.js";
import { atomicWriteFile, readWorkingCopy, sha256Hex } from "../files.js";
import { tempDir } from "../paths.js";
import type { MemoryService } from "../service.js";
import {
  agzDocumentRelativePath,
  agzIdempotencyKey,
  agzManifestJson,
  agzStageDir,
  computeAgzStageDigest,
  parseAgzManifestJson,
  type AgzImportManifest,
  type AgzImportPlan,
} from "./manifest.js";

export type AgzApplyItemStatus =
  "pending" | "applied" | "duplicate" | "quarantined" | "conflict" | "failed";

export type AgzRollbackItemStatus =
  "rolled_back" | "already_rolled_back" | "conflict" | "missing" | "skipped";

export interface AgzOutcomeCounters {
  planned: number;
  applied: number;
  duplicate: number;
  quarantined: number;
  conflict: number;
  failed: number;
  pending: number;
}

export interface AgzReceiptRevision {
  sourceRevision: number;
  targetRevision: number | null;
  documentSha256: string;
  fileHash: string | null;
  recordHash: string | null;
  status: AgzApplyItemStatus;
  errorCode: string | null;
  updatedAt: number;
}

export interface AgzReceiptItem {
  sourceProjectId: string;
  sourceNoteId: string;
  targetNoteId: string;
  memorySpaceId: string;
  idDecision: string;
  status: AgzApplyItemStatus;
  errorCode: string | null;
  revisions: AgzReceiptRevision[];
  rollback?: {
    status: AgzRollbackItemStatus;
    errorCode: string | null;
    updatedAt: number;
  };
  updatedAt: number;
}

export interface AgzImportReceipt {
  receiptVersion: 1;
  kind: "agz-import-receipt";
  manifestDigest: string;
  stageDigest: string;
  databaseId: string;
  fileSha256: string;
  createdAt: number;
  updatedAt: number;
  counters: {
    notes: AgzOutcomeCounters;
    revisions: AgzOutcomeCounters;
  };
  items: AgzReceiptItem[];
  rollback?: {
    startedAt: number;
    finishedAt: number;
    counters: {
      notes: number;
      rolledBack: number;
      alreadyRolledBack: number;
      conflict: number;
      missing: number;
      skipped: number;
    };
  };
}

export interface AgzStageResult {
  stageDir: string;
  manifestDigest: string;
  stageDigest: string;
  documentCount: number;
  bytes: number;
}

export interface AgzStagedDocument {
  sourceProjectId: string;
  sourceNoteId: string;
  sourceRevision: number;
  relativePath: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface AgzStagePackage {
  stageDir: string;
  manifest: AgzImportManifest;
  manifestDigest: string;
  stageDigest: string;
  documents: Map<string, AgzStagedDocument>;
}

export interface AgzApplyReport {
  kind: "agz-import-apply";
  status: "applied" | "partial" | "already_applied";
  manifestDigest: string;
  stageDigest: string;
  counters: {
    notes: AgzOutcomeCounters;
    revisions: AgzOutcomeCounters;
  };
  items: Array<{
    sourceNoteId: string;
    targetNoteId: string;
    status: AgzApplyItemStatus;
    errorCode: string | null;
  }>;
  receiptPath: string;
  redactedCommits: number;
}

export interface AgzRollbackReport {
  kind: "agz-import-rollback";
  status: "rolled_back" | "partial" | "already_rolled_back";
  counters: {
    notes: number;
    rolledBack: number;
    alreadyRolledBack: number;
    conflict: number;
    missing: number;
    skipped: number;
  };
  items: Array<{
    sourceNoteId: string;
    targetNoteId: string;
    status: AgzRollbackItemStatus;
    errorCode: string | null;
  }>;
  receiptPath: string;
}

export interface AgzApplyHooks {
  /** Test-only crash injection: her öğe receipt'e yazıldıktan sonra. */
  afterItem?: (itemIndex: number) => void | Promise<void>;
}

function emptyCounters(planned = 0): AgzOutcomeCounters {
  return {
    planned,
    applied: 0,
    duplicate: 0,
    quarantined: 0,
    conflict: 0,
    failed: 0,
    pending: 0,
  };
}

function countOutcomes(
  statuses: readonly AgzApplyItemStatus[],
): AgzOutcomeCounters {
  const counters = emptyCounters(statuses.length);
  for (const status of statuses) counters[status] += 1;
  return counters;
}

function revisionKey(sourceNoteId: string, sourceRevision: number): string {
  return `${sourceNoteId}:${sourceRevision}`;
}

function stageVaultRoot(stageDir: string): string {
  return dirname(dirname(dirname(stageDir)));
}

async function sha256File(
  path: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export async function stageAgzImport(
  plan: AgzImportPlan,
  input: { vaultRoot: string },
): Promise<AgzStageResult> {
  if (plan.manifest.decision.status === "blocked")
    throw new ForgeError(
      "agz_manifest_blocked",
      "Bloklayıcı sorunları olan manifest stage edilemez.",
      422,
      undefined,
      {
        blockingIssues: plan.manifest.decision.blockingIssues,
      },
    );
  const stageDir = agzStageDir(input.vaultRoot, plan.manifest);
  const manifestJson = agzManifestJson(plan.manifest);
  const manifestDigest = sha256Hex(manifestJson);
  const stageDigest = computeAgzStageDigest(plan.manifest);
  let bytes = 0;
  await atomicWriteFile(join(stageDir, "manifest.json"), manifestJson, {
    tempDir: tempDir(input.vaultRoot),
    vaultRoot: input.vaultRoot,
  });
  for (const document of plan.documents) {
    bytes += document.bytes;
    await atomicWriteFile(
      join(stageDir, document.relativePath),
      document.content,
      {
        tempDir: tempDir(input.vaultRoot),
        vaultRoot: input.vaultRoot,
      },
    );
  }
  await atomicWriteFile(
    join(stageDir, "stage.json"),
    `${JSON.stringify(
      {
        stageVersion: 1,
        manifestDigest,
        stageDigest,
        documentCount: plan.documents.length,
        bytes,
      },
      null,
      2,
    )}\n`,
    { tempDir: tempDir(input.vaultRoot), vaultRoot: input.vaultRoot },
  );
  return {
    stageDir,
    manifestDigest,
    stageDigest,
    documentCount: plan.documents.length,
    bytes,
  };
}

export async function readAgzStage(input: {
  stageDir: string;
}): Promise<AgzStagePackage> {
  const { stageDir } = input;
  const manifestText = await readFile(
    join(stageDir, "manifest.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new ForgeError(
        "agz_stage_missing",
        `Stage bulunamadı: ${stageDir}`,
        404,
      );
    throw error;
  });
  const manifest = parseAgzManifestJson(manifestText);
  const manifestDigest = sha256Hex(manifestText);
  const stageMetaText = await readFile(
    join(stageDir, "stage.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new ForgeError(
        "agz_stage_integrity",
        "Stage meta dosyası eksik.",
        409,
      );
    throw error;
  });
  let meta: {
    stageVersion?: unknown;
    manifestDigest?: unknown;
    stageDigest?: unknown;
  };
  try {
    meta = JSON.parse(stageMetaText) as typeof meta;
  } catch {
    throw new ForgeError("agz_stage_integrity", "Stage meta JSON bozuk.", 409);
  }
  if (meta.stageVersion !== 1 || meta.manifestDigest !== manifestDigest)
    throw new ForgeError(
      "agz_stage_integrity",
      "Stage meta manifest ile eşleşmiyor.",
      409,
    );
  const documents = new Map<string, AgzStagedDocument>();
  for (const note of manifest.notes) {
    for (const revision of note.revisions) {
      const relativePath = agzDocumentRelativePath(
        note.sourceNoteId,
        revision.sourceRevision,
        revision.documentSha256,
      );
      const content = await readFile(
        join(stageDir, relativePath),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new ForgeError(
            "agz_stage_integrity",
            `Stage dokümanı eksik: ${relativePath}`,
            409,
          );
        throw error;
      });
      if (sha256Hex(content) !== revision.documentSha256)
        throw new ForgeError(
          "agz_stage_integrity",
          `Stage dokümanı hash'i uyuşmuyor: ${relativePath}`,
          409,
        );
      documents.set(revisionKey(note.sourceNoteId, revision.sourceRevision), {
        sourceProjectId: note.sourceProjectId,
        sourceNoteId: note.sourceNoteId,
        sourceRevision: revision.sourceRevision,
        relativePath,
        content,
        sha256: revision.documentSha256,
        bytes: revision.bytes,
      });
    }
  }
  if (computeAgzStageDigest(manifest) !== meta.stageDigest)
    throw new ForgeError(
      "agz_stage_integrity",
      "Stage digest manifest ile eşleşmiyor.",
      409,
    );
  return {
    stageDir,
    manifest,
    manifestDigest,
    stageDigest: meta.stageDigest as string,
    documents,
  };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

async function readReceipt(stageDir: string): Promise<AgzImportReceipt | null> {
  const text = await readFile(join(stageDir, "receipt.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (text === null) return null;
  try {
    return JSON.parse(text) as AgzImportReceipt;
  } catch {
    throw new ForgeError("agz_receipt_invalid", "Import receipt bozuk.", 409);
  }
}

async function writeReceipt(
  stageDir: string,
  vaultRoot: string,
  receipt: AgzImportReceipt,
): Promise<void> {
  await atomicWriteFile(
    join(stageDir, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { tempDir: tempDir(vaultRoot), vaultRoot },
  );
}

function buildReceipt(
  manifest: AgzImportManifest,
  manifestDigest: string,
  stageDigest: string,
  now: number,
): AgzImportReceipt {
  const items: AgzReceiptItem[] = manifest.notes.map((note) => ({
    sourceProjectId: note.sourceProjectId,
    sourceNoteId: note.sourceNoteId,
    targetNoteId: note.targetNoteId,
    memorySpaceId:
      manifest.mappings.find(
        (mapping) => mapping.sourceProjectId === note.sourceProjectId,
      )?.target.memorySpaceId ?? "",
    idDecision: note.idDecision,
    status: note.status === "quarantined" ? "quarantined" : "pending",
    errorCode:
      note.status === "quarantined"
        ? (note.issues.find((item) => item.severity === "blocking")?.code ??
          "quarantined")
        : null,
    revisions: note.revisions.map((revision) => ({
      sourceRevision: revision.sourceRevision,
      targetRevision: null,
      documentSha256: revision.documentSha256,
      fileHash: null,
      recordHash: null,
      status: note.status === "quarantined" ? "quarantined" : "pending",
      errorCode: null,
      updatedAt: now,
    })),
    updatedAt: now,
  }));
  return {
    receiptVersion: 1,
    kind: "agz-import-receipt",
    manifestDigest,
    stageDigest,
    databaseId: manifest.source.databaseId,
    fileSha256: manifest.source.fileSha256,
    createdAt: now,
    updatedAt: now,
    counters: {
      notes: countOutcomes(items.map((item) => item.status)),
      revisions: countOutcomes(
        items.flatMap((item) =>
          item.revisions.map((revision) => revision.status),
        ),
      ),
    },
    items,
  };
}

function refreshReceiptCounters(receipt: AgzImportReceipt, now: number): void {
  receipt.updatedAt = now;
  receipt.counters = {
    notes: countOutcomes(receipt.items.map((item) => item.status)),
    revisions: countOutcomes(
      receipt.items.flatMap((item) =>
        item.revisions.map((revision) => revision.status),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface AgzApplyOptions {
  service: MemoryService;
  commits: MemoryCommitService;
  identity: Identity;
  stageDir: string;
  sourcePath?: string;
  hooks?: AgzApplyHooks;
}

async function authorizeMappings(
  service: MemoryService,
  identity: Identity,
  manifest: AgzImportManifest,
  access: "read" | "write",
): Promise<void> {
  for (const mapping of manifest.mappings) {
    const space = await service.authorizeSpace(
      identity,
      mapping.target.memorySpaceId,
      access,
    );
    if (
      space.kind !== mapping.target.kind ||
      (space.kind === "project" &&
        space.project_id !== mapping.target.projectId)
    )
      throw new ForgeError(
        "agz_target_mismatch",
        "Hedef alan manifest eşlemesiyle uyuşmuyor.",
        422,
        undefined,
        { memorySpaceId: space.id },
      );
  }
}

function classifyApplyError(error: unknown): {
  status: AgzApplyItemStatus;
  code: string;
} {
  if (error instanceof ForgeError) {
    if (
      error.code === "memory_revision_conflict" ||
      error.code === "memory_event_conflict" ||
      error.code === "memory_note_deleted" ||
      error.code === "memory_revision_required"
    )
      return { status: "conflict", code: error.code };
    if (
      error.code === "memory_unsafe_content" ||
      error.code === "invalid_memory_document" ||
      error.code === "memory_format_unsupported" ||
      error.code === "memory_space_mismatch" ||
      error.code === "memory_note_id_mismatch"
    )
      return { status: "quarantined", code: error.code };
    return { status: "failed", code: error.code };
  }
  return { status: "failed", code: "agz_apply_failed" };
}

async function currentTargetRevision(
  service: MemoryService,
  identity: Identity,
  spaceId: string,
  noteId: string,
): Promise<number | null> {
  const row = await service.db
    .selectFrom("memory_notes")
    .select(["current_revision", "deleted_at"])
    .where("tenant_id", "=", identity.tenantId)
    .where("space_id", "=", spaceId)
    .where("id", "=", noteId)
    .executeTakeFirst();
  if (!row) return null;
  return row.current_revision;
}

export async function applyAgzImport(
  options: AgzApplyOptions,
): Promise<AgzApplyReport> {
  const stage = await readAgzStage({ stageDir: options.stageDir });
  const { manifest } = stage;
  if (manifest.decision.status === "blocked")
    throw new ForgeError(
      "agz_manifest_blocked",
      "Bloklayıcı sorunları olan manifest uygulanamaz.",
      422,
    );
  if (
    manifest.mappings.some(
      (mapping) => mapping.target.tenantId !== options.identity.tenantId,
    )
  )
    throw new ForgeError(
      "agz_target_mismatch",
      "Manifest hedef kiracısı aktörün kiracısıyla uyuşmuyor.",
      403,
    );
  if (options.sourcePath) {
    const snapshot = await sha256File(options.sourcePath);
    if (snapshot.sha256 !== manifest.source.fileSha256)
      throw new ForgeError(
        "source_changed_during_scan",
        "Kaynak snapshot değişti; eski dry-run sessizce uygulanamaz.",
        409,
        undefined,
        {
          expected: manifest.source.fileSha256,
          observed: snapshot.sha256,
        },
      );
  }
  // Yetki kapısı: hiçbir yazımdan önce tüm hedef alanlar yeniden doğrulanır.
  await authorizeMappings(options.service, options.identity, manifest, "write");

  const vaultRoot = stageVaultRoot(options.stageDir);
  const now = Date.now();
  let receipt = await readReceipt(options.stageDir);
  if (!receipt) {
    receipt = buildReceipt(
      manifest,
      stage.manifestDigest,
      stage.stageDigest,
      now,
    );
  } else if (
    receipt.manifestDigest !== stage.manifestDigest ||
    receipt.databaseId !== manifest.source.databaseId
  ) {
    throw new ForgeError(
      "agz_stage_conflict",
      "Receipt başka bir manifest/stage'e ait.",
      409,
    );
  }

  const runNotes: AgzApplyItemStatus[] = [];
  const runRevisions: AgzApplyItemStatus[] = [];
  const items: AgzApplyReport["items"] = [];
  let redactedCommits = 0;

  for (let index = 0; index < manifest.notes.length; index += 1) {
    const note = manifest.notes[index]!;
    const item = receipt.items.find(
      (entry) => entry.sourceNoteId === note.sourceNoteId,
    );
    if (!item)
      throw new ForgeError(
        "agz_receipt_invalid",
        `Receipt öğesi eksik: ${note.sourceNoteId}`,
        409,
      );
    if (note.status === "quarantined") {
      item.status = "quarantined";
      item.errorCode =
        note.issues.find((entry) => entry.severity === "blocking")?.code ??
        "quarantined";
      item.updatedAt = now;
      for (const revision of item.revisions) {
        revision.status = "quarantined";
        revision.updatedAt = now;
      }
      refreshReceiptCounters(receipt, now);
      await writeReceipt(options.stageDir, vaultRoot, receipt);
      runNotes.push("quarantined");
      runRevisions.push(
        ...item.revisions.map(() => "quarantined" as AgzApplyItemStatus),
      );
      items.push({
        sourceNoteId: note.sourceNoteId,
        targetNoteId: note.targetNoteId,
        status: "quarantined",
        errorCode: item.errorCode,
      });
      await options.hooks?.afterItem?.(index);
      continue;
    }

    let expected = await currentTargetRevision(
      options.service,
      options.identity,
      item.memorySpaceId,
      note.targetNoteId,
    );
    let itemFailure: { status: AgzApplyItemStatus; code: string } | null = null;
    for (const revision of item.revisions) {
      if (itemFailure) {
        revision.status = itemFailure.status;
        revision.errorCode = itemFailure.code;
        revision.updatedAt = Date.now();
        runRevisions.push(itemFailure.status);
        continue;
      }
      const document = stage.documents.get(
        revisionKey(note.sourceNoteId, revision.sourceRevision),
      );
      if (!document) {
        itemFailure = { status: "failed", code: "agz_stage_integrity" };
        revision.status = "failed";
        revision.errorCode = "agz_stage_integrity";
        revision.updatedAt = Date.now();
        runRevisions.push("failed");
        continue;
      }
      try {
        const recorded = await options.service.recordEvent(options.identity, {
          spaceId: item.memorySpaceId,
          sourceEventKey: agzIdempotencyKey(
            manifest.source.databaseId,
            note.sourceProjectId,
            note.sourceNoteId,
            revision.sourceRevision,
          ),
          sourceKind: "migration",
          contentHash: document.sha256,
        });
        const committed = await options.commits.commit({
          identity: options.identity,
          spaceId: item.memorySpaceId,
          eventId: recorded.event.id,
          sourceKind: "migration",
          content: document.content,
          noteId: note.targetNoteId,
          baseRevision: expected,
        });
        if (committed.redacted) redactedCommits += 1;
        revision.status =
          committed.status === "duplicate" ? "duplicate" : "applied";
        revision.targetRevision = committed.revision;
        revision.fileHash = committed.fileHash;
        revision.recordHash = committed.recordHash;
        revision.updatedAt = Date.now();
        expected = committed.revision;
        runRevisions.push(revision.status);
      } catch (error) {
        itemFailure = classifyApplyError(error);
        revision.status = itemFailure.status;
        revision.errorCode = itemFailure.code;
        revision.updatedAt = Date.now();
        runRevisions.push(itemFailure.status);
      }
      refreshReceiptCounters(receipt, Date.now());
      await writeReceipt(options.stageDir, vaultRoot, receipt);
    }

    if (itemFailure) {
      item.status = itemFailure.status;
      item.errorCode = itemFailure.code;
    } else if (
      item.revisions.some((revision) => revision.status === "applied")
    ) {
      item.status = "applied";
      item.errorCode = null;
    } else {
      item.status = "duplicate";
      item.errorCode = null;
    }
    item.updatedAt = Date.now();
    refreshReceiptCounters(receipt, Date.now());
    await writeReceipt(options.stageDir, vaultRoot, receipt);
    runNotes.push(item.status);
    items.push({
      sourceNoteId: note.sourceNoteId,
      targetNoteId: note.targetNoteId,
      status: item.status,
      errorCode: item.errorCode,
    });
    await options.hooks?.afterItem?.(index);
  }

  const notes = countOutcomes(runNotes);
  const revisions = countOutcomes(runRevisions);
  const hasFailure =
    notes.quarantined + notes.conflict + notes.failed > 0 ||
    revisions.quarantined + revisions.conflict + revisions.failed > 0;
  const appliedNow = revisions.applied > 0;
  return {
    kind: "agz-import-apply",
    status: hasFailure ? "partial" : appliedNow ? "applied" : "already_applied",
    manifestDigest: stage.manifestDigest,
    stageDigest: stage.stageDigest,
    counters: { notes, revisions },
    items,
    receiptPath: join(options.stageDir, "receipt.json"),
    redactedCommits,
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface AgzRollbackOptions {
  service: MemoryService;
  identity: Identity;
  stageDir: string;
}

export async function rollbackAgzImport(
  options: AgzRollbackOptions,
): Promise<AgzRollbackReport> {
  const stage = await readAgzStage({ stageDir: options.stageDir });
  const { manifest } = stage;
  if (
    manifest.mappings.some(
      (mapping) => mapping.target.tenantId !== options.identity.tenantId,
    )
  )
    throw new ForgeError(
      "agz_target_mismatch",
      "Manifest hedef kiracısı aktörün kiracısıyla uyuşmuyor.",
      403,
    );
  await authorizeMappings(options.service, options.identity, manifest, "write");
  const vaultRoot = stageVaultRoot(options.stageDir);
  const receipt = await readReceipt(options.stageDir);
  if (!receipt)
    throw new ForgeError(
      "agz_receipt_missing",
      "Rollback için import receipt gerekir.",
      404,
    );

  const counters = {
    notes: 0,
    rolledBack: 0,
    alreadyRolledBack: 0,
    conflict: 0,
    missing: 0,
    skipped: 0,
  };
  const items: AgzRollbackReport["items"] = [];
  const now = Date.now();
  receipt.rollback = {
    startedAt: now,
    finishedAt: now,
    counters: { ...counters },
  };

  for (const note of manifest.notes) {
    const item = receipt.items.find(
      (entry) => entry.sourceNoteId === note.sourceNoteId,
    );
    if (!item) continue;
    counters.notes += 1;
    const record = (
      status: AgzRollbackItemStatus,
      errorCode: string | null,
    ): void => {
      item.rollback = { status, errorCode, updatedAt: Date.now() };
      items.push({
        sourceNoteId: note.sourceNoteId,
        targetNoteId: note.targetNoteId,
        status,
        errorCode,
      });
      if (status === "rolled_back") counters.rolledBack += 1;
      else if (status === "already_rolled_back")
        counters.alreadyRolledBack += 1;
      else if (status === "conflict") counters.conflict += 1;
      else if (status === "missing") counters.missing += 1;
      else counters.skipped += 1;
    };

    const importedRevisions = item.revisions.filter(
      (revision) =>
        revision.status === "applied" || revision.status === "duplicate",
    );
    if (importedRevisions.length === 0) {
      record("skipped", item.errorCode);
      continue;
    }
    const lastImported = importedRevisions.reduce((latest, revision) =>
      (revision.targetRevision ?? 0) > (latest.targetRevision ?? 0)
        ? revision
        : latest,
    );
    const targetRevision = lastImported.targetRevision;
    if (targetRevision === null) {
      record("skipped", "revision_unresolved");
      continue;
    }
    const row = await options.service.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", options.identity.tenantId)
      .where("space_id", "=", item.memorySpaceId)
      .where("id", "=", note.targetNoteId)
      .executeTakeFirst();
    if (!row) {
      record("missing", "memory_note_unavailable");
      continue;
    }
    if (row.deleted_at !== null) {
      record(
        item.rollback?.status === "rolled_back"
          ? "already_rolled_back"
          : "conflict",
        item.rollback?.status === "rolled_back" ? null : "memory_note_deleted",
      );
      continue;
    }
    if (row.current_revision !== targetRevision) {
      record("conflict", "memory_revision_conflict");
      continue;
    }
    const revisionRow = await options.service.db
      .selectFrom("memory_note_revisions")
      .select(["content_hash"])
      .where("tenant_id", "=", options.identity.tenantId)
      .where("space_id", "=", item.memorySpaceId)
      .where("note_id", "=", note.targetNoteId)
      .where("revision", "=", targetRevision)
      .executeTakeFirst();
    if (!revisionRow || revisionRow.content_hash !== lastImported.fileHash) {
      record("conflict", "target_revision_changed");
      continue;
    }
    const vaultRootForWorking = options.service.vaultRoot ?? vaultRoot;
    const working = await readWorkingCopy(
      vaultRootForWorking,
      item.memorySpaceId,
      note.targetNoteId,
    );
    if (
      working &&
      lastImported.fileHash &&
      working.hash !== lastImported.fileHash
    ) {
      record("conflict", "working_copy_changed");
      continue;
    }
    await options.service.archiveNote(options.identity, {
      spaceId: item.memorySpaceId,
      noteId: note.targetNoteId,
    });
    record("rolled_back", null);
  }

  receipt.rollback.finishedAt = Date.now();
  receipt.rollback.counters = { ...counters };
  refreshReceiptCounters(receipt, Date.now());
  await writeReceipt(options.stageDir, vaultRoot, receipt);
  const status =
    counters.rolledBack > 0 && counters.conflict === 0 && counters.missing === 0
      ? "rolled_back"
      : counters.rolledBack === 0 &&
          counters.conflict === 0 &&
          counters.missing === 0
        ? "already_rolled_back"
        : "partial";
  return {
    kind: "agz-import-rollback",
    status,
    counters,
    items,
    receiptPath: join(options.stageDir, "receipt.json"),
  };
}
