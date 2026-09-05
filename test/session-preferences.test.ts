import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SessionPreferences } from "../src/application/session-preferences.js";
import { ForgeService } from "../src/application/forge.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`session preferences ${backend}: scoped CAS and immutable source-aware acceptance`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-session-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const identities = new IdentityService(storage.db),
        owner = await identities.bootstrapLocal(),
        project = await identities.createProject(owner, "Session settings"),
        other = await identities.createProject(owner, "Other session settings"),
        preferences = new SessionPreferences(identities),
        forge = new ForgeService(storage, root, "session-test-key"),
        source = { client: "codex", session: "first" };
      expect(await preferences.get(owner, project.id, source)).toEqual({
        revision: 0,
        values: {},
      });
      await preferences.update(owner, project.id, source, 0, {
        promptEnabled: false,
        autoApply: false,
      });
      await expect(
        preferences.update(owner, project.id, source, 0, {
          promptEnabled: true,
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect((await preferences.get(owner, other.id, source)).values).toEqual(
        {},
      );
      expect(
        (
          await preferences.get(owner, project.id, {
            ...source,
            client: "claude",
          })
        ).values,
      ).toEqual({});
      expect(
        (
          await preferences.get(owner, project.id, {
            ...source,
            session: "second",
          })
        ).values,
      ).toEqual({});
      await expect(
        preferences.get(
          { ...owner, userId: crypto.randomUUID() },
          project.id,
          source,
        ),
      ).rejects.toThrow();
      await expect(
        preferences.update(owner, project.id, source, 1, { allowPaid: true }),
      ).rejects.toThrow();
      const first = (await forge.invoke("forge_prepare", owner, {
        project_ref: project.id,
        original: "Keep the original scope.",
        idempotency_key: "session-first",
        source,
        wait_ms: 0,
      })) as { run_id: string };
      const row = await forge.queue.get(owner, first.run_id),
        snapshot = JSON.parse(row.config_json);
      expect(snapshot.values.promptEnabled).toBe(false);
      expect(snapshot.values.autoApply).toBe(false);
      expect(snapshot.sources.autoApply).toBe("session");
      expect(snapshot.sessionPreferenceRevision).toBe(1);
      await preferences.update(owner, project.id, source, 1, {
        promptEnabled: true,
        autoApply: true,
      });
      expect((await forge.queue.get(owner, first.run_id)).config_json).toBe(
        row.config_json,
      );
      const second = (await forge.invoke("forge_prepare", owner, {
        project_ref: project.id,
        original: "Keep the original scope.",
        idempotency_key: "session-second",
        source,
        wait_ms: 0,
      })) as { run_id: string };
      expect(
        JSON.parse((await forge.queue.get(owner, second.run_id)).config_json)
          .sessionPreferenceRevision,
      ).toBe(2);
      const legacy = (await forge.invoke("forge_prepare", owner, {
        project_ref: project.id,
        original: "Keep the original scope.",
        idempotency_key: "no-source",
        wait_ms: 0,
      })) as { run_id: string };
      expect(
        JSON.parse((await forge.queue.get(owner, legacy.run_id)).config_json)
          .sessionPreferenceRevision,
      ).toBeNull();
      await expect(
        forge.invoke("forge_prepare", owner, {
          project_ref: project.id,
          original: "Keep the original scope.",
          idempotency_key: "session-first",
          source: { ...source, session: "second" },
          wait_ms: 0,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
