import { redact } from "../telemetry/redact.js";
import {
  storeExecutionResult,
  executionPage,
  byteChunk,
  type StoredExecution,
} from "./execution-results.js";
import { MaintenanceService } from "./maintenance.js";
import { observe } from "../telemetry/observations.js";
import { SettingsService } from "./settings.js";
import { join } from "node:path";
import { secureRead } from "../skills/paths.js";
import type { Settings } from "../domain/settings.js";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "./identity.js";
import { RoleService } from "./roles.js";
import { JobQueue } from "../jobs/queue.js";
import { PackageStore } from "../skills/store.js";
import { DockerExecutor } from "../execution/docker.js";
import { ForgeError, errorEnvelope } from "../domain/errors.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import { CursorCodec } from "./cursor.js";
import { validatePackagePath } from "../skills/paths.js";
import type { Run } from "../storage/schema.js";
export class ForgeService {
  readonly queue: JobQueue;
  readonly packages: PackageStore;
  readonly cursors: CursorCodec;
  constructor(
    readonly storage: DatabaseHandle,
    readonly dataDir: string,
    signingKey: string,
    readonly policy: Settings = {},
  ) {
    this.queue = new JobQueue(storage, policy);
    this.packages = new PackageStore(storage, dataDir);
    this.cursors = new CursorCodec(signingKey);
  }
  async artifact(identity: Identity, executionId: string, reference: string) {
    const execution = await this.storage.db
      .selectFrom("executions")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("id", "=", executionId)
      .executeTakeFirst();
    if (!execution)
      throw new ForgeError("artifact_unavailable", "Artifact bulunamadı.", 404);
    await new IdentityService(this.storage.db).authorize(
      identity,
      "read",
      execution.project_id,
    );
    const value = this.cursors.decode<{ execution: string; path: string }>(
      reference,
      [identity.tenantId, identity.userId, "artifact", executionId],
    );
    if (!/^[a-f0-9-]{36}$/.test(value.execution))
      throw new ForgeError("invalid_artifact", "Artifact kimliği geçersiz.");
    validatePackagePath(value.path);
    return {
      path: value.path,
      bytes: await secureRead(
        join(this.dataDir, "execution", value.execution, "artifacts"),
        value.path,
      ),
    };
  }
  private publicRun(run: Run, detail = false) {
    const result = run.result_json ? JSON.parse(run.result_json) : null;
    const bytes = Buffer.byteLength(run.result_json ?? "null");
    return {
      run_id: run.id,
      kind: run.kind,
      status: run.state,
      created_at: run.created_at,
      updated_at: run.updated_at,
      attempt: run.attempt,
      error_code: run.error_code,
      result: detail && bytes <= 8192 ? result : undefined,
      result_available: run.result_json !== null,
      result_truncated: run.result_json !== null && (!detail || bytes > 8192),
      result_bytes: bytes,
      result_summary: result
        ? redact({
            decision:
              typeof result.decision === "string"
                ? result.decision.slice(0, 32)
                : undefined,
            reason:
              typeof result.reason === "string"
                ? result.reason.slice(0, 500)
                : undefined,
            usage: result.usage
              ? Object.fromEntries(
                  ["calls", "tokens", "cost_micros", "elapsed_ms"].map(
                    (key) => [
                      key,
                      typeof result.usage[key] === "number" &&
                      Number.isFinite(result.usage[key])
                        ? result.usage[key]
                        : null,
                    ],
                  ),
                )
              : null,
            content_expired: result.content_expired === true,
          })
        : null,
    };
  }
  async invoke(
    name: ToolName,
    identity: Identity,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const input = toolSchemas[name].parse(raw);
    const member = await this.storage.db
      .selectFrom("memberships")
      .select("role")
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .executeTakeFirst();
    const allowed = await RoleService.allowedTool(
      this.storage.db,
      identity.tenantId,
      member?.role ?? "",
      name,
    );
    if (!allowed)
      throw new ForgeError(
        "tool_denied",
        "Bu rol bu araca erişemez.",
        403,
        undefined,
        { role: member?.role ?? "unknown", tool: name },
      );
    await new IdentityService(this.storage.db).authorize(
      identity,
      ["forge_run", "forge_handoff"].includes(name) ? "run" : "read",
      input.project_ref,
    );
    const binding = [
      identity.tenantId,
      identity.userId,
      name,
      { ...input, ...("cursor" in input ? { cursor: undefined } : {}) },
    ];
    if (name === "forge_search") {
      const value = toolSchemas.forge_search.parse(input),
        after = value.cursor
          ? this.cursors.decode<string>(value.cursor, binding)
          : undefined;
      const found = await this.packages.search(identity, {
        projectId: value.project_ref,
        query: value.query,
        scope: value.scope,
        limit: value.limit,
        after,
      });
      await observe(
        this.storage.db,
        identity,
        value.project_ref,
        "search_impression",
        found.items.filter((item) => item.revision !== null) as {
          skill_id: string;
          revision: string;
        }[],
      );
      return {
        items: found.items,
        next_cursor: found.next
          ? this.cursors.encode(binding, found.next)
          : null,
      };
    }
    if (name === "forge_load") {
      const value = toolSchemas.forge_load.parse(input);
      validatePackagePath(value.path);
      return this.packages.withRevision(
        identity,
        value.skill_id,
        value.revision,
        async () => {
          const loaded = await this.packages.files(
            identity,
            value.skill_id,
            value.revision,
            value.inventory ? [] : [value.path],
          );
          if (
            loaded.skill.project_id &&
            loaded.skill.project_id !== value.project_ref
          )
            throw new ForgeError(
              "project_mismatch",
              "Paket başka projeye ait.",
              403,
            );
          if (value.inventory) {
            const offset = value.cursor
              ? this.cursors.decode<number>(value.cursor, binding)
              : 0;
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              offset > loaded.manifest.files.length
            )
              throw new ForgeError(
                "invalid_cursor",
                "Envanter sayfası geçersiz.",
              );
            return {
              skill_id: value.skill_id,
              revision: value.revision,
              files: loaded.manifest.files
                .slice(offset, offset + 40)
                .map((f) => ({ path: f.path, bytes: f.bytes })),
              file_count: loaded.manifest.files.length,
              entrypoints: Object.keys(
                loaded.manifest.execution?.entrypoints ?? {},
              ),
              next_cursor:
                offset + 40 < loaded.manifest.files.length
                  ? this.cursors.encode(binding, offset + 40)
                  : null,
            };
          }
          const bytes = loaded.files[value.path];
          if (!bytes)
            throw new ForgeError(
              "file_unavailable",
              "Sabit sürümde dosya bulunamadı.",
              404,
            );
          const offset = value.cursor
            ? this.cursors.decode<number>(value.cursor, binding)
            : 0;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > bytes.length
          )
            throw new ForgeError("invalid_cursor", "Dosya aralığı geçersiz.");
          let end = Math.min(bytes.length, offset + 24576);
          const binary =
            !Buffer.from(bytes.toString("utf8")).equals(bytes) ||
            bytes.includes(0);
          if (!binary && end < bytes.length)
            while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
          await observe(
            this.storage.db,
            identity,
            value.project_ref,
            "loaded",
            [{ skill_id: value.skill_id, revision: value.revision }],
          );
          return {
            skill_id: value.skill_id,
            revision: value.revision,
            path: value.path,
            encoding: binary ? "base64" : "utf8",
            content: bytes
              .subarray(offset, end)
              .toString(binary ? "base64" : "utf8"),
            bytes: end - offset,
            total_bytes: bytes.length,
            files:
              value.path === "SKILL.md"
                ? loaded.manifest.files
                    .slice(0, 40)
                    .map((f) => ({ path: f.path, bytes: f.bytes }))
                : undefined,
            file_count: loaded.manifest.files.length,
            inventory_truncated: loaded.manifest.files.length > 40,
            entrypoints:
              value.path === "SKILL.md"
                ? Object.keys(loaded.manifest.execution?.entrypoints ?? {})
                : undefined,
            next_cursor:
              end < bytes.length ? this.cursors.encode(binding, end) : null,
          };
        },
      );
    }
    if (name === "forge_handoff") {
      const value = toolSchemas.forge_handoff.parse(input);
      if (!value.evidence.length)
        return {
          status: "rejected",
          reason: "evidence_required",
          run_id: null,
        };
      const accepted = await this.queue.accept(identity, {
        projectId: value.project_ref,
        kind: "skill_evolve",
        key: value.idempotency_key,
        payload: {
          summary: value.summary,
          source: value.source,
          evidence: value.evidence,
        },
      });
      return {
        status: accepted.status,
        run_id: accepted.run.id,
        retry_after_ms: 500,
      };
    }
    if (name === "forge_report") {
      const value = toolSchemas.forge_report.parse(input);
      if (value.section === "execution") {
        if (!value.execution_id || value.run_id || value.state)
          throw new ForgeError(
            "invalid_filter",
            "Çalıştırma raporu execution_id gerektirir.",
          );
        const row = await this.storage.db
          .selectFrom("executions")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("user_id", "=", identity.userId)
          .where("project_id", "=", value.project_ref)
          .where("id", "=", value.execution_id)
          .executeTakeFirst();
        if (!row)
          throw new ForgeError(
            "execution_unavailable",
            "Çalıştırma bulunamadı.",
            404,
          );
        if (value.result_content) {
          if (value.artifact_reference)
            throw new ForgeError(
              "invalid_filter",
              "Sonuç ve artifact içeriği aynı çağrıda seçilemez.",
            );
          if (!row.result_json)
            return { execution_id: row.id, status: "running_or_unknown" };
          const stored = JSON.parse(row.result_json) as StoredExecution;
          if (stored.status !== "completed")
            return executionPage(
              this.cursors,
              identity,
              value.project_ref,
              stored,
            );
          const resultBytes =
            stored.result_artifact_path && stored.sandbox_execution_id
              ? (
                  await this.artifact(
                    identity,
                    row.id,
                    this.cursors.encode(
                      [identity.tenantId, identity.userId, "artifact", row.id],
                      {
                        execution: stored.sandbox_execution_id,
                        path: stored.result_artifact_path,
                      },
                    ),
                  )
                ).bytes
              : Buffer.from(JSON.stringify(stored.result ?? null));
          const offset = value.cursor
            ? this.cursors.decode<number>(value.cursor, binding)
            : 0;
          const chunk = byteChunk(resultBytes, offset);
          return {
            execution_id: row.id,
            kind: "result_json",
            ...chunk,
            next: undefined,
            next_cursor:
              chunk.next !== null
                ? this.cursors.encode(binding, chunk.next)
                : null,
          };
        }
        if (value.artifact_reference) {
          const loaded = await this.artifact(
            identity,
            row.id,
            value.artifact_reference,
          );
          const offset = value.cursor
            ? this.cursors.decode<number>(value.cursor, binding)
            : 0;
          const chunk = byteChunk(loaded.bytes, offset);
          return {
            execution_id: row.id,
            path: loaded.path,
            ...chunk,
            next: undefined,
            next_cursor:
              chunk.next !== null
                ? this.cursors.encode(binding, chunk.next)
                : null,
          };
        }
        return row.result_json
          ? executionPage(
              this.cursors,
              identity,
              value.project_ref,
              JSON.parse(row.result_json),
              value.limit,
              value.cursor,
            )
          : {
              execution_id: row.id,
              status: "running_or_unknown",
              retry_safe: false,
            };
      }
      if (value.execution_id || value.artifact_reference)
        throw new ForgeError(
          "invalid_filter",
          "Artifact için execution rapor bölümünü kullanın.",
        );
      if (value.section === "maintenance") {
        if (value.run_id || value.state || value.result_content)
          throw new ForgeError(
            "invalid_filter",
            "Bakım raporunda iş filtresi kullanılamaz.",
          );
        const report = await new MaintenanceService(this.storage).report(
          identity,
          value.project_ref,
          {
            days: value.observation_days,
            limit: value.limit,
            after: value.cursor
              ? this.cursors.decode<string>(value.cursor, binding)
              : undefined,
          },
        );
        return {
          ...report,
          next: undefined,
          next_cursor: report.next
            ? this.cursors.encode(binding, report.next)
            : null,
        };
      }
      if (value.run_id) {
        const run = await this.queue.get(identity, value.run_id);
        if (run.project_id !== value.project_ref)
          throw new ForgeError(
            "project_mismatch",
            "İş başka projeye ait.",
            403,
          );
        if (value.result_content) {
          const resultBytes = Buffer.from(run.result_json ?? "null");
          const resultBinding = [
            ...binding,
            createHash("sha256").update(resultBytes).digest("hex"),
          ];
          const chunk = byteChunk(
            resultBytes,
            value.cursor
              ? this.cursors.decode<number>(value.cursor, resultBinding)
              : 0,
          );
          return {
            run_id: run.id,
            status: run.state,
            kind: "result_json",
            ...chunk,
            next: undefined,
            next_cursor:
              chunk.next !== null
                ? this.cursors.encode(resultBinding, chunk.next)
                : null,
          };
        }
        return this.publicRun(run, true);
      }
      if (value.result_content)
        throw new ForgeError(
          "invalid_filter",
          "İş sonucu içeriği için run_id gerekir.",
        );
      let query = this.storage.db
        .selectFrom("runs")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("project_id", "=", value.project_ref);
      if (value.state)
        query = query.where("state", "=", value.state as Run["state"]);
      if (value.cursor)
        query = query.where(
          "id",
          ">",
          this.cursors.decode<string>(value.cursor, binding),
        );
      const rows = await query
        .orderBy("id")
        .limit(value.limit + 1)
        .execute();
      return {
        items: rows.slice(0, value.limit).map((row) => this.publicRun(row)),
        next_cursor:
          rows.length > value.limit
            ? this.cursors.encode(binding, rows[value.limit - 1]!.id)
            : null,
      };
    }
    const value = toolSchemas.forge_run.parse(input);
    if (Buffer.byteLength(JSON.stringify(value.args)) > 32768)
      throw new ForgeError("input_limit", "Script JSON girdisi çok büyük.");
    const loaded = await this.packages.files(
      identity,
      value.skill_id,
      value.revision,
    );
    if (
      loaded.skill.project_id &&
      loaded.skill.project_id !== value.project_ref
    )
      throw new ForgeError("project_mismatch", "Paket başka projeye ait.", 403);
    const hash = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    const accepted = await this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", identity.tenantId)
        .execute();
      await new IdentityService(tx).authorize(
        identity,
        "run",
        value.project_ref,
      );
      const existing = await tx
        .selectFrom("executions")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("project_id", "=", value.project_ref)
        .where("idempotency_key", "=", value.idempotency_key)
        .executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash)
          throw new ForgeError(
            "idempotency_conflict",
            "Script anahtarı başka girdiye ait.",
            409,
          );
        return { fresh: false, row: existing };
      }
      const row = {
        tenant_id: identity.tenantId,
        id: randomUUID(),
        user_id: identity.userId,
        project_id: value.project_ref,
        idempotency_key: value.idempotency_key,
        input_hash: hash,
        state: "running",
        result_json: null,
        created_at: Date.now(),
      };
      await tx.insertInto("executions").values(row).execute();
      await tx
        .insertInto("execution_revision_pins")
        .values({
          tenant_id: identity.tenantId,
          execution_id: row.id,
          skill_id: value.skill_id,
          revision: value.revision,
          created_at: row.created_at,
        })
        .execute();
      return { fresh: true, row };
    });
    if (!accepted.fresh)
      return accepted.row.result_json
        ? executionPage(
            this.cursors,
            identity,
            value.project_ref,
            JSON.parse(accepted.row.result_json),
          )
        : {
            execution_id: accepted.row.id,
            status: "running_or_unknown",
            retry_safe: false,
          };
    let result: StoredExecution;
    const permissionAbort = new AbortController();
    let checking = false;
    const permissionTimer = setInterval(() => {
      if (checking) return;
      checking = true;
      void new IdentityService(this.storage.db)
        .authorize(identity, "run", value.project_ref)
        .catch(() =>
          permissionAbort.abort(
            new ForgeError(
              "permission_revoked",
              "Script çalıştırma yetkisi artık doğrulanamıyor.",
              403,
            ),
          ),
        )
        .finally(() => {
          checking = false;
        });
    }, 500);
    permissionTimer.unref();
    try {
      const effective = await new SettingsService(
        new IdentityService(this.storage.db),
        this.policy,
      ).effective(identity, value.project_ref);
      const executed = await new DockerExecutor(this.dataDir, {
        trustScope: `${identity.tenantId}:${identity.userId}`,
        allowDependencyInstall: effective.values.dependencyInstall,
        allowedOrigins: effective.values.scriptAllowedOrigins,
      }).execute(
        loaded.path,
        loaded.manifest,
        value.entrypoint,
        value.args,
        signal
          ? AbortSignal.any([signal, permissionAbort.signal])
          : permissionAbort.signal,
      );
      await new IdentityService(this.storage.db).authorize(
        identity,
        "run",
        value.project_ref,
      );
      result = await storeExecutionResult(
        this.dataDir,
        accepted.row.id,
        executed,
      );
    } catch (error) {
      result = {
        execution_id: accepted.row.id,
        status: "failed",
        ...errorEnvelope(
          permissionAbort.signal.aborted
            ? permissionAbort.signal.reason
            : error,
        ),
      };
    } finally {
      clearInterval(permissionTimer);
    }
    await this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", identity.tenantId)
        .execute();
      try {
        await new IdentityService(tx).authorize(
          identity,
          "run",
          value.project_ref,
        );
      } catch {
        result = {
          execution_id: accepted.row.id,
          status: "failed",
          ...errorEnvelope(
            new ForgeError(
              "permission_revoked",
              "Çalıştırma yetkisi iptal edildi.",
              403,
            ),
          ),
        };
      }
      await observe(
        tx,
        identity,
        value.project_ref,
        result.status === "completed"
          ? "entrypoint_executed"
          : "execution_failed",
        [{ skill_id: value.skill_id, revision: value.revision }],
        accepted.row.id,
      );
      await tx
        .updateTable("executions")
        .set({ state: result.status, result_json: JSON.stringify(result) })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", accepted.row.id)
        .execute();
      // The sandbox has returned and its terminal result is durable in this transaction.
      await tx
        .deleteFrom("execution_revision_pins")
        .where("tenant_id", "=", identity.tenantId)
        .where("execution_id", "=", accepted.row.id)
        .execute();
    });
    return executionPage(this.cursors, identity, value.project_ref, result);
  }
}
