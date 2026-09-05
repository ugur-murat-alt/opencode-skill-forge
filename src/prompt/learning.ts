import { sql } from "kysely";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { sanitizePromptEditorText } from "../prompt-editor/context-snapshot.js";
import { searchText } from "../skills/store.js";
import { ForgeError } from "../domain/errors.js";
import type { Run } from "../storage/schema.js";
import { JobQueue } from "../jobs/queue.js";
export class LearningStore {
  constructor(readonly storage: DatabaseHandle) {}
  async list(identity: Identity, projectId: string) {
    await new IdentityService(this.storage.db).authorize(
      identity,
      "read",
      projectId,
    );
    return this.storage.db
      .selectFrom("learning_entries")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("scope_key", "in", [
        `project:${projectId}`,
        `personal:${identity.userId}`,
      ])
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
  }
  async retrieve(identity: Identity, projectId: string, original: string) {
    const terms = new Set(
      searchText(original)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 2),
    );
    return (await this.list(identity, projectId))
      .filter((row) => !row.disabled)
      .map((row) => ({
        content: row.content,
        score: searchText(row.trigger_text)
          .split(/[^\p{L}\p{N}]+/u)
          .filter((term) => terms.has(term)).length,
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((row) => row.content.slice(0, 500));
  }
  validate(input: { content: string; triggers: string }) {
    const content = input.content.trim(),
      triggers = searchText(input.triggers).trim();
    if (
      !content ||
      content.length > 5000 ||
      !triggers ||
      triggers.length > 200 ||
      sanitizePromptEditorText(content, 5000) !== content ||
      /(?:https?:\/\/|(?:\/(?:home|Users|tmp|etc)\/)|[A-Z]:\\|\bsk-)/.test(
        content,
      )
    )
      throw new ForgeError(
        "learning_not_reusable",
        "Ders sır/yerel yol içermeyen kısa tekrar kullanılabilir kural olmalı.",
      );
    return { content, triggers };
  }
  async save(
    identity: Identity,
    projectId: string,
    input: { content: string; triggers: string; personal?: boolean },
    run?: Run,
  ) {
    const { content, triggers } = this.validate(input);
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", identity.tenantId)
        .execute();
      await new IdentityService(tx).authorize(identity, "write", projectId);
      if (run) await new JobQueue(this.storage).assertLease(tx, run);
      const scope = input.personal
          ? `personal:${identity.userId}`
          : `project:${projectId}`,
        hash = createHash("sha256").update(content).digest("hex");
      const id = randomUUID();
      await tx
        .insertInto("learning_entries")
        .values({
          tenant_id: identity.tenantId,
          id,
          user_id: identity.userId,
          project_id: projectId,
          scope_key: scope,
          content,
          content_hash: hash,
          trigger_text: triggers,
          run_id: run?.id ?? null,
          revision: 1,
          disabled: 0,
          created_at: Date.now(),
        })
        .onConflict((oc) =>
          oc
            .columns(["tenant_id", "user_id", "scope_key", "content_hash"])
            .doNothing(),
        )
        .execute();
      const stored = await tx
        .selectFrom("learning_entries")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("scope_key", "=", scope)
        .where("content_hash", "=", hash)
        .executeTakeFirstOrThrow();
      if (stored.id === id)
        await tx
          .insertInto("learning_history")
          .values({
            tenant_id: identity.tenantId,
            entry_id: id,
            revision: 1,
            content,
            trigger_text: triggers,
            disabled: 0,
            created_at: stored.created_at,
          })
          .execute();
      const rows = await tx
        .selectFrom("learning_entries")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("scope_key", "=", scope)
        .orderBy("created_at", "desc")
        .limit(1000)
        .offset(200)
        .execute();
      if (rows.length)
        await tx
          .deleteFrom("learning_entries")
          .where("tenant_id", "=", identity.tenantId)
          .where("user_id", "=", identity.userId)
          .where(
            "id",
            "in",
            rows.map((row) => row.id),
          )
          .execute();
      return {
        id: stored.id,
        scope,
        revision: stored.revision,
        replayed: stored.id !== id,
      };
    });
  }
  async history(identity: Identity, projectId: string, id: string) {
    await new IdentityService(this.storage.db).authorize(
      identity,
      "read",
      projectId,
    );
    const entry = await this.storage.db
      .selectFrom("learning_entries")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("id", "=", id)
      .where("scope_key", "in", [
        `project:${projectId}`,
        `personal:${identity.userId}`,
      ])
      .executeTakeFirst();
    if (!entry)
      throw new ForgeError("learning_unavailable", "Ders bulunamadı.", 404);
    return this.storage.db
      .selectFrom("learning_history")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("entry_id", "=", id)
      .orderBy("revision", "desc")
      .limit(20)
      .execute();
  }
  async update(
    identity: Identity,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = z
      .object({
        base_revision: z.number().int().positive(),
        content: z.string(),
        triggers: z.string(),
        disabled: z.boolean(),
      })
      .strict()
      .parse(raw);
    const { content, triggers } = this.validate(input),
      hash = createHash("sha256").update(content).digest("hex");
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", identity.tenantId)
        .execute();
      await new IdentityService(tx).authorize(identity, "write", projectId);
      const entry = await tx
        .selectFrom("learning_entries")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("id", "=", id)
        .where("scope_key", "in", [
          `project:${projectId}`,
          `personal:${identity.userId}`,
        ])
        .executeTakeFirst();
      if (!entry)
        throw new ForgeError("learning_unavailable", "Ders bulunamadı.", 404);
      if (entry.revision !== input.base_revision)
        throw new ForgeError(
          "revision_conflict",
          "Ders başka bir işlemde değişti; güncel kaydı yükleyin.",
          409,
        );
      if (
        entry.content === content &&
        entry.trigger_text === triggers &&
        entry.disabled === Number(input.disabled)
      )
        return { id, revision: entry.revision, changed: false };
      const duplicate = await tx
        .selectFrom("learning_entries")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("scope_key", "=", entry.scope_key)
        .where("content_hash", "=", hash)
        .where("id", "!=", id)
        .executeTakeFirst();
      if (duplicate)
        throw new ForgeError(
          "learning_duplicate",
          "Aynı kapsamda bu ders zaten mevcut.",
          409,
        );
      const revision = entry.revision + 1;
      const changed = await tx
        .updateTable("learning_entries")
        .set({
          content,
          trigger_text: triggers,
          content_hash: hash,
          disabled: Number(input.disabled),
          revision,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", id)
        .where("revision", "=", entry.revision)
        .executeTakeFirst();
      if (Number(changed.numUpdatedRows) !== 1)
        throw new ForgeError(
          "revision_conflict",
          "Ders eşzamanlı değişti.",
          409,
        );
      await tx
        .insertInto("learning_history")
        .values({
          tenant_id: identity.tenantId,
          entry_id: id,
          revision,
          content,
          trigger_text: triggers,
          disabled: Number(input.disabled),
          created_at: Date.now(),
        })
        .execute();
      await tx
        .deleteFrom("learning_history")
        .where("tenant_id", "=", identity.tenantId)
        .where("entry_id", "=", id)
        .where("revision", "<=", revision - 20)
        .execute();
      return { id, revision, changed: true };
    });
  }
  async remove(identity: Identity, projectId: string, id: string) {
    await new IdentityService(this.storage.db).authorize(
      identity,
      "write",
      projectId,
    );
    const result = await this.storage.db
      .deleteFrom("learning_entries")
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("id", "=", id)
      .where("scope_key", "in", [
        `project:${projectId}`,
        `personal:${identity.userId}`,
      ])
      .executeTakeFirst();
    if (!Number(result.numDeletedRows))
      throw new ForgeError("learning_unavailable", "Ders bulunamadı.", 404);
    return { removed: id };
  }
}
