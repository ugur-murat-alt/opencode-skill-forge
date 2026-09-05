import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { SettingsService } from "../src/application/settings.js";
import { TelemetryService } from "../src/application/telemetry.js";
import { LearningStore } from "../src/prompt/learning.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`telemetry ${backend}: bounded retention preserves live jobs, usage/dedup, private isolation and redacted support`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-telemetry-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const identity = new IdentityService(storage.db),
        owner = await identity.bootstrapLocal(),
        project = await identity.createProject(owner, "Retention fixture"),
        other = await identity.createProject(owner, "Other retention project");
      await new SettingsService(identity).update(
        owner,
        `project:${project.id}`,
        0,
        { retentionDays: 1 },
      );
      const forge = new ForgeService(storage, root, "test-key"),
        service = new TelemetryService(storage),
        original =
          "Private retention canary. Preserve 3 units and do not expand scope.";
      const completed = await forge.queue.accept(owner, {
        projectId: project.id,
        kind: "prompt_edit",
        key: "old-completed",
        payload: { original },
      });
      const live = await forge.queue.accept(owner, {
        projectId: project.id,
        kind: "prompt_edit",
        key: "live",
        payload: { original },
      });
      const elsewhere = await forge.queue.accept(owner, {
        projectId: other.id,
        kind: "prompt_edit",
        key: "other",
        payload: { original },
      });
      const old = Date.now() - 3 * 86400000;
      await storage.db
        .updateTable("runs")
        .set({
          state: "improved",
          updated_at: old,
          result_json: JSON.stringify({
            status: "improved",
            original,
            effective: original,
            usage: { input: 12, output: 4, cost: null },
          }),
        })
        .where("id", "in", [completed.run.id, elsewhere.run.id])
        .execute();
      const lesson = await new LearningStore(storage).save(owner, project.id, {
        content: "Preserve explicit quantities when refining a request.",
        triggers: "quantity request",
      });
      await storage.db
        .updateTable("learning_entries")
        .set({ created_at: old })
        .where("id", "=", lesson.id)
        .execute();
      await storage.db
        .insertInto("audit_events")
        .values({
          tenant_id: owner.tenantId,
          user_id: owner.userId,
          project_id: project.id,
          id: crypto.randomUUID(),
          kind: "test.redaction",
          created_at: Date.now(),
          detail: JSON.stringify({
            code: "fixture",
            prompt: original,
            authorization: "do-not-export-canary",
            arbitrary: original,
          }),
        })
        .execute();
      const support = await service.support(owner, project.id),
        serialized = JSON.stringify(support);
      expect(serialized).not.toContain("Private retention canary");
      expect(serialized).not.toContain("do-not-export-canary");
      expect(serialized).not.toContain(elsewhere.run.id);
      expect(support.runs.some((r) => r.id === live.run.id)).toBe(true);
      const retained = await service.retain(owner, project.id);
      expect(retained.scrubbed_runs).toBe(1);
      expect(retained.deleted_lessons).toBe(1);
      const row = await forge.queue.get(owner, completed.run.id);
      expect(row.input_json).not.toContain(original);
      expect(row.result_json).not.toContain(original);
      expect(JSON.parse(row.result_json!).usage.cost).toBeNull();
      expect((await forge.queue.get(owner, live.run.id)).input_json).toContain(
        original,
      );
      expect(
        (await forge.queue.get(owner, elsewhere.run.id)).input_json,
      ).toContain(original);
      const replay = await forge.invoke("forge_prepare", owner, {
        project_ref: project.id,
        original,
        idempotency_key: "old-completed",
        wait_ms: 0,
      });
      expect(replay.status).toBe("fallback");
      expect(replay.reason).toBe("content_expired");
      expect(replay.original).toBe(original);
      expect(replay.effective).toBe(original);
      expect(replay.run_id).toBe(completed.run.id);
      expect((await service.retain(owner, project.id)).scrubbed_runs).toBe(0);
      await expect(
        service.retain({ ...owner, tenantId: "foreign" }, project.id),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
