import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";
export const sessionSourceSchema = z
  .object({
    client: z.string().min(1).max(100),
    session: z.string().min(1).max(200),
  })
  .strict();
export const sessionValuesSchema = z
  .object({
    promptEnabled: z.boolean().optional(),
    autoApply: z.boolean().optional(),
  })
  .strict();
export type SessionSource = z.infer<typeof sessionSourceSchema>;
export class SessionPreferences {
  constructor(readonly identity: IdentityService) {}
  key(source: SessionSource) {
    const parsed = sessionSourceSchema.parse(source);
    return createHash("sha256")
      .update(JSON.stringify([parsed.client, parsed.session]))
      .digest("hex");
  }
  async get(actor: Identity, project: string, source: SessionSource) {
    await this.identity.authorize(actor, "read", project);
    const row = await this.identity.db
      .selectFrom("session_preferences")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", project)
      .where("session_key", "=", this.key(source))
      .executeTakeFirst();
    return {
      revision: row?.revision ?? 0,
      values: row ? sessionValuesSchema.parse(JSON.parse(row.payload)) : {},
    };
  }
  async update(
    actor: Identity,
    project: string,
    source: SessionSource,
    base: number,
    raw: unknown,
  ) {
    return this.identity.db
      .transaction()
      .execute((tx) => this.write(tx, actor, project, source, base, raw));
  }
  async write(
    tx: Kysely<DB>,
    actor: Identity,
    project: string,
    source: SessionSource,
    base: number,
    raw: unknown,
  ) {
    const values = sessionValuesSchema.parse(raw),
      key = this.key(source);
    z.number().int().nonnegative().parse(base);

    await tx
      .updateTable("tenants")
      .set({ name: sql`name` })
      .where("id", "=", actor.tenantId)
      .execute();
    await new IdentityService(tx).authorize(actor, "write", project);
    const old = await tx
      .selectFrom("session_preferences")
      .select("revision")
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", project)
      .where("session_key", "=", key)
      .executeTakeFirst();
    if ((old?.revision ?? 0) !== base)
      throw new ForgeError(
        "revision_conflict",
        "Oturum tercihi değişti; güncel revision gerekiyor.",
        409,
      );
    const revision = base + 1,
      payload = JSON.stringify(values),
      now = Date.now();
    if (old) {
      const changed = await tx
        .updateTable("session_preferences")
        .set({ revision, payload, updated_at: now })
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .where("session_key", "=", key)
        .where("revision", "=", base)
        .executeTakeFirst();
      if (Number(changed.numUpdatedRows) !== 1)
        throw new ForgeError(
          "revision_conflict",
          "Oturum tercihi eşzamanlı değişti.",
          409,
        );
    } else {
      const count = await tx
        .selectFrom("session_preferences")
        .select(sql<number>`count(*)`.as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= 10000)
        throw new ForgeError(
          "session_preference_limit",
          "Kullanıcı başına 10000 oturum tercihi sınırı aşıldı.",
          409,
        );
      await tx
        .insertInto("session_preferences")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: project,
          session_key: key,
          revision,
          payload,
          updated_at: now,
        })
        .execute();
    }
    return { revision, values };
  }
}
