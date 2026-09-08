import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IdentityService, type Identity } from "./identity.js";
import { SecretVault } from "../storage/secrets.js";
import { ForgeError } from "../domain/errors.js";
export const providerProfileSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "openrouter", "ollama"]),
    model: z.string().min(1).max(200),
    baseUrl: z.url().optional(),
    allowPaid: z.boolean().default(false),
    maxOutputTokens: z.number().int().min(64).max(32768).default(4096),
    contextWindow: z.number().int().min(1024).max(1000000).optional(),
  })
  .strict();
export class ProviderService {
  constructor(
    readonly identity: IdentityService,
    readonly vault: SecretVault,
  ) {}
  async latest(identity: Identity, role: "skill" | "evaluation") {
    await this.identity.authorize(identity, "read");
    return this.identity.db
      .selectFrom("provider_profiles")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("role", "=", role)
      .orderBy("revision", "desc")
      .limit(1)
      .executeTakeFirst();
  }
  async list(identity: Identity) {
    return Promise.all(
      (["skill", "evaluation"] as const).map(async (role) => {
        const current = await this.latest(identity, role);
        return {
          role,
          revision: current?.revision ?? 0,
          profile: current
            ? providerProfileSchema.parse(JSON.parse(current.profile_json))
            : null,
          credential: current?.secret_ref ? "configured" : "missing",
          health: "unknown",
        };
      }),
    );
  }
  async update(identity: Identity, input: unknown) {
    await this.identity.authorize(identity, "write");
    const body = z
      .object({
        role: z.enum(["skill", "evaluation"]),
        base_revision: z.number().int().min(0),
        profile: providerProfileSchema,
        credential: z.string().min(1).max(16384).optional(),
      })
      .strict()
      .parse(input);
    try {
      return await this.identity.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", identity.tenantId)
          .execute();
        const auth = new IdentityService(tx);
        await auth.authorize(identity, "write");
        const current = await new ProviderService(auth, this.vault).latest(
          identity,
          body.role,
        );
        if ((current?.revision ?? 0) !== body.base_revision)
          throw new ForgeError(
            "revision_conflict",
            "Model profili başka işlemde değişti.",
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
        await tx
          .insertInto("provider_profiles")
          .values({
            tenant_id: identity.tenantId,
            user_id: identity.userId,
            id: randomUUID(),
            role: body.role,
            revision: body.base_revision + 1,
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
            kind: "provider.updated",
            detail: JSON.stringify({
              role: body.role,
              revision: body.base_revision + 1,
            }),
            created_at: Date.now(),
          })
          .execute();
        return {
          revision: body.base_revision + 1,
          profile: body.profile,
          credential: secretRef ? "configured" : "missing",
        };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
        throw new ForgeError(
          "revision_conflict",
          "Model profili eşzamanlı değişti.",
          409,
        );
      throw error;
    }
  }
}
