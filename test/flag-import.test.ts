import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SessionPreferences } from "../src/application/session-preferences.js";
import { FlagMigration } from "../src/migration/flags.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`flags ${backend}: explicit sessions, legacy fallback, monotonic rollback and source preservation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-flags-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const ids = new IdentityService(storage.db),
        owner = await ids.bootstrapLocal(),
        project = await ids.createProject(owner, "Flag import"),
        prefs = new SessionPreferences(ids),
        migration = new FlagMigration(storage),
        target = { client: "codex", session: "first" };
      await prefs.update(owner, project.id, target, 0, { autoApply: true });
      const bytes = Buffer.from(
        '{"old-a":{"enabled":false,"autoAccept":false},"bad":{"enabled":"bad","autoAccept":true},"unselected":{"enabled":true}}\r\n',
      );
      const mapping = [
        {
          legacy_session: "old-a",
          target,
          base_revision: 1,
          defaults: { enabled: true, autoAccept: true },
        },
        {
          legacy_session: "bad",
          target: { client: "claude", session: "second" },
          base_revision: 0,
          defaults: { enabled: false, autoAccept: true },
        },
      ];
      const first = await migration.import(
        owner,
        project.id,
        hash("flags-source"),
        hash(bytes),
        bytes,
        mapping,
      );
      expect(first.review_required).toBe(1);
      expect(first.unselected).toBe(1);
      expect(first.records[1]!.reason).toBe("legacy_safe_fallback_applied");
      expect((await prefs.get(owner, project.id, target)).values).toEqual({
        promptEnabled: false,
        autoApply: false,
      });
      expect(
        (await prefs.get(owner, project.id, mapping[1]!.target)).values,
      ).toEqual({ promptEnabled: false, autoApply: false });
      expect(await migration.original(owner, first.receipt_id)).toEqual(bytes);
      expect(JSON.stringify(first)).not.toContain("old-a");
      expect(
        (
          await migration.import(
            owner,
            project.id,
            hash("flags-source"),
            hash(bytes),
            bytes,
            mapping,
          )
        ).replayed,
      ).toBe(true);
      await expect(
        migration.original(
          { ...owner, userId: crypto.randomUUID() },
          first.receipt_id,
        ),
      ).rejects.toMatchObject({ code: "migration_unavailable" });
      await migration.rollback(owner, first.receipt_id);
      expect(await prefs.get(owner, project.id, target)).toEqual({
        revision: 3,
        values: { autoApply: true },
      });
      expect(await prefs.get(owner, project.id, mapping[1]!.target)).toEqual({
        revision: 2,
        values: {},
      });
      expect((await migration.rollback(owner, first.receipt_id)).replayed).toBe(
        true,
      );
      const nextMapping = [
        { ...mapping[0]!, base_revision: 3 },
        { ...mapping[1]!, base_revision: 2 },
      ];
      const second = await migration.import(
        owner,
        project.id,
        hash("flags-source"),
        hash(bytes),
        bytes,
        nextMapping,
      );
      await prefs.update(owner, project.id, mapping[1]!.target, 3, {
        autoApply: true,
      });
      await expect(
        migration.rollback(owner, second.receipt_id),
      ).rejects.toMatchObject({ code: "migration_target_changed" });
      expect((await prefs.get(owner, project.id, target)).revision).toBe(4);
      const stale = await migration.import(
        owner,
        project.id,
        hash("stale"),
        hash(bytes),
        bytes,
        mapping,
      );
      expect(stale.records.every((x) => x.reason === "revision_conflict")).toBe(
        true,
      );
      const invalid = Buffer.from("{broken");
      const bad = await migration.import(
        owner,
        project.id,
        hash("invalid"),
        hash(invalid),
        invalid,
        mapping,
      );
      expect(bad.review_required).toBe(2);
      expect(await migration.original(owner, bad.receipt_id)).toEqual(invalid);
      await expect(
        migration.import(owner, project.id, hash("dup"), hash(bytes), bytes, [
          mapping[0],
          mapping[0],
        ]),
      ).rejects.toMatchObject({ code: "duplicate_target" });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
