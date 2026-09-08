import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../storage/database.js";
import type { Settings } from "../domain/settings.js";
import { IdentityService, type Identity } from "./identity.js";
import { SettingsService } from "./settings.js";
import { terminalStates } from "../jobs/queue.js";
import { redact } from "../telemetry/redact.js";
import { PRODUCT_VERSION } from "../cli/config.js";
const expiredInput = JSON.stringify({ content_expired: true });
const safeDetail = (raw: string) => {
  try {
    const value = JSON.parse(raw),
      keys = [
        "skill_id",
        "revision",
        "base_revision",
        "run_id",
        "operation_id",
        "status",
        "action",
        "code",
        "scope",
      ];
    return redact(
      Object.fromEntries(
        keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]),
      ),
    );
  } catch {
    return { invalid_metadata: true };
  }
};
export class TelemetryService {
  constructor(
    readonly storage: DatabaseHandle,
    readonly policy: Settings = {},
  ) {}
  async support(actor: Identity, project: string) {
    await new IdentityService(this.storage.db).authorize(
      actor,
      "read",
      project,
    );
    const [settings, runs, events, installations] = await Promise.all([
      new SettingsService(
        new IdentityService(this.storage.db),
        this.policy,
      ).effective(actor, project),
      this.storage.db
        .selectFrom("runs")
        .select([
          "id",
          "kind",
          "state",
          "attempt",
          "error_code",
          "created_at",
          "updated_at",
        ])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .orderBy("updated_at", "desc")
        .limit(100)
        .execute(),
      this.storage.db
        .selectFrom("audit_events")
        .select(["id", "kind", "detail", "created_at"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .orderBy("created_at", "desc")
        .limit(100)
        .execute(),
      this.storage.db
        .selectFrom("client_installations")
        .select(["id", "client", "version", "last_seen", "last_event"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .limit(100)
        .execute(),
    ]);
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      product_version: PRODUCT_VERSION,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        database: this.storage.backend,
      },
      observation_scope: "current_user_project_metadata_only",
      bounded_rows_per_section: 100,
      settings: {
        values: Object.fromEntries(
          Object.entries(settings.values).filter(
            ([key]) => !key.endsWith("Origins"),
          ),
        ),
        allowed_origin_count: settings.values.allowedOrigins.length,
        script_origin_count: settings.values.scriptAllowedOrigins.length,
        sources: settings.sources,
      },
      runs,
      events: events.map((e) => ({ ...e, detail: safeDetail(e.detail) })),
      installations,
    };
  }
  async retain(actor: Identity, project: string) {
    const identity = new IdentityService(this.storage.db);
    await identity.authorize(actor, "read", project);
    const effective = await new SettingsService(
        identity,
        this.policy,
      ).effective(actor, project),
      cutoff = Date.now() - effective.values.retentionDays * 86400000;
    const result = await this.storage.db.transaction().execute(async (tx) => {
      await new IdentityService(tx).authorize(actor, "read", project);
      const rows = await tx
        .selectFrom("runs")
        .select(["id", "result_json", "state"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .where("state", "in", terminalStates)
        .where("updated_at", "<", cutoff)
        .where("input_json", "!=", expiredInput)
        .limit(200)
        .execute();
      for (const row of rows) {
        // Keep accounting and dedup identity; remove prompt/handoff/result content.
        const old = row.result_json ? JSON.parse(row.result_json) : null;
        await tx
          .updateTable("runs")
          .set({
            input_json: expiredInput,
            result_json: JSON.stringify({
              status: row.state,
              content_expired: true,
              usage: old?.usage ?? null,
            }),
          })
          .where("tenant_id", "=", actor.tenantId)
          .where("id", "=", row.id)
          .where("state", "in", terminalStates)
          .where("updated_at", "<", cutoff)
          .execute();
      }
      const observations = await tx
        .selectFrom("skill_observations")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .where("created_at", "<", cutoff)
        .limit(500)
        .execute();
      if (observations.length)
        await tx
          .deleteFrom("skill_observations")
          .where("tenant_id", "=", actor.tenantId)
          .where(
            "id",
            "in",
            observations.map((r) => r.id),
          )
          .execute();
      const lessons = await tx
        .selectFrom("learning_entries")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .where("created_at", "<", cutoff)
        .limit(200)
        .execute();
      if (lessons.length)
        await tx
          .deleteFrom("learning_entries")
          .where("tenant_id", "=", actor.tenantId)
          .where(
            "id",
            "in",
            lessons.map((r) => r.id),
          )
          .execute();
      const events = await tx
        .selectFrom("audit_events")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project)
        .where("created_at", "<", cutoff)
        .limit(500)
        .execute();
      if (events.length)
        await tx
          .deleteFrom("audit_events")
          .where("tenant_id", "=", actor.tenantId)
          .where(
            "id",
            "in",
            events.map((r) => r.id),
          )
          .execute();
      return {
        scrubbed_runs: rows.length,
        deleted_observations: observations.length,
        deleted_lessons: lessons.length,
        deleted_events: events.length,
        may_have_more:
          rows.length === 200 ||
          observations.length === 500 ||
          lessons.length === 200 ||
          events.length === 500,
      };
    });
    if (
      result.scrubbed_runs +
      result.deleted_events +
      result.deleted_lessons +
      result.deleted_observations
    )
      await this.storage.db
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: project,
          kind: "telemetry.retained",
          created_at: Date.now(),
          detail: JSON.stringify({ cutoff, ...result }),
        })
        .execute();
    return {
      cutoff,
      retention_days: effective.values.retentionDays,
      ...result,
      preserved: [
        "active_runs",
        "idempotency_receipts",
        "budget_ledger",
        "package_revisions",
      ],
      backup_erasure: "not_performed",
    };
  }
  /** Rotating bounded sweep. Every actor/project is revisited even if older jobs were scrubbed. */
  private offset = 0;
  async sweep() {
    const groups = await this.storage.db
      .selectFrom("memberships as m")
      .innerJoin("projects as p", "p.tenant_id", "m.tenant_id")
      .select(["m.tenant_id", "m.user_id", "p.id as project_id"])
      .where((eb) =>
        eb.or([
          eb("m.role", "in", ["founder", "admin"]),
          eb.exists(
            eb
              .selectFrom("project_members as pm")
              .select("pm.project_id")
              .whereRef("pm.tenant_id", "=", "m.tenant_id")
              .whereRef("pm.user_id", "=", "m.user_id")
              .whereRef("pm.project_id", "=", "p.id"),
          ),
        ]),
      )
      .orderBy("m.tenant_id")
      .orderBy("m.user_id")
      .orderBy("p.id")
      .limit(25)
      .offset(this.offset)
      .execute();
    this.offset = groups.length === 25 ? this.offset + 25 : 0;
    for (const group of groups) {
      try {
        await this.retain(
          { tenantId: group.tenant_id, userId: group.user_id },
          group.project_id,
        );
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "status" in error &&
          [403, 404].includes(Number(error.status))
        ))
          throw error;
      }
    }
  }
}
