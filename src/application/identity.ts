import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { normalizeRole } from "./roles.js";
import { ensureDefaultEnvironment } from "./environments.js";
import { ForgeError } from "../domain/errors.js";
export interface Identity {
  userId: string;
  tenantId: string;
}
export type Permission = "read" | "run" | "write" | "admin";
export class IdentityService {
  constructor(readonly db: Kysely<DB>) {}
  async bootstrapLocal(): Promise<Identity> {
    const identity = { userId: "local-owner", tenantId: "local" };
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("users")
        .values({
          id: identity.userId,
          subject: "local-owner",
          display_name: "Yerel sahip",
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await tx
        .insertInto("tenants")
        .values({
          id: identity.tenantId,
          name: "Kişisel çalışma alanı",
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await tx
        .insertInto("memberships")
        .values({
          tenant_id: identity.tenantId,
          user_id: identity.userId,
          role: "founder",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
      await ensureDefaultEnvironment(tx, identity.tenantId);
    });
    return identity;
  }
  async authorize(
    identity: Identity,
    permission: Permission,
    projectId?: string,
  ) {
    const member = await this.db
      .selectFrom("memberships")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .executeTakeFirst();
    if (!member || member.disabled)
      throw new ForgeError("forbidden", "Çalışma alanına erişim yok.", 403);
    const normalized = await normalizeRole(
      this.db,
      identity.tenantId,
      member.role,
    );
    if (!normalized)
      throw new ForgeError("forbidden", "Rol kullanılamıyor.", 403);
    if (permission !== "read") {
      const lifecycle = await this.db
        .selectFrom("tenant_lifecycle")
        .select("frozen")
        .where("tenant_id", "=", identity.tenantId)
        .executeTakeFirst();
      if (lifecycle?.frozen)
        throw new ForgeError(
          "tenant_frozen",
          "Organizasyon silinmeyi bekliyor; yazma işlemleri kapalı.",
          403,
        );
    }
    const administrator = normalized === "founder" || normalized === "admin";
    if (permission === "admin" && !administrator)
      throw new ForgeError("forbidden", "Yönetici yetkisi gerekiyor.", 403);
    let role: string = normalized;
    if (projectId) {
      const project = await this.db
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!project)
        throw new ForgeError(
          "project_unavailable",
          "Proje bulunamadı veya yetkiniz yok.",
          404,
        );
      if (!administrator) {
        const access = await this.db
          .selectFrom("project_members")
          .select("role")
          .where("tenant_id", "=", identity.tenantId)
          .where("project_id", "=", projectId)
          .where("user_id", "=", identity.userId)
          .executeTakeFirst();
        if (!access)
          throw new ForgeError("forbidden", "Proje üyeliği gerekiyor.", 403);
        // A project reader/auditor cannot elevate through project membership.
        role =
          normalized === "reader" || normalized === "auditor"
            ? normalized
            : access.role;
      }
    }
    if (
      (permission === "write" || permission === "run") &&
      (role === "reader" || role === "auditor")
    )
      throw new ForgeError(
        "forbidden",
        "Salt okunur üyelik bu işleme izin vermiyor.",
        403,
      );
    return role;
  }
  async createProject(
    identity: Identity,
    name: string,
    environmentId?: string,
  ) {
    await this.authorize(identity, "admin");
    if (!name.trim() || name.length > 200)
      throw new ForgeError(
        "invalid_project",
        "Proje adı 1–200 karakter olmalıdır.",
      );
    let environment_id: string;
    if (environmentId) {
      const env = await this.db
        .selectFrom("environments")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", environmentId)
        .executeTakeFirst();
      if (!env)
        throw new ForgeError(
          "environment_unavailable",
          "Ortam bulunamadı.",
          404,
        );
      environment_id = env.id;
    } else {
      environment_id = await ensureDefaultEnvironment(
        this.db,
        identity.tenantId,
      );
    }
    const project = {
      tenant_id: identity.tenantId,
      id: randomUUID(),
      name: name.trim(),
      environment_id,
      created_at: Date.now(),
    };
    await this.db.insertInto("projects").values(project).execute();
    return project;
  }
  async listProjects(identity: Identity) {
    const role = await this.authorize(identity, "read");
    let query = this.db
      .selectFrom("projects")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId);
    if (role !== "founder" && role !== "admin")
      query = query.where(
        "id",
        "in",
        this.db
          .selectFrom("project_members")
          .select("project_id")
          .where("tenant_id", "=", identity.tenantId)
          .where("user_id", "=", identity.userId),
      );
    return query.orderBy("id").limit(100).execute();
  }
  async issueSession(
    userId: string,
    kind: "session" | "pairing" | "device",
    ttlMs: number,
  ) {
    const token = randomBytes(32).toString("base64url");
    await this.db
      .insertInto("auth_sessions")
      .values({
        id: randomUUID(),
        user_id: userId,
        token_hash: createHash("sha256").update(token).digest("hex"),
        expires_at: Date.now() + ttlMs,
        revoked: 0,
        kind,
        created_at: Date.now(),
      })
      .execute();
    return token;
  }
  async authenticate(
    token: string,
    tenantId: string,
    kind: "session" | "device" = "session",
  ): Promise<Identity> {
    const session = await this.db
      .selectFrom("auth_sessions")
      .select("user_id")
      .where(
        "token_hash",
        "=",
        createHash("sha256").update(token).digest("hex"),
      )
      .where("kind", "=", kind)
      .where("revoked", "=", 0)
      .where("expires_at", ">", Date.now())
      .executeTakeFirst();
    if (!session)
      throw new ForgeError(
        "unauthorized",
        "Oturum geçersiz veya süresi doldu.",
        401,
      );
    const identity = { userId: session.user_id, tenantId };
    await this.authorize(identity, "read");
    return identity;
  }
  async redeemPairing(token: string) {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable("auth_sessions")
        .set({ revoked: 1 })
        .where(
          "token_hash",
          "=",
          createHash("sha256").update(token).digest("hex"),
        )
        .where("kind", "=", "pairing")
        .where("revoked", "=", 0)
        .where("expires_at", ">", Date.now())
        .returning("user_id")
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "pairing_invalid",
          "Eşleme kodu geçersiz, kullanılmış veya süresi dolmuş.",
          401,
        );
      return new IdentityService(tx).issueSession(
        row.user_id,
        "session",
        12 * 60 * 60 * 1000,
      );
    });
  }
  /** Resolve a provisioned user by namespaced subject (issuer|sub). Invite-gated: unknown subjects are rejected. */
  async userIdForSubject(subject: string) {
    const user = await this.db
      .selectFrom("users")
      .select("id")
      .where("subject", "=", subject)
      .executeTakeFirst();
    if (!user)
      throw new ForgeError(
        "membership_required",
        "Hesap yöneticisi kullanıcı üyeliğini tanımlamalıdır.",
        403,
      );
    return user.id;
  }
  async revoke(token: string) {
    await this.db
      .updateTable("auth_sessions")
      .set({ revoked: 1 })
      .where(
        "token_hash",
        "=",
        createHash("sha256").update(token).digest("hex"),
      )
      .execute();
  }
}
