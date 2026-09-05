import { terminalStates } from "../jobs/queue.js";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";
export class MemberService {
  constructor(readonly db: Kysely<DB>) {}
  async list(actor: Identity, project: string, after = "") {
    await new IdentityService(this.db).authorize(actor, "admin", project);
    const rows = await this.db
      .selectFrom("memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .leftJoin("project_members as p", (j) =>
        j
          .onRef("p.tenant_id", "=", "m.tenant_id")
          .onRef("p.user_id", "=", "m.user_id")
          .on("p.project_id", "=", project),
      )
      .select([
        "m.user_id",
        "u.display_name",
        "m.role",
        "m.disabled",
        "m.generation",
        "p.role as project_role",
        "p.generation as project_generation",
      ])
      .where("m.tenant_id", "=", actor.tenantId)
      .where("m.user_id", ">", after)
      .orderBy("m.user_id")
      .limit(51)
      .execute();
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49]!.user_id : null,
    };
  }
  async create(actor: Identity, raw: unknown) {
    const input = z
      .object({
        subject: z.string().min(1).max(1000),
        display_name: z.string().min(1).max(200),
        role: z.enum(["admin", "editor", "viewer"]),
      })
      .strict()
      .parse(raw);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      await tx
        .insertInto("users")
        .values({
          id: randomUUID(),
          subject: input.subject,
          display_name: input.display_name,
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.column("subject").doNothing())
        .execute();
      const user = await tx
        .selectFrom("users")
        .select("id")
        .where("subject", "=", input.subject)
        .executeTakeFirstOrThrow();
      const inserted = await tx
        .insertInto("memberships")
        .values({
          tenant_id: actor.tenantId,
          user_id: user.id,
          role: input.role,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .returning("user_id")
        .executeTakeFirst();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: null,
          id: randomUUID(),
          kind: "member.provisioned",
          detail: JSON.stringify({
            target_user_id: user.id,
            created: !!inserted,
          }),
          created_at: Date.now(),
        })
        .execute();
      return { user_id: user.id, created: !!inserted };
    });
  }
  async update(actor: Identity, target: string, raw: unknown) {
    const input = z
      .object({
        project_ref: z.string().min(1).max(100),
        generation: z.number().int().nonnegative(),
        project_generation: z.number().int().nonnegative().nullable(),
        role: z.enum(["admin", "editor", "viewer"]),
        disabled: z.boolean(),
        project_role: z.enum(["editor", "viewer"]).nullable(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction().execute(async (tx) => {
      // Serialize membership administration before rechecking the acting administrator.
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(
        actor,
        "admin",
        input.project_ref,
      );
      const member = await tx
        .selectFrom("memberships")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", target)
        .executeTakeFirst();
      if (!member)
        throw new ForgeError("member_unavailable", "Üye bulunamadı.", 404);
      if (member.role === "owner")
        throw new ForgeError(
          "owner_protected",
          "Çalışma alanı sahibinin erişimi bu işlemle kaldırılamaz.",
          409,
        );
      if (member.generation !== input.generation)
        throw new ForgeError(
          "revision_conflict",
          "Üyelik başka işlemde değişti; güncel listeyi okuyun.",
          409,
        );
      const project = await tx
        .selectFrom("project_members")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("project_id", "=", input.project_ref)
        .where("user_id", "=", target)
        .executeTakeFirst();
      if ((project?.generation ?? null) !== input.project_generation)
        throw new ForgeError(
          "revision_conflict",
          "Proje üyeliği değişti; güncel listeyi okuyun.",
          409,
        );
      await tx
        .updateTable("memberships")
        .set({
          role: input.role,
          disabled: input.disabled ? 1 : 0,
          generation: member.generation + 1,
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", target)
        .execute();
      if (input.project_role) {
        await tx
          .insertInto("project_members")
          .values({
            tenant_id: actor.tenantId,
            project_id: input.project_ref,
            user_id: target,
            role: input.project_role,
            generation: (project?.generation ?? -1) + 1,
          })
          .onConflict((oc) =>
            oc.columns(["tenant_id", "project_id", "user_id"]).doUpdateSet({
              role: input.project_role!,
              generation: (project?.generation ?? -1) + 1,
            }),
          )
          .execute();
      } else
        await tx
          .deleteFrom("project_members")
          .where("tenant_id", "=", actor.tenantId)
          .where("project_id", "=", input.project_ref)
          .where("user_id", "=", target)
          .execute();
      let revoked = tx
        .updateTable("runs")
        .set({
          state: "cancelled",
          error_code: "permission_revoked",
          lease_until: 0,
          fence: sql`fence + 1`,
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", target)
        .where("state", "not in", terminalStates);
      let cancelled: { id: string }[] = [];
      if (input.disabled || input.role === "viewer")
        cancelled = await revoked.returning("id").execute();
      else if (input.role === "editor")
        cancelled = await revoked
          .where(
            "project_id",
            "not in",
            tx
              .selectFrom("project_members")
              .select("project_id")
              .where("tenant_id", "=", actor.tenantId)
              .where("user_id", "=", target)
              .where("role", "=", "editor"),
          )
          .returning("id")
          .execute();
      if (cancelled.length)
        await tx
          .updateTable("run_attempts")
          .set({ ended_at: Date.now(), result: "permission_revoked" })
          .where("tenant_id", "=", actor.tenantId)
          .where(
            "run_id",
            "in",
            cancelled.map((r) => r.id),
          )
          .where("ended_at", "is", null)
          .execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: input.project_ref,
          id: randomUUID(),
          kind: "member.updated",
          detail: JSON.stringify({
            target_user_id: target,
            role: input.role,
            disabled: input.disabled,
            project_role: input.project_role,
            generation: member.generation + 1,
          }),
          created_at: Date.now(),
        })
        .execute();
      return { user_id: target, generation: member.generation + 1 };
    });
  }
}
