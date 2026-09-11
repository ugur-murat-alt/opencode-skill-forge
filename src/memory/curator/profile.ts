import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Identity } from "../../application/identity.js";
import { IdentityService } from "../../application/identity.js";
import { providerProfileSchema } from "../../application/providers.js";
import type { SecretVault } from "../../storage/secrets.js";
import type { DB, MemoryCuratorProfile } from "../../storage/schema.js";
import { ForgeError } from "../../domain/errors.js";

/**
 * Issue #39 (M06): the independent memory model binding.
 *
 * This repository never reads `provider_profiles`, never falls back to the
 * skill/evaluation role and never resolves an environment credential. Model
 * resolution lives in `src/runner/curator-model.ts` so `src/memory/**` stays
 * free of runner imports; when no profile exists the caller surfaces
 * "not ready" instead of calling a model.
 */
export class MemoryCuratorProfileRepository {
  constructor(
    readonly db: Kysely<DB>,
    readonly vault: SecretVault,
  ) {}

  async latest(identity: Identity): Promise<MemoryCuratorProfile | undefined> {
    await new IdentityService(this.db).authorize(identity, "read");
    return this.db
      .selectFrom("memory_curator_profiles")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .orderBy("revision", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  async status(identity: Identity) {
    const current = await this.latest(identity);
    const profile = current
      ? providerProfileSchema.parse(JSON.parse(current.profile_json))
      : null;
    return {
      revision: current?.revision ?? 0,
      profile,
      credential: current?.secret_ref ? "configured" : "missing",
      model_ready: false as boolean,
    };
  }

  async update(identity: Identity, input: unknown) {
    await new IdentityService(this.db).authorize(identity, "write");
    const body = z
      .object({
        base_revision: z.number().int().min(0),
        profile: providerProfileSchema,
        credential: z.string().min(1).max(16384).optional(),
      })
      .strict()
      .parse(input);
    try {
      return await this.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", identity.tenantId)
          .execute();
        const auth = new IdentityService(tx);
        await auth.authorize(identity, "write");
        const current = await new MemoryCuratorProfileRepository(
          tx,
          this.vault,
        ).latest(identity);
        if ((current?.revision ?? 0) !== body.base_revision)
          throw new ForgeError(
            "revision_conflict",
            "Hafıza model profili başka işlemde değişti.",
            409,
          );
        const secretRef = body.credential
          ? await this.vault.put(
              identity.tenantId,
              identity.userId,
              body.credential,
            )
          : current &&
              JSON.parse(current.profile_json).provider ===
                body.profile.provider
            ? current.secret_ref
            : null;
        const revision = body.base_revision + 1;
        await tx
          .insertInto("memory_curator_profiles")
          .values({
            tenant_id: identity.tenantId,
            user_id: identity.userId,
            id: randomUUID(),
            revision,
            profile_json: JSON.stringify(body.profile),
            secret_ref: secretRef,
            created_at: Date.now(),
          })
          .execute();
        await tx
          .insertInto("audit_events")
          .values({
            tenant_id: identity.tenantId,
            id: randomUUID(),
            user_id: identity.userId,
            project_id: null,
            kind: "memory.curator.profile.updated",
            detail: JSON.stringify({ revision }),
            created_at: Date.now(),
          })
          .execute();
        return {
          revision,
          profile: body.profile,
          credential: secretRef ? "configured" : "missing",
        };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
        throw new ForgeError(
          "revision_conflict",
          "Hafıza model profili eşzamanlı değişti.",
          409,
        );
      throw error;
    }
  }
}
