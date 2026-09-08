import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";

export const AGENT_PROMPT_MAX_CHARS = 32768;
/** Normative anchors every agent prompt must carry (golden gate). */
export const AGENT_PROMPT_ANCHORS = [
  "create",
  "update",
  "no-op",
  "reject",
  "untrusted",
];

function hasAnchor(text: string, anchor: string): boolean {
  const pattern =
    anchor === "no-op"
      ? "(?:no-op|noop)"
      : anchor.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`(?<![a-z])${pattern}(?![a-z])`, "i").test(text);
}

export type PromptSource =
  | { source: "file"; version: 0; content: string }
  | { source: string; version: number; content: string };

/** Resolve the packaged prompt file from a module URL (testable). */
export function promptFileFor(importMetaUrl: string, profile: string): string {
  const file = profile === "skill_evolve" ? "skill-evolve.md" : `${profile}.md`;
  return fileURLToPath(new URL(`../../prompts/${file}`, importMetaUrl));
}

async function filePrompt(profile: string): Promise<string> {
  // P22 removed prompt-edit; the skill-evolve contract lives in prompts/.
  const names = [promptFileFor(import.meta.url, profile)];
  if (profile === "skill_evolve")
    names.push(resolve("prompts", "skill-evolve.md"));
  for (const path of names) {
    try {
      if (existsSync(path)) {
        const content = await readFile(path, "utf8");
        if (content.trim()) return content;
      }
    } catch {
      // try next candidate
    }
  }
  throw new ForgeError("prompt_unavailable", "Ajan promptu bulunamadı.", 500);
}

function validateContent(content: string): string {
  const text = content.trim();
  if (!text || text.length > AGENT_PROMPT_MAX_CHARS)
    throw new ForgeError("invalid_prompt", "Prompt metni geçersiz.");
  const lowered = text.toLowerCase();
  // Rollback restores only gate-passing content by design; pre-gate rows
  // stay readable in history but cannot become active again.
  if (!AGENT_PROMPT_ANCHORS.every((anchor) => hasAnchor(lowered, anchor)))
    throw new ForgeError(
      "invalid_prompt",
      "Prompt karar sözlüğünü içermelidir (create, update, no-op/noop, reject, untrusted).",
    );
  return text;
}

async function activeRow(
  db: Kysely<DB>,
  tenantId: string,
  profile: string,
  scope: string,
) {
  return db
    .selectFrom("agent_prompts")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("profile", "=", profile)
    .where("scope", "=", scope)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Resolve the effective system prompt: environment override, then org
 * default, then the packaged file. Unknown projects fall back to org/file
 * so deleted-project edges never break runs.
 */
export async function resolvePrompt(
  db: Kysely<DB>,
  tenantId: string,
  projectId?: string,
  profile = "skill_evolve",
): Promise<PromptSource> {
  if (projectId) {
    const project = await db
      .selectFrom("projects")
      .select("environment_id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (project?.environment_id) {
      const env = await activeRow(
        db,
        tenantId,
        profile,
        `environment:${project.environment_id}`,
      );
      if (env)
        return {
          source: `environment:${project.environment_id}`,
          version: env.version,
          content: env.content,
        };
    }
  }
  const org = await activeRow(db, tenantId, profile, "org");
  if (org) return { source: "org", version: org.version, content: org.content };
  return { source: "file", version: 0, content: await filePrompt(profile) };
}

export class AgentPromptService {
  constructor(readonly db: Kysely<DB>) {}

  async active(actor: Identity, scope: string, profile = "skill_evolve") {
    await new IdentityService(this.db).authorize(actor, "read");
    return activeRow(this.db, actor.tenantId, profile, scope);
  }

  async history(actor: Identity, scope: string, profile = "skill_evolve") {
    await new IdentityService(this.db).authorize(actor, "read");
    return this.db
      .selectFrom("agent_prompts")
      .select(["version", "created_by", "created_at"])
      .where("tenant_id", "=", actor.tenantId)
      .where("profile", "=", profile)
      .where("scope", "=", scope)
      .orderBy("version", "desc")
      .limit(50)
      .execute();
  }

  async update(
    actor: Identity,
    raw: {
      profile?: string;
      scope: string;
      base_version: number;
      content: string;
    },
  ) {
    const profile = raw.profile ?? "skill_evolve";
    if (profile !== "skill_evolve")
      throw new ForgeError("invalid_prompt", "Profil desteklenmiyor.");
    const content = validateContent(raw.content);
    const scope = await this.checkedScope(actor, raw.scope);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const current = await tx
        .selectFrom("agent_prompts")
        .select("version")
        .where("tenant_id", "=", actor.tenantId)
        .where("profile", "=", profile)
        .where("scope", "=", scope)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      if ((current?.version ?? 0) !== raw.base_version)
        throw new ForgeError(
          "revision_conflict",
          "Prompt başka işlemde değişti; güncel sürümü okuyun.",
          409,
        );
      const now = Date.now();
      try {
        await tx
          .insertInto("agent_prompts")
          .values({
            tenant_id: actor.tenantId,
            profile,
            scope,
            version: (current?.version ?? 0) + 1,
            content,
            created_by: actor.userId,
            created_at: now,
          })
          .execute();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
          throw new ForgeError(
            "revision_conflict",
            "Prompt başka işlemde değişti; güncel sürümü okuyun.",
            409,
          );
        throw error;
      }
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "agent_prompt.updated",
          detail: JSON.stringify({
            profile,
            scope,
            version: (current?.version ?? 0) + 1,
          }),
          created_at: now,
        })
        .execute();
      return { version: (current?.version ?? 0) + 1 };
    });
  }

  async rollback(
    actor: Identity,
    raw: { profile?: string; scope: string; version: number },
  ) {
    const profile = raw.profile ?? "skill_evolve";
    const scope = await this.checkedScope(actor, raw.scope);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "admin");
      const source = await tx
        .selectFrom("agent_prompts")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("profile", "=", profile)
        .where("scope", "=", scope)
        .where("version", "=", raw.version)
        .executeTakeFirst();
      if (!source)
        throw new ForgeError(
          "prompt_version_unavailable",
          "Sürüm bulunamadı.",
          404,
        );
      const current = await tx
        .selectFrom("agent_prompts")
        .select("version")
        .where("tenant_id", "=", actor.tenantId)
        .where("profile", "=", profile)
        .where("scope", "=", scope)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      const now = Date.now();
      const restored = validateContent(source.content);
      try {
        await tx
          .insertInto("agent_prompts")
          .values({
            tenant_id: actor.tenantId,
            profile,
            scope,
            version: (current?.version ?? 0) + 1,
            content: restored,
            created_by: actor.userId,
            created_at: now,
          })
          .execute();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
          throw new ForgeError(
            "revision_conflict",
            "Prompt başka işlemde değişti; güncel sürümü okuyun.",
            409,
          );
        throw error;
      }
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: null,
          kind: "agent_prompt.rollback",
          detail: JSON.stringify({
            profile,
            scope,
            from_version: raw.version,
            version: (current?.version ?? 0) + 1,
          }),
          created_at: now,
        })
        .execute();
      return { version: (current?.version ?? 0) + 1 };
    });
  }

  private async checkedScope(actor: Identity, scope: string) {
    if (scope === "org") return scope;
    if (scope.startsWith("environment:")) {
      const env = await this.db
        .selectFrom("environments")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", scope.slice(12))
        .executeTakeFirst();
      if (!env)
        throw new ForgeError(
          "environment_unavailable",
          "Ortam bulunamadı.",
          404,
        );
      return scope;
    }
    throw new ForgeError("invalid_scope", "Prompt kapsamı geçersiz.");
  }
}
