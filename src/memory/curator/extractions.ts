import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  DB,
  MemoryCuratorExtraction,
  MemoryCuratorExtractionStatus,
} from "../../storage/schema.js";
import type { Identity } from "../../application/identity.js";

/**
 * Issue #39 (M06): bounded extraction records. They are the model-cost cache
 * and the audit trail of "not ready"/failed runs; they never contain provider
 * keys or raw source text.
 */
export class CuratorExtractionRepository {
  constructor(readonly db: Kysely<DB>) {}

  async findReusable(input: {
    tenantId: string;
    spaceId: string;
    extractorVersion: string;
    policyVersion: string;
    sourceFingerprint: string;
    mode: string;
  }): Promise<MemoryCuratorExtraction | undefined> {
    return this.db
      .selectFrom("memory_curator_extractions")
      .selectAll()
      .where("tenant_id", "=", input.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("extractor_version", "=", input.extractorVersion)
      .where("policy_version", "=", input.policyVersion)
      .where("source_fingerprint", "=", input.sourceFingerprint)
      .where("mode", "=", input.mode)
      .where("status", "in", ["ready", "no_op"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  async insert(input: {
    identity: Identity;
    spaceId: string;
    runId: string;
    mode: string;
    extractorVersion: string;
    policyVersion: string;
    sourceFingerprint: string;
    status: MemoryCuratorExtractionStatus;
    result?: unknown;
    usage?: unknown;
    errorCode?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await this.db
      .insertInto("memory_curator_extractions")
      .values({
        id,
        tenant_id: input.identity.tenantId,
        space_id: input.spaceId,
        run_id: input.runId,
        mode: input.mode,
        extractor_version: input.extractorVersion,
        policy_version: input.policyVersion,
        source_fingerprint: input.sourceFingerprint,
        status: input.status,
        result_json:
          input.result === undefined ? null : JSON.stringify(input.result),
        usage_json:
          input.usage === undefined ? null : JSON.stringify(input.usage),
        error_code: input.errorCode ?? null,
        created_at: Date.now(),
      })
      .execute();
    return id;
  }
}
