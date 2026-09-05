import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { IdentityService, type Identity } from "./identity.js";
import {
  settingsSchema,
  resolveSettings,
  defaultSettings,
  type Settings,
} from "../domain/settings.js";
import { ForgeError } from "../domain/errors.js";
export class SettingsService {
  constructor(
    readonly identity: IdentityService,
    readonly systemPolicy: Settings = {},
  ) {}
  private async check(identity: Identity, scope: string, write: boolean) {
    if (scope === "policy") return this.identity.authorize(identity, "admin");
    if (scope === "workspace")
      return this.identity.authorize(identity, write ? "admin" : "read");
    if (scope === `personal:${identity.userId}`)
      return this.identity.authorize(identity, "read");
    if (scope.startsWith("project:"))
      return this.identity.authorize(
        identity,
        write ? "write" : "read",
        scope.slice(8),
      );
    throw new ForgeError(
      "invalid_scope",
      "Kapsam yetkili kullanıcı/proje ile eşleşmiyor.",
      403,
    );
  }
  async get(identity: Identity, scope: string) {
    await this.check(identity, scope, false);
    const row = await this.identity.db
      .selectFrom("config_revisions")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("scope_key", "=", scope)
      .orderBy("revision", "desc")
      .limit(1)
      .executeTakeFirst();
    return {
      revision: row?.revision ?? 0,
      values: row ? settingsSchema.parse(JSON.parse(row.payload)) : {},
    };
  }
  async update(
    identity: Identity,
    scope: string,
    baseRevision: number,
    values: unknown,
  ) {
    const parsed = settingsSchema.parse(values);
    await this.check(identity, scope, true);
    try {
      return await this.identity.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", identity.tenantId)
          .execute();
        const service = new SettingsService(
          new IdentityService(tx),
          this.systemPolicy,
        );
        await service.check(identity, scope, true);
        const current = await service.get(identity, scope);
        if (current.revision !== baseRevision)
          throw new ForgeError(
            "revision_conflict",
            "Ayarlar başka işlemde değişti; güncel sürümü okuyun.",
            409,
          );
        const id = randomUUID();
        await tx
          .insertInto("config_revisions")
          .values({
            tenant_id: identity.tenantId,
            id,
            scope_key: scope,
            revision: baseRevision + 1,
            payload: JSON.stringify(parsed),
            created_by: identity.userId,
            created_at: Date.now(),
          })
          .execute();
        await tx
          .insertInto("audit_events")
          .values({
            tenant_id: identity.tenantId,
            id: randomUUID(),
            user_id: identity.userId,
            project_id: scope.startsWith("project:") ? scope.slice(8) : null,
            kind: "settings.updated",
            detail: JSON.stringify({ scope, revision: baseRevision + 1 }),
            created_at: Date.now(),
          })
          .execute();
        return { revision: baseRevision + 1, values: parsed };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
        throw new ForgeError(
          "revision_conflict",
          "Ayar sürümü eşzamanlı değişti.",
          409,
        );
      throw error;
    }
  }
  async effective(
    identity: Identity,
    projectId?: string,
    session: Settings = {},
  ) {
    const layers = [
      {
        source: "workspace",
        values: (await this.get(identity, "workspace")).values,
      },
    ];
    if (projectId)
      layers.push({
        source: `project:${projectId}`,
        values: (await this.get(identity, `project:${projectId}`)).values,
      });
    layers.push(
      {
        source: `personal:${identity.userId}`,
        values: (await this.get(identity, `personal:${identity.userId}`))
          .values,
      },
      { source: "session", values: session },
    );
    await this.identity.authorize(identity, "read", projectId);
    const row = await this.identity.db
      .selectFrom("config_revisions")
      .select("payload")
      .where("tenant_id", "=", identity.tenantId)
      .where("scope_key", "=", "policy")
      .orderBy("revision", "desc")
      .limit(1)
      .executeTakeFirst();
    const tenantPolicy = row
      ? settingsSchema.parse(JSON.parse(row.payload))
      : {};
    const initial = { ...defaultSettings, ...tenantPolicy };
    const upper = resolveSettings({ ...initial, ...this.systemPolicy }, [
      { source: "tenant_policy", values: tenantPolicy },
    ]);
    const result = resolveSettings(upper.values, layers);
    for (const key of Object.keys(result.sources))
      if (result.sources[key] === "system_policy")
        result.sources[key] = Object.hasOwn(this.systemPolicy, key)
          ? "operator_policy"
          : Object.hasOwn(tenantPolicy, key)
            ? "tenant_policy"
            : "system_default";
    return result;
  }
}
