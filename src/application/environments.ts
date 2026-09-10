import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";

/** Issue #14: the single visibility contract for project-scoped consumers.
 * Lists/stats and mutation flows share this scope definition; mutation paths
 * keep their own stricter (admin) authorization on top of visibility. */
export async function visibleScopes(
  db: Kysely<DB>,
  identity: Identity,
  projectId: string,
) {
  return [
    "workspace",
    `personal:${identity.userId}`,
    `project:${projectId}`,
    `environment:${
      (
        await new EnvironmentService(db).resolveProject(
          identity.tenantId,
          projectId,
        )
      ).environment_id
    }`,
  ];
}
/** Insert the default environment for a tenant if none exists. Idempotent. */
export async function ensureDefaultEnvironment(
  db: Kysely<DB>,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("environments")
    .values({
      tenant_id: tenantId,
      id,
      name: "default",
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "name"]).doNothing())
    .execute();
  const row = await db
    .selectFrom("environments")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("name", "=", "default")
    .executeTakeFirstOrThrow();
  return row.id;
}

export class EnvironmentService {
  constructor(readonly db: Kysely<DB>) {}

  async list(actor: Identity) {
    await new IdentityService(this.db).authorize(actor, "read");
    return this.db
      .selectFrom("environments")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .orderBy("created_at")
      .execute();
  }

  async create(actor: Identity, raw: { name: string }) {
    const input = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(raw);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const existing = await tx
        .selectFrom("environments")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("name", "=", input.name)
        .executeTakeFirst();
      if (existing)
        throw new ForgeError(
          "environment_exists",
          "Bu adda ortam zaten var.",
          409,
        );
      const row = {
        tenant_id: actor.tenantId,
        id: randomUUID(),
        name: input.name,
        created_at: Date.now(),
      };
      await tx.insertInto("environments").values(row).execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "environment.created",
          detail: JSON.stringify({ id: row.id, name: row.name }),
          created_at: Date.now(),
        })
        .execute();
      return row;
    });
  }

  async remove(actor: Identity, id: string) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const row = await tx
        .selectFrom("environments")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "environment_unavailable",
          "Ortam bulunamadı.",
          404,
        );
      const first = await tx
        .selectFrom("environments")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .orderBy("created_at")
        .limit(1)
        .executeTakeFirstOrThrow();
      if (row.id === first.id)
        throw new ForgeError(
          "env_protected",
          "Varsayılan ortam silinemez.",
          409,
        );
      const used = await tx
        .selectFrom("projects")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("environment_id", "=", id)
        .executeTakeFirstOrThrow();
      if (Number(used.n) > 0)
        throw new ForgeError(
          "env_in_use",
          "Ortamda proje varken silinemez.",
          409,
        );
      const skillRefs = await tx
        .selectFrom("skills")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("scope_key", "=", `environment:${id}`)
        .executeTakeFirstOrThrow();
      if (Number(skillRefs.n) > 0)
        throw new ForgeError(
          "env_in_use",
          "Ortamda skill varken silinemez; önce taşıyın.",
          409,
        );
      const settingRefs = await tx
        .selectFrom("config_revisions")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("scope_key", "=", `environment:${id}`)
        .executeTakeFirstOrThrow();
      if (Number(settingRefs.n) > 0)
        throw new ForgeError(
          "env_in_use",
          "Ortamda ayar varken silinemez.",
          409,
        );
      await tx
        .deleteFrom("environments")
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "environment.removed",
          detail: JSON.stringify({ id }),
          created_at: Date.now(),
        })
        .execute();
      return { id };
    });
  }

  /** Resolve a project with its environment; tenant-scoped (fail closed). */
  async resolveProject(tenantId: string, projectId: string) {
    const project = await this.db
      .selectFrom("projects")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!project)
      throw new ForgeError(
        "project_unavailable",
        "Proje bulunamadı veya yetkiniz yok.",
        404,
      );
    if (!project.environment_id) {
      const id = await ensureDefaultEnvironment(this.db, tenantId);
      await this.db
        .updateTable("projects")
        .set({ environment_id: id })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", projectId)
        .where("environment_id", "is", null)
        .execute();
      return { ...project, environment_id: id };
    }
    return { ...project, environment_id: project.environment_id };
  }
}
