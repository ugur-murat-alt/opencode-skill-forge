import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { LearningStore } from "../src/prompt/learning.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`learning history ${backend}: stable dedup identity, CAS, disabled retrieval and private bounded revisions`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-learning-history-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const ids = new IdentityService(storage.db),
        owner = await ids.bootstrapLocal(),
        project = await ids.createProject(owner, "Learning history"),
        other = await ids.createProject(owner, "Other learning"),
        learning = new LearningStore(storage);
      const content = "Preserve explicit quantities and constraints.",
        first = await learning.save(owner, project.id, {
          content,
          triggers: "quantities",
        }),
        repeat = await learning.save(owner, project.id, {
          content,
          triggers: "changed",
        });
      expect(repeat.id).toBe(first.id);
      expect(repeat.replayed).toBe(true);
      expect((await learning.history(owner, project.id, first.id)).length).toBe(
        1,
      );
      const input = {
        base_revision: 1,
        content,
        triggers: "quantities",
        disabled: true,
      };
      await learning.update(owner, project.id, first.id, input);
      expect(await learning.retrieve(owner, project.id, "quantities")).toEqual(
        [],
      );
      await expect(
        learning.update(owner, project.id, first.id, {
          ...input,
          disabled: false,
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(
        learning.history(owner, other.id, first.id),
      ).rejects.toMatchObject({ code: "learning_unavailable" });
      await expect(
        learning.history(
          { ...owner, userId: crypto.randomUUID() },
          project.id,
          first.id,
        ),
      ).rejects.toThrow();
      await expect(
        learning.update(owner, project.id, first.id, {
          ...input,
          base_revision: 2,
          content: "sk-private-secret",
        }),
      ).rejects.toMatchObject({ code: "learning_not_reusable" });
      for (let revision = 2; revision < 24; revision++)
        await learning.update(owner, project.id, first.id, {
          base_revision: revision,
          content: `Preserve explicit quantities revision ${revision}.`,
          triggers: "quantities",
          disabled: false,
        });
      const history = await learning.history(owner, project.id, first.id);
      expect(history).toHaveLength(20);
      expect(history[0]!.revision).toBe(24);
      expect(history.at(-1)!.revision).toBe(5);
      expect(
        await learning.retrieve(owner, project.id, "quantities"),
      ).toHaveLength(1);
      await learning.remove(owner, project.id, first.id);
      expect(
        await storage.db
          .selectFrom("learning_history")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .where("entry_id", "=", first.id)
          .execute(),
      ).toHaveLength(0);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
