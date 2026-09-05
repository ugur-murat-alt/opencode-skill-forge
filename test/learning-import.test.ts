import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { LearningStore } from "../src/prompt/learning.js";
import { LearningMigration } from "../src/migration/learning.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`legacy learning ${backend}: exact source, long lessons, private access and guarded rollback`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-learning-import-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const identity = new IdentityService(storage.db),
        owner = await identity.bootstrapLocal(),
        project = await identity.createProject(owner, "Legacy learning"),
        migration = new LearningMigration(storage),
        learning = new LearningStore(storage),
        long = (
          "Preserve explicit quantities and constraints. ".repeat(70) +
          crypto.randomUUID()
        ).trim();
      const duplicate = await learning.save(owner, project.id, {
        content: "Preserve original intent.",
        triggers: "intent",
        personal: true,
      });
      const bytes = Buffer.from(
        `# Prompt Editor — Learn\r\n\r\n## [1700000000000]\r\n${long}\r\n\r\n## [1700000000001]\r\nPreserve original intent.\r\n\r\n## [1700000000002]\r\nsk-sensitive-test-secret\r\n`,
      );
      const result = await migration.import(
        owner,
        project.id,
        hash("source"),
        hash(bytes),
        bytes,
        true,
      );
      expect(result.review_required).toBe(1);
      expect(result.records.map((r: any) => r.status)).toEqual([
        "created",
        "duplicate",
        "review_required",
      ]);
      expect(await migration.original(owner, result.receipt_id)).toEqual(bytes);
      expect(JSON.stringify(result)).not.toContain("sk-sensitive");
      const stored = (await learning.list(owner, project.id)).find(
        (x) => x.id === result.records[0].entry_id,
      )!;
      expect(stored.content).toBe(long);
      expect(stored.scope_key).toBe(`personal:${owner.userId}`);
      expect(stored.content.length).toBeGreaterThan(1000);
      const retrieval = await learning.retrieve(
        owner,
        project.id,
        "quantities",
      );
      expect(retrieval[0]!.length).toBeLessThanOrEqual(500);
      expect(
        (
          await migration.import(
            owner,
            project.id,
            hash("source"),
            hash(bytes),
            bytes,
            true,
          )
        ).replayed,
      ).toBe(true);
      await expect(
        migration.original(
          { ...owner, userId: crypto.randomUUID() },
          result.receipt_id,
        ),
      ).rejects.toMatchObject({ code: "migration_unavailable" });
      await expect(
        migration.import(
          owner,
          project.id,
          hash("source"),
          "0".repeat(64),
          bytes,
          true,
        ),
      ).rejects.toMatchObject({ code: "source_changed" });
      await learning.update(owner, project.id, stored.id, {
        base_revision: 1,
        content: long,
        triggers: stored.trigger_text,
        disabled: true,
      });
      await expect(
        migration.rollback(owner, result.receipt_id),
      ).rejects.toMatchObject({ code: "migration_target_changed" });
      const other = Buffer.from(
        "# Prompt Editor — Learn\n\n## [1700000000000]\nKeep all explicit versions unchanged.\n",
      );
      const second = await migration.import(
        owner,
        project.id,
        hash("other"),
        hash(other),
        other,
        false,
      );
      expect(
        (await migration.rollback(owner, second.receipt_id)).replayed,
      ).toBe(false);
      expect(
        (await migration.rollback(owner, second.receipt_id)).replayed,
      ).toBe(true);
      expect(await migration.original(owner, second.receipt_id)).toEqual(other);
      expect(
        (await learning.list(owner, project.id)).some(
          (x) => x.id === duplicate.id,
        ),
      ).toBe(true);
      const malformed = Buffer.from([255, 254, 0]);
      const bad = await migration.import(
        owner,
        project.id,
        hash("malformed"),
        hash(malformed),
        malformed,
        true,
      );
      expect(bad.review_required).toBe(1);
      expect(await migration.original(owner, bad.receipt_id)).toEqual(
        malformed,
      );
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`legacy learning ${backend}: dependent cross-project import prevents destructive rollback`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-learning-references-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const identity = new IdentityService(storage.db),
        owner = await identity.bootstrapLocal();
      const firstProject = await identity.createProject(
        owner,
        "Original import",
      );
      const secondProject = await identity.createProject(
        owner,
        "Dependent import",
      );
      const migration = new LearningMigration(storage),
        learning = new LearningStore(storage);
      const lesson = `Preserve explicit version constraints ${crypto.randomUUID()}.`;
      const bytes = Buffer.from(
        `# Prompt Editor — Learn\n\n## [1700000000000]\n${lesson}\n`,
      );
      const first = await migration.import(
        owner,
        firstProject.id,
        hash(crypto.randomUUID()),
        hash(bytes),
        bytes,
        true,
      );
      const second = await migration.import(
        owner,
        secondProject.id,
        hash(crypto.randomUUID()),
        hash(bytes),
        bytes,
        true,
      );
      expect(first.records[0].status).toBe("created");
      expect(second.records[0]).toMatchObject({
        status: "duplicate",
        entry_id: first.records[0].entry_id,
      });
      await expect(
        migration.rollback(owner, first.receipt_id),
      ).rejects.toMatchObject({ code: "migration_target_referenced" });
      expect(
        (await learning.list(owner, secondProject.id)).some(
          (x) => x.id === first.records[0].entry_id,
        ),
      ).toBe(true);
      expect(
        (
          await storage.db
            .selectFrom("learning_imports")
            .select("state")
            .where("tenant_id", "=", owner.tenantId)
            .where("id", "=", first.receipt_id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("applied");
      await migration.rollback(owner, second.receipt_id);
      expect(
        (await learning.list(owner, firstProject.id)).some(
          (x) => x.id === first.records[0].entry_id,
        ),
      ).toBe(true);
      await migration.rollback(owner, first.receipt_id);
      expect(
        (await learning.list(owner, firstProject.id)).some(
          (x) => x.id === first.records[0].entry_id,
        ),
      ).toBe(false);
      expect(await migration.original(owner, first.receipt_id)).toEqual(bytes);
      expect(await migration.original(owner, second.receipt_id)).toEqual(bytes);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
