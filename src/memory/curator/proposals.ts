import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { Identity } from "../../application/identity.js";
import type {
  DB,
  MemoryCuratorChange,
  MemoryCuratorChangeState,
  MemorySpace,
  Run,
} from "../../storage/schema.js";
import { ForgeError } from "../../domain/errors.js";
import { MEMORY_KINDS, MEMORY_RELATIONS } from "../../domain/memory.js";
import {
  classifyCuratorClaim,
  type CuratorClaimEvidence,
  type CuratorRisk,
  type MemoryCuratorMode,
} from "../../domain/curator.js";
import { sourceRefKey } from "./source-reader.js";

/**
 * Issue #39 (M06): the only write path a curator run has.
 *
 * `propose_patch`/`propose_link` stage candidates. Nothing here writes a
 * Markdown revision or a note: the policy layer decides, and an allowed
 * candidate goes through the M02 commit path afterwards. Update/supersede
 * candidates carry an expected `base_revision`; a stale candidate is recorded
 * as `stale` and can never overwrite newer human text.
 */

export const CURATOR_PROPOSAL_CONTENT_MAX = 48 * 1024;

const claimSchema = z
  .object({
    user_declared: z.boolean().default(false),
    externally_verified: z.boolean().default(false),
    rewrites_human_text: z.boolean().default(false),
    contradicts_accepted: z.boolean().default(false),
    describes_plan: z.boolean().default(false),
    claims_completion: z.boolean().default(false),
  })
  .strict();

const citationSchema = z
  .object({
    source_id: z.string().min(1).max(200),
    path: z.string().min(1).max(4000).optional(),
    section: z.string().min(1).max(200).optional(),
  })
  .strict();

export const curatorPatchArgsSchema = z
  .object({
    operation: z.enum(["create", "update", "supersede"]),
    /** Update: the note being edited. Supersede: the note being superseded. */
    note_id: z.string().min(1).max(200).optional(),
    base_revision: z.number().int().min(0).optional(),
    kind: z.enum(MEMORY_KINDS),
    title: z.string().min(1).max(500),
    summary: z.string().max(8000).optional(),
    body: z.string().min(1).max(CURATOR_PROPOSAL_CONTENT_MAX),
    rationale: z.string().min(1).max(2000),
    source_refs: z.array(citationSchema).min(1).max(20),
    claim: claimSchema,
  })
  .strict();

export const curatorLinkArgsSchema = z
  .object({
    note_id: z.string().min(1).max(200),
    target_note_id: z.string().min(1).max(200),
    relation: z.enum(MEMORY_RELATIONS),
    rationale: z.string().min(1).max(2000),
    source_refs: z.array(citationSchema).min(1).max(20),
  })
  .strict();

export interface CuratorAuthorizedSource {
  hash: string;
}

export interface CuratorProposalContext {
  db: Kysely<DB>;
  identity: Identity;
  run: Run;
  space: MemorySpace;
  mode: MemoryCuratorMode;
  maxProposals: number;
  authorizedSources: ReadonlyMap<string, CuratorAuthorizedSource>;
  extractionId: string | null;
}

export interface CuratorProposalSummary {
  change_id: string;
  operation: "create" | "update" | "supersede" | "link";
  state: MemoryCuratorChangeState;
  risk: CuratorRisk;
  claim_class: string;
  auto_write_eligible: boolean;
}

export class CuratorProposals {
  private staged = 0;
  constructor(readonly context: CuratorProposalContext) {}

  private checkCitations(
    refs: { source_id: string; path?: string; section?: string }[],
  ) {
    for (const ref of refs)
      if (!this.context.authorizedSources.has(sourceRefKey(ref)))
        throw new ForgeError(
          "invalid_input",
          "Kaynak referansı bu işte okunan yetkili içerikle eşleşmiyor.",
          403,
        );
  }

  private citationsJson(
    refs: { source_id: string; path?: string; section?: string }[],
  ): string {
    return JSON.stringify(
      refs.map((ref) => {
        const key = sourceRefKey(ref);
        return {
          source_id: ref.source_id,
          path: ref.path ?? null,
          section: ref.section ?? null,
          hash: this.context.authorizedSources.get(key)!.hash,
        };
      }),
    );
  }

  private async ensureLimit(): Promise<void> {
    const row = await this.context.db
      .selectFrom("memory_curator_changes")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("tenant_id", "=", this.context.identity.tenantId)
      .where("run_id", "=", this.context.run.id)
      .executeTakeFirst();
    // Inserts happen immediately, so the DB count already includes staged
    // candidates; adding a second counter would double-count them.
    if (Number(row?.count ?? 0) >= this.context.maxProposals)
      throw new ForgeError(
        "invalid_input",
        "Bu iş için değişiklik önerisi sınırı doldu.",
        422,
      );
  }

  private async noteRevision(
    noteId: string,
  ): Promise<{ current: number | null; exists: boolean }> {
    const note = await this.context.db
      .selectFrom("memory_notes")
      .select(["current_revision"])
      .where("tenant_id", "=", this.context.identity.tenantId)
      .where("space_id", "=", this.context.space.id)
      .where("id", "=", noteId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return { current: note?.current_revision ?? null, exists: Boolean(note) };
  }

  async proposePatch(raw: unknown): Promise<CuratorProposalSummary> {
    const args = curatorPatchArgsSchema.parse(raw);
    this.checkCitations(args.source_refs);
    await this.ensureLimit();
    const evidence: CuratorClaimEvidence = {
      userDeclared: args.claim.user_declared,
      externallyVerified: args.claim.externally_verified,
      rewritesHumanText: args.claim.rewrites_human_text,
      contradictsAccepted: args.claim.contradicts_accepted,
      describesPlan: args.claim.describes_plan,
      claimsCompletion: args.claim.claims_completion,
    };
    const classification = classifyCuratorClaim(evidence);
    const state: MemoryCuratorChangeState =
      this.context.mode === "shadow" ? "shadow" : "proposed";
    const now = Date.now();
    const base = {
      id: randomUUID(),
      tenant_id: this.context.identity.tenantId,
      space_id: this.context.space.id,
      extraction_id: this.context.extractionId,
      run_id: this.context.run.id,
      mode: this.context.mode,
      operation: args.operation,
      note_id: args.note_id ?? null,
      base_revision: args.base_revision ?? null,
      kind: args.kind,
      title: args.title,
      summary: args.summary ?? null,
      body_md: args.body,
      rationale: args.rationale,
      source_refs_json: this.citationsJson(args.source_refs),
      claim_class: classification.claimClass,
      relation: null,
      target_note_id: null,
      confidence_micros: null,
      risk: classification.risk,
      state,
      applied_revision: null,
      reason: null,
      created_at: now,
      updated_at: now,
    } satisfies MemoryCuratorChange;

    if (args.operation === "create") {
      if (args.note_id) {
        const existing = await this.noteRevision(args.note_id);
        if (existing.exists)
          throw new ForgeError(
            "invalid_input",
            "Create adayı var olan not kimliğini kullanamaz.",
            409,
          );
      }
      await this.insert(base);
      return this.summary(base, classification);
    }
    if (!args.note_id || args.base_revision === undefined)
      throw new ForgeError(
        "invalid_input",
        "Update/supersede adayı note_id ve base_revision gerektirir.",
        422,
      );
    const existing = await this.noteRevision(args.note_id);
    if (!existing.exists)
      throw new ForgeError(
        "memory_note_unavailable",
        "Hedef not bu hafıza alanında bulunamadı.",
        404,
      );
    if (existing.current !== args.base_revision) {
      const stale: MemoryCuratorChange = {
        ...base,
        state: "stale",
        reason: "base_revision_conflict",
      };
      await this.insert(stale);
      return this.summary(stale, classification);
    }
    await this.insert(base);
    return this.summary(base, classification);
  }

  async proposeLink(raw: unknown): Promise<CuratorProposalSummary> {
    const args = curatorLinkArgsSchema.parse(raw);
    this.checkCitations(args.source_refs);
    if (args.note_id === args.target_note_id)
      throw new ForgeError(
        "invalid_input",
        "Bir not kendisine bağlanamaz.",
        422,
      );
    await this.ensureLimit();
    const source = await this.noteRevision(args.note_id),
      target = await this.noteRevision(args.target_note_id);
    if (!source.exists || !target.exists)
      throw new ForgeError(
        "memory_note_unavailable",
        "Bağlantı uçları aynı hafıza alanında bulunmalıdır.",
        404,
      );
    const state: MemoryCuratorChangeState =
      this.context.mode === "shadow" ? "shadow" : "proposed";
    const now = Date.now();
    const change: MemoryCuratorChange = {
      id: randomUUID(),
      tenant_id: this.context.identity.tenantId,
      space_id: this.context.space.id,
      extraction_id: this.context.extractionId,
      run_id: this.context.run.id,
      mode: this.context.mode,
      operation: "link",
      note_id: args.note_id,
      base_revision: source.current,
      kind: null,
      title: null,
      summary: null,
      body_md: null,
      rationale: args.rationale,
      source_refs_json: this.citationsJson(args.source_refs),
      claim_class: "link",
      relation: args.relation,
      target_note_id: args.target_note_id,
      confidence_micros: null,
      risk: "medium",
      state,
      applied_revision: null,
      reason: null,
      created_at: now,
      updated_at: now,
    };
    await this.insert(change);
    return {
      change_id: change.id,
      operation: "link",
      state: change.state,
      risk: "medium",
      claim_class: "link",
      auto_write_eligible: false,
    };
  }

  private async insert(change: MemoryCuratorChange): Promise<void> {
    await this.context.db
      .insertInto("memory_curator_changes")
      .values(change)
      .execute();
    this.staged += 1;
  }

  private summary(
    change: MemoryCuratorChange,
    classification: {
      claimClass: string;
      risk: CuratorRisk;
      autoWriteEligible: boolean;
    },
  ): CuratorProposalSummary {
    return {
      change_id: change.id,
      operation: change.operation,
      state: change.state,
      risk: change.risk,
      claim_class: classification.claimClass,
      auto_write_eligible: classification.autoWriteEligible,
    };
  }

  async listForRun(): Promise<MemoryCuratorChange[]> {
    return this.context.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .where("tenant_id", "=", this.context.identity.tenantId)
      .where("run_id", "=", this.context.run.id)
      .orderBy("created_at")
      .execute();
  }

  /**
   * A run that never finalized can leave no actionable candidate behind.
   * Staged proposed/shadow rows are rejected; applied rows are already
   * committed revisions and are never rolled back here.
   */
  async discardUnfinalized(reason: string): Promise<void> {
    await this.context.db
      .updateTable("memory_curator_changes")
      .set({ state: "rejected", reason, updated_at: Date.now() })
      .where("tenant_id", "=", this.context.identity.tenantId)
      .where("run_id", "=", this.context.run.id)
      .where("state", "in", ["proposed", "shadow"])
      .execute();
  }
}
