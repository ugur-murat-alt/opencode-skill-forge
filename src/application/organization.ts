import { randomBytes, randomUUID, createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { DB } from "../storage/schema.js";
import { type MemberRole } from "../domain/roles.js";
import { IdentityService, type Identity } from "./identity.js";
import { ensureDefaultEnvironment } from "./environments.js";
import { RoleService, resolveRole } from "./roles.js";
import { terminalStates } from "../jobs/queue.js";
import { ForgeError } from "../domain/errors.js";

export const INVITE_TTL_MAX_MS = 30 * 86400000;
export const INVITE_TTL_DEFAULT_MS = 7 * 86400000;
export const INVITE_PENDING_LIMIT = 50;
export const INVITE_HOURLY_LIMIT = 20;
export const TRANSFER_TTL_MS = 7 * 86400000;
export const DELETION_GRACE_MS = 24 * 3600 * 1000;

const TENANT_TABLES = [
  "run_attempts",
  "revision_readers",
  "run_revision_pins",
  "execution_revision_pins",
  "package_gc",
  "package_deletions",
  "outbox",
  "executions",
  "runs",
  "forge_sessions",
  "skill_revisions",
  "skills",
  "skill_overrides",
  "skill_observations",
  "maintenance_items",
  "learning_entries",
  "learning_history",
  "learning_imports",
  "imported_rewrites",
  "rewrite_imports",
  "rewrite_import_links",
  "flag_imports",
  "migration_receipts",
  "session_preferences",
  "project_bindings",
  "project_members",
  "projects",
  "config_revisions",
  "provider_profiles",
  "client_installations",
  "queue_fairness",
  "budget_accounts",
  "budget_reservations",
  "invitations",
  "transfer_offers",
  "tenant_lifecycle",
  "audit_events",
  "role_registry",
  "agent_prompts",
  "environments",
  "memberships",
] as const;

function audit(
  tx: Transaction<DB>,
  entry: {
    tenant_id: string;
    user_id: string;
    project_id?: string | null;
    kind: string;
    detail: unknown;
  },
) {
  return tx
    .insertInto("audit_events")
    .values({
      tenant_id: entry.tenant_id,
      id: randomUUID(),
      user_id: entry.user_id,
      project_id: entry.project_id ?? null,
      kind: entry.kind,
      detail: JSON.stringify(entry.detail),
      created_at: Date.now(),
    })
    .execute();
}

export class OrganizationService {
  constructor(readonly db: Kysely<DB>) {}

  async listTenants(userId: string) {
    return this.db
      .selectFrom("memberships as m")
      .innerJoin("tenants as t", "t.id", "m.tenant_id")
      .select(["m.tenant_id", "m.user_id", "m.role", "m.disabled", "t.name"])
      .where("m.user_id", "=", userId)
      .orderBy("m.tenant_id")
      .execute();
  }

  async createOrganization(userId: string, name: string) {
    const clean = name.trim();
    if (!clean || clean.length > 200)
      throw new ForgeError(
        "invalid_organization",
        "Organizasyon adı 1–200 karakter olmalıdır.",
      );
    return this.db.transaction().execute(async (tx) => {
      const tenant = {
        id: randomUUID(),
        name: clean,
        created_at: Date.now(),
      };
      await tx.insertInto("tenants").values(tenant).execute();
      await tx
        .insertInto("memberships")
        .values({
          tenant_id: tenant.id,
          user_id: userId,
          role: "founder",
          generation: 0,
        })
        .execute();
      await ensureDefaultEnvironment(tx, tenant.id);
      await audit(tx, {
        tenant_id: tenant.id,
        user_id: userId,
        kind: "organization.created",
        detail: { name: clean },
      });
      return tenant;
    });
  }

  async createInvite(actor: Identity, raw: { role: string; ttlMs?: number }) {
    const input = z
      .object({
        role: z.string().min(1).max(64),
        ttlMs: z.number().int().positive().max(INVITE_TTL_MAX_MS).optional(),
      })
      .strict()
      .parse({ role: raw.role, ttlMs: raw.ttlMs });
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const actorRole = await auth.authorize(actor, "admin");
      await RoleService.assertGrantable(
        tx,
        actor.tenantId,
        actorRole,
        input.role,
      );
      const now = Date.now();
      const pending = await tx
        .selectFrom("invitations")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("revoked", "=", 0)
        .where("accepted_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirstOrThrow();
      if (Number(pending.n) >= INVITE_PENDING_LIMIT)
        throw new ForgeError(
          "invite_quota",
          "Bekleyen davet kotası doldu.",
          429,
        );
      const recent = await tx
        .selectFrom("invitations")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("created_at", ">", now - 3600000)
        .executeTakeFirstOrThrow();
      if (Number(recent.n) >= INVITE_HOURLY_LIMIT)
        throw new ForgeError(
          "invite_rate_limited",
          "Saatlik davet sınırı aşıldı.",
          429,
        );
      const token = randomBytes(32).toString("base64url");
      const invite = {
        tenant_id: actor.tenantId,
        id: randomUUID(),
        token_hash: createHash("sha256").update(token).digest("hex"),
        role: input.role,
        invited_by: actor.userId,
        expires_at: now + (input.ttlMs ?? INVITE_TTL_DEFAULT_MS),
        accepted_at: null,
        created_at: now,
      };
      await tx.insertInto("invitations").values(invite).execute();
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "invite.created",
        detail: { invite_id: invite.id, role: invite.role },
      });
      return {
        id: invite.id,
        token,
        role: invite.role,
        expires_at: invite.expires_at,
      };
    });
  }

  async listInvites(actor: Identity) {
    await new IdentityService(this.db).authorize(actor, "admin");
    return this.db
      .selectFrom("invitations")
      .select([
        "id",
        "role",
        "invited_by",
        "expires_at",
        "accepted_at",
        "revoked",
        "created_at",
      ])
      .where("tenant_id", "=", actor.tenantId)
      .where("revoked", "=", 0)
      .where("accepted_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
  }

  async listOffers(actor: Identity) {
    await new IdentityService(this.db).authorize(actor, "read");
    return this.db
      .selectFrom("transfer_offers")
      .select([
        "id",
        "to_user_id",
        "created_by",
        "expires_at",
        "accepted_at",
        "created_at",
      ])
      .where("tenant_id", "=", actor.tenantId)
      .where("accepted_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();
  }

  async deletionStatus(actor: Identity) {
    await new IdentityService(this.db).authorize(actor, "read");
    const row = await this.db
      .selectFrom("tenant_lifecycle")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .executeTakeFirst();
    if (!row?.deletion_requested_at) return { requested: false as const };
    return {
      requested: true as const,
      requested_at: row.deletion_requested_at,
      requested_by: row.deletion_requested_by,
      frozen: Boolean(row.frozen),
    };
  }

  async revokeInvite(actor: Identity, id: string) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const updated = await tx
        .updateTable("invitations")
        .set({ revoked: 1 })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .where("revoked", "=", 0)
        .where("accepted_at", "is", null)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) < 1)
        throw new ForgeError(
          "invite_unavailable",
          "Davet bulunamadı veya işlem gördü.",
          404,
        );
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "invite.revoked",
        detail: { invite_id: id },
      });
      return { id };
    });
  }

  async acceptInvite(raw: {
    token: string;
    subject: string;
    display_name: string;
  }) {
    const input = z
      .object({
        token: z.string().min(20).max(200),
        subject: z.string().min(1).max(1000),
        display_name: z.string().min(1).max(200),
      })
      .strict()
      .parse(raw);
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    return this.db.transaction().execute(async (tx) => {
      const invite = await tx
        .selectFrom("invitations")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!invite)
        throw new ForgeError("invite_invalid", "Davet bulunamadı.", 404);
      if (invite.revoked)
        throw new ForgeError("invite_revoked", "Davet iptal edilmiş.", 410);
      if (invite.accepted_at)
        throw new ForgeError("invite_redeemed", "Davet zaten kullanıldı.", 409);
      if (invite.expires_at <= Date.now())
        throw new ForgeError("invite_expired", "Davetin süresi dolmuş.", 410);
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
      const existing = await tx
        .selectFrom("memberships")
        .select("role")
        .where("tenant_id", "=", invite.tenant_id)
        .where("user_id", "=", user.id)
        .executeTakeFirst();
      if (existing)
        throw new ForgeError(
          "already_member",
          "Bu hesap zaten organizasyon üyesi.",
          409,
        );
      const lifecycle = await tx
        .selectFrom("tenant_lifecycle")
        .select(["frozen", "deletion_requested_at"])
        .where("tenant_id", "=", invite.tenant_id)
        .executeTakeFirst();
      if (lifecycle?.frozen)
        throw new ForgeError(
          "tenant_frozen",
          "Organizasyon silinmeyi bekliyor; yeni üye kabul edilmez.",
          403,
        );
      const definition = await resolveRole(tx, invite.tenant_id, invite.role);
      if (!definition)
        throw new ForgeError(
          "role_unavailable",
          "Davet rolü artık kullanılamıyor.",
          409,
        );
      const claimed = await tx
        .updateTable("invitations")
        .set({ accepted_at: Date.now() })
        .where("tenant_id", "=", invite.tenant_id)
        .where("id", "=", invite.id)
        .where("accepted_at", "is", null)
        .where("revoked", "=", 0)
        .where("expires_at", ">", Date.now())
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows ?? 0) < 1) {
        const current = await tx
          .selectFrom("invitations")
          .select(["revoked", "expires_at", "accepted_at"])
          .where("tenant_id", "=", invite.tenant_id)
          .where("id", "=", invite.id)
          .executeTakeFirst();
        if (current?.revoked)
          throw new ForgeError("invite_revoked", "Davet iptal edilmiş.", 410);
        if (current && current.expires_at <= Date.now())
          throw new ForgeError("invite_expired", "Davetin süresi dolmuş.", 410);
        throw new ForgeError(
          "invite_redeemed",
          "Davet başka işlemde kullanıldı.",
          409,
        );
      }
      await tx
        .insertInto("memberships")
        .values({
          tenant_id: invite.tenant_id,
          user_id: user.id,
          role: invite.role as MemberRole,
          generation: 0,
        })
        .execute();
      await audit(tx, {
        tenant_id: invite.tenant_id,
        user_id: user.id,
        kind: "invite.accepted",
        detail: { invite_id: invite.id, role: invite.role },
      });
      return {
        tenant_id: invite.tenant_id,
        user_id: user.id,
        role: invite.role,
      };
    });
  }

  async offerTransfer(actor: Identity, toUserId: string) {
    if (toUserId === actor.userId)
      throw new ForgeError("transfer_self_denied", "Devir kendine yapılamaz.");
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const role = await auth.authorize(actor, "read");
      if (role !== "founder")
        throw new ForgeError(
          "forbidden",
          "Devir yalnız kurucu tarafından başlatılır.",
          403,
        );
      const frozen = await tx
        .selectFrom("tenant_lifecycle")
        .select("frozen")
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirst();
      if (frozen?.frozen)
        throw new ForgeError(
          "tenant_frozen",
          "Silinmeyi bekleyen organizasyonda devir yapılamaz.",
          403,
        );
      const target = await tx
        .selectFrom("memberships")
        .select(["role", "disabled"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", toUserId)
        .executeTakeFirst();
      if (!target || target.disabled)
        throw new ForgeError(
          "transfer_recipient_invalid",
          "Alıcı aktif üye olmalıdır.",
          409,
        );
      await tx
        .deleteFrom("transfer_offers")
        .where("tenant_id", "=", actor.tenantId)
        .where("accepted_at", "is", null)
        .execute();
      const now = Date.now();
      const offer = {
        tenant_id: actor.tenantId,
        id: randomUUID(),
        to_user_id: toUserId,
        created_by: actor.userId,
        expires_at: now + TRANSFER_TTL_MS,
        accepted_at: null,
        created_at: now,
      };
      await tx.insertInto("transfer_offers").values(offer).execute();
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "transfer.offered",
        detail: { offer_id: offer.id, to_user_id: toUserId },
      });
      return { id: offer.id, expires_at: offer.expires_at };
    });
  }

  async acceptTransfer(actor: Identity, offerId: string) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const offer = await tx
        .selectFrom("transfer_offers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", offerId)
        .executeTakeFirst();
      if (!offer || offer.accepted_at)
        throw new ForgeError(
          "transfer_invalid",
          "Devir teklifi geçersiz.",
          404,
        );
      if (offer.expires_at <= Date.now())
        throw new ForgeError(
          "transfer_expired",
          "Devir teklifinin süresi dolmuş.",
          410,
        );
      if (offer.to_user_id !== actor.userId)
        throw new ForgeError(
          "transfer_not_recipient",
          "Teklifi yalnız alıcı kabul edebilir.",
          403,
        );
      const auth = new IdentityService(tx);
      const recipient = await tx
        .selectFrom("memberships")
        .select("disabled")
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .executeTakeFirst();
      if (!recipient || recipient.disabled)
        throw new ForgeError(
          "transfer_recipient_invalid",
          "Alıcı artık aktif üye değil.",
          409,
        );
      await auth.authorize(actor, "read");
      const frozen = await tx
        .selectFrom("tenant_lifecycle")
        .select("frozen")
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirst();
      if (frozen?.frozen)
        throw new ForgeError(
          "tenant_frozen",
          "Silinmeyi bekleyen organizasyonda devir kabul edilemez.",
          403,
        );
      const now = Date.now();
      const claimed = await tx
        .updateTable("transfer_offers")
        .set({ accepted_at: now })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", offer.id)
        .where("to_user_id", "=", actor.userId)
        .where("accepted_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows ?? 0) < 1)
        throw new ForgeError(
          "transfer_invalid",
          "Devir teklifi başka işlemde kullanıldı.",
          409,
        );
      await tx
        .updateTable("memberships")
        .set({ role: "admin" })
        .where("tenant_id", "=", actor.tenantId)
        .where("role", "=", "founder")
        .execute();
      await tx
        .updateTable("memberships")
        .set({ role: "founder" })
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .execute();
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "transfer.accepted",
        detail: { offer_id: offer.id, previous_founder: offer.created_by },
      });
      return { tenant_id: actor.tenantId, founder: actor.userId };
    });
  }

  async requestDeletion(actor: Identity, name: string) {
    const clean = name.trim();
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const role = await auth.authorize(actor, "read");
      if (role !== "founder")
        throw new ForgeError(
          "forbidden",
          "Silme yalnız kurucu tarafından başlatılır.",
          403,
        );
      const tenant = await tx
        .selectFrom("tenants")
        .select(["id", "name"])
        .where("id", "=", actor.tenantId)
        .executeTakeFirstOrThrow();
      if (tenant.name !== clean)
        throw new ForgeError(
          "confirmation_mismatch",
          "Organizasyon adı doğrulanamadı.",
          409,
        );
      const now = Date.now();
      await tx
        .insertInto("tenant_lifecycle")
        .values({
          tenant_id: actor.tenantId,
          frozen: 1,
          deletion_requested_at: now,
          deletion_requested_by: actor.userId,
        })
        .onConflict((oc) =>
          oc.column("tenant_id").doUpdateSet({
            frozen: 1,
            deletion_requested_at: now,
            deletion_requested_by: actor.userId,
          }),
        )
        .execute();
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "organization.deletion_requested",
        detail: { grace_ms: DELETION_GRACE_MS },
      });
      const cancelled = await tx
        .updateTable("runs")
        .set({
          state: "cancelled",
          error_code: "deletion_frozen",
          lease_until: 0,
          fence: sql`fence + 1`,
          updated_at: now,
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("state", "not in", terminalStates)
        .returning("id")
        .execute();
      if (cancelled.length)
        await tx
          .updateTable("run_attempts")
          .set({ ended_at: now, result: "deletion_frozen" })
          .where("tenant_id", "=", actor.tenantId)
          .where(
            "run_id",
            "in",
            cancelled.map((r) => r.id),
          )
          .where("ended_at", "is", null)
          .execute();
      return {
        tenant_id: actor.tenantId,
        requested_at: now,
        grace_until: now + DELETION_GRACE_MS,
      };
    });
  }

  async cancelDeletion(actor: Identity) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const role = await auth.authorize(actor, "read");
      if (role !== "founder")
        throw new ForgeError("forbidden", "Yalnız kurucu vazgeçebilir.", 403);
      await tx
        .deleteFrom("tenant_lifecycle")
        .where("tenant_id", "=", actor.tenantId)
        .execute();
      await audit(tx, {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        kind: "organization.deletion_cancelled",
        detail: {},
      });
      return { tenant_id: actor.tenantId };
    });
  }

  async confirmDeletion(actor: Identity, name: string) {
    const clean = name.trim();
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const role = await auth.authorize(actor, "read");
      if (role !== "founder")
        throw new ForgeError(
          "forbidden",
          "Silme yalnız kurucu tarafından onaylanır.",
          403,
        );
      const tenant = await tx
        .selectFrom("tenants")
        .select(["id", "name"])
        .where("id", "=", actor.tenantId)
        .executeTakeFirst();
      if (!tenant || tenant.name !== clean)
        throw new ForgeError(
          "confirmation_mismatch",
          "Organizasyon adı doğrulanamadı.",
          409,
        );
      const lifecycle = await tx
        .selectFrom("tenant_lifecycle")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirst();
      if (
        !lifecycle?.deletion_requested_at ||
        Date.now() - lifecycle.deletion_requested_at < DELETION_GRACE_MS
      )
        throw new ForgeError(
          "deletion_grace_active",
          "Bekleme süresi dolmadan silme onaylanamaz.",
          409,
        );
      const removed: Record<string, number> = {};
      for (const table of TENANT_TABLES) {
        const result = await tx
          .deleteFrom(table as "memberships")
          .where("tenant_id", "=", actor.tenantId)
          .executeTakeFirst();
        removed[table] = Number(result.numDeletedRows ?? 0);
      }
      await tx.deleteFrom("tenants").where("id", "=", actor.tenantId).execute();
      return { deleted_tenant_id: actor.tenantId, removed };
    });
  }
}
