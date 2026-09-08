import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "../storage/schema.js";
import type { MemberRole } from "../domain/roles.js";
import {
  BUILTIN_BASE,
  BUILTIN_TOOLS,
  MEMBER_ROLES,
  baseTools,
  roleRank,
  type MatrixTool,
} from "../domain/roles.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";

export interface EffectiveRole {
  name: string;
  builtin: boolean;
  base: "reader" | "writer" | "admin";
  tools: readonly MatrixTool[];
  deleted: boolean;
}

const BASES = ["reader", "writer", "admin"] as const;

/** Resolve a membership role to its effective definition. Null = unusable. */
export async function resolveRole(
  db: Kysely<DB>,
  tenantId: string,
  role: string,
): Promise<EffectiveRole | null> {
  if (role === "founder")
    return {
      name: role,
      builtin: true,
      base: "admin",
      tools: BUILTIN_TOOLS["founder"]!,
      deleted: false,
    };
  if (!(MEMBER_ROLES as readonly string[]).includes(role)) {
    const row = await db
      .selectFrom("role_registry")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("name", "=", role)
      .executeTakeFirst();
    if (!row || row.deleted || row.kind !== "custom") return null;
    if (row.base !== "reader" && row.base !== "writer" && row.base !== "admin")
      return null;
    const base = row.base;
    let tools: readonly MatrixTool[] = baseTools(base);
    if (row.tools_json) {
      try {
        const parsed = JSON.parse(row.tools_json) as unknown;
        if (
          !Array.isArray(parsed) ||
          !parsed.every(
            (t): t is MatrixTool =>
              typeof t === "string" &&
              (baseTools(base) as readonly string[]).includes(t),
          )
        )
          return null;
        tools = parsed;
      } catch {
        return null;
      }
    }
    return { name: role, builtin: false, base, tools, deleted: false };
  }
  const row = await db
    .selectFrom("role_registry")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("name", "=", role)
    .executeTakeFirst();
  if (row?.deleted) return null;
  return {
    name: role,
    builtin: true,
    base: BUILTIN_BASE[role]!,
    tools: BUILTIN_TOOLS[role]!,
    deleted: false,
  };
}

/** Normalize a membership role for permission checks (custom → base). */
export async function normalizeRole(
  db: Kysely<DB>,
  tenantId: string,
  role: string,
): Promise<string | null> {
  if (role === "founder") return "founder";
  if (role === "auditor") {
    const resolved = await resolveRole(db, tenantId, role);
    return resolved ? "auditor" : null;
  }
  const resolved = await resolveRole(db, tenantId, role);
  if (!resolved) return null;
  return resolved.base;
}

export class RoleService {
  constructor(readonly db: Kysely<DB>) {}

  async list(actor: Identity): Promise<
    {
      name: string;
      kind: string;
      base: string | null;
      tools: string[] | null;
      deleted: boolean;
      builtin: boolean;
    }[]
  > {
    await new IdentityService(this.db).authorize(actor, "admin");
    const rows = await this.db
      .selectFrom("role_registry")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .orderBy("name")
      .execute();
    const byName = new Map(rows.map((r) => [r.name, r]));
    const out: {
      name: string;
      kind: string;
      base: string | null;
      tools: string[] | null;
      deleted: boolean;
      builtin: boolean;
    }[] = (MEMBER_ROLES as readonly string[]).map((name) => {
      const row = byName.get(name);
      if (name === "founder")
        return {
          name,
          kind: "builtin",
          base: "admin",
          tools: [...BUILTIN_TOOLS["founder"]!],
          deleted: false,
          builtin: true,
        };
      if (row?.deleted)
        return {
          name,
          kind: row.kind,
          base: row.base,
          tools: [],
          deleted: true,
          builtin: true,
        };
      return {
        name,
        kind: "builtin",
        base: BUILTIN_BASE[name]!,
        tools: [...BUILTIN_TOOLS[name]!],
        deleted: false,
        builtin: true,
      };
    });
    for (const r of rows) {
      if (!(MEMBER_ROLES as readonly string[]).includes(r.name))
        out.push({
          name: r.name,
          kind: "custom",
          base: r.base,
          tools: r.tools_json ? (JSON.parse(r.tools_json) as string[]) : null,
          deleted: Boolean(r.deleted),
          builtin: false,
        });
    }
    return out;
  }

  async create(
    actor: Identity,
    raw: { name: string; base: string; tools?: string[] },
  ) {
    let input: {
      name: string;
      base: "reader" | "writer" | "admin";
      tools?: string[];
    };
    try {
      input = z
        .object({
          name: z.string().regex(/^[a-z0-9-]{1,64}$/),
          base: z.enum(BASES),
          tools: z.array(z.string().min(1).max(64)).max(16).optional(),
        })
        .strict()
        .parse(raw);
    } catch {
      throw new ForgeError("invalid_role", "Rol tanımı geçersiz.");
    }
    if ((MEMBER_ROLES as readonly string[]).includes(input.name))
      throw new ForgeError("role_reserved", "Bu ad yerleşik role aittir.", 409);
    const allowed = [...baseTools(input.base)];
    if (
      input.tools &&
      !input.tools.every((t) => allowed.includes(t as MatrixTool))
    )
      throw new ForgeError(
        "invalid_role",
        "Araç listesi taban rolün dışına çıkamaz.",
      );
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const existing = await tx
        .selectFrom("role_registry")
        .select(["deleted"])
        .where("tenant_id", "=", actor.tenantId)
        .where("name", "=", input.name)
        .executeTakeFirst();
      if (existing && !existing.deleted)
        throw new ForgeError("role_exists", "Rol zaten tanımlı.", 409);
      const now = Date.now();
      const auditKind = existing ? "role.revived" : "role.created";
      if (existing) {
        await tx
          .updateTable("role_registry")
          .set({
            kind: "custom",
            base: input.base,
            tools_json: input.tools ? JSON.stringify(input.tools) : null,
            deleted: 0,
            created_by: actor.userId,
            created_at: now,
          })
          .where("tenant_id", "=", actor.tenantId)
          .where("name", "=", input.name)
          .execute();
      } else {
        await tx
          .insertInto("role_registry")
          .values({
            tenant_id: actor.tenantId,
            name: input.name,
            kind: "custom",
            base: input.base,
            tools_json: input.tools ? JSON.stringify(input.tools) : null,
            created_by: actor.userId,
            created_at: now,
          })
          .execute();
      }
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: auditKind,
          detail: JSON.stringify({ name: input.name, base: input.base }),
          created_at: now,
        })
        .execute();
      return { name: input.name, base: input.base };
    });
  }

  async remove(actor: Identity, name: string) {
    if (name === "founder")
      throw new ForgeError("role_protected", "Kurucu rolü kaldırılamaz.", 409);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const holders = await tx
        .selectFrom("memberships")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("role", "=", name as MemberRole)
        .executeTakeFirstOrThrow();
      if (Number(holders.n) > 0)
        throw new ForgeError(
          "role_in_use",
          "Rolde üye varken kaldırılamaz; önce üyeleri taşıyın.",
          409,
        );
      const existing = await tx
        .selectFrom("role_registry")
        .select(["kind", "deleted"])
        .where("tenant_id", "=", actor.tenantId)
        .where("name", "=", name)
        .executeTakeFirst();
      const kind =
        existing?.kind ??
        ((MEMBER_ROLES as readonly string[]).includes(name)
          ? "builtin"
          : "custom");
      if (existing && !existing.deleted) {
        await tx
          .updateTable("role_registry")
          .set({ deleted: 1 })
          .where("tenant_id", "=", actor.tenantId)
          .where("name", "=", name)
          .execute();
      } else if (!existing) {
        await tx
          .insertInto("role_registry")
          .values({
            tenant_id: actor.tenantId,
            name,
            kind,
            base: null,
            tools_json: null,
            deleted: 1,
            created_by: actor.userId,
            created_at: Date.now(),
          })
          .execute();
      }
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "role.removed",
          detail: JSON.stringify({ name }),
          created_at: Date.now(),
        })
        .execute();
      return { name };
    });
  }

  async restore(actor: Identity, name: string) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const existing = await tx
        .selectFrom("role_registry")
        .select("deleted")
        .where("tenant_id", "=", actor.tenantId)
        .where("name", "=", name)
        .executeTakeFirst();
      if (!existing || !existing.deleted) return { name, restored: false };
      const updated = await tx
        .updateTable("role_registry")
        .set({ deleted: 0 })
        .where("tenant_id", "=", actor.tenantId)
        .where("name", "=", name)
        .where("deleted", "=", 1)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) < 1)
        return { name, restored: false };
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "role.restored",
          detail: JSON.stringify({ name }),
          created_at: Date.now(),
        })
        .execute();
      return { name, restored: true };
    });
  }

  /** Whether a membership role may invoke an MCP tool (fail closed). */
  static async allowedTool(
    db: Kysely<DB>,
    tenantId: string,
    role: string,
    tool: string,
  ): Promise<boolean> {
    const resolved = await resolveRole(db, tenantId, role);
    if (!resolved) return false;
    return (resolved.tools as readonly string[]).includes(tool);
  }

  /** Rank check for grants: target must not outrank the grantor. */
  static async assertGrantable(
    db: Kysely<DB>,
    tenantId: string,
    grantorRole: string,
    targetRole: string,
  ) {
    if (targetRole === "founder")
      throw new ForgeError("grant_denied", "Kurucu rolü verilemez.", 403);
    const grantor = await resolveRole(db, tenantId, grantorRole);
    const target = await resolveRole(db, tenantId, targetRole);
    if (!grantor || !target)
      throw new ForgeError("grant_denied", "Rol çözümlenemedi.", 403);
    if (roleRank(targetRole, target.base) > roleRank(grantorRole, grantor.base))
      throw new ForgeError(
        "grant_denied",
        "Kendi yetkinin üstünde rol verilemez.",
        403,
      );
  }
}
