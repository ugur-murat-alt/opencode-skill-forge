import { createHash } from "node:crypto";
import { Client } from "pg";
import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { SecretVault } from "../src/storage/secrets.js";
const exec = promisify(execFile);
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "Node PostgreSQL backup: live snapshot, revision/secret/session restore, corrupt and occupied targets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-backup-"));
    const source = join(root, "source"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    await mkdir(source, { mode: 0o700 });
    const admin = new Client({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const sourceName = `forge_backup_${crypto.randomUUID().replaceAll("-", "")}`;
    const targetName = `forge_restore_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    const sourceUrl = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    sourceUrl.pathname = `/${sourceName}`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${targetName}`;
    // Owned fixture adapter runs matching PostgreSQL 17 tools; product uses ordinary native executables.
    for (const tool of ["pg_dump", "pg_restore"]) {
      await writeFile(
        join(root, tool),
        `#!/bin/sh\n${tool === "pg_dump" ? `touch '${root}/dump-ready'\nwhile [ ! -f '${root}/dump-release' ]; do sleep 0.01; done\n` : ""}exec docker run --rm --network host --user ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} -e PGDATABASE -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGCONNECT_TIMEOUT -v '${root}:${root}' postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73 ${tool} "$@"\n`,
        { mode: 0o700 },
      );
    }
    const storage = await openDatabase({
      dataDir: source,
      postgresUrl: sourceUrl.toString(),
    });
    const identity = new IdentityService(storage.db),
      owner = await identity.bootstrapLocal();
    const project = await identity.createProject(owner, "Yedek kabulü");
    const store = new PackageStore(storage, source);
    const published = await store.publish(owner, {
      name: "backup-proof",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          "---\nname: backup-proof\ndescription: Yedek ve geri yükleme doğrulaması.\n---\n# Yöntem\nGerçek paket içeriği.\n",
        ),
      },
    });
    await identity.issueSession(owner.userId, "session", 60000);
    const vault = await SecretVault.open(source),
      secret = await vault.put(
        owner.tenantId,
        owner.userId,
        "fixture-only-secret",
      );
    await storage.db
      .insertInto("provider_profiles")
      .values({
        tenant_id: owner.tenantId,
        user_id: owner.userId,
        id: crypto.randomUUID(),
        role: "spr",
        revision: 1,
        profile_json: "{}",
        secret_ref: secret,
        created_at: Date.now(),
      })
      .execute();
    const retainedReader = {
      tenant_id: owner.tenantId,
      id: crypto.randomUUID(),
      skill_id: published.skill_id,
      revision: published.revision,
      created_at: Date.now(),
    };
    await storage.db
      .insertInto("revision_readers")
      .values(retainedReader)
      .execute();
    const readerIds = async () =>
      (
        await storage.db.selectFrom("revision_readers").select("id").execute()
      ).map((row) => row.id);
    const run = (command: string, src: string, dst: string) =>
      exec(
        "node",
        [
          resolve("dist/cli.js"),
          command,
          "--data-dir",
          src,
          "--output",
          dst,
          "--database-name",
          dst === restored ? targetName : `${targetName}_bad`,
        ],
        {
          env: {
            ...process.env,
            SKILL_FORGE_POSTGRES_URL: sourceUrl.toString(),
            SKILL_FORGE_PG_DUMP: join(root, "pg_dump"),
            SKILL_FORGE_PG_RESTORE: join(root, "pg_restore"),
            SKILL_FORGE_DATA_DIR: source,
            OC_SKILL_POWER_HOME: join(root, "legacy"),
          },
        },
      );
    let pendingBackup: ReturnType<typeof run> | undefined;
    try {
      pendingBackup = run("backup", source, backup);
      void pendingBackup.catch(() => undefined);
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          await access(join(root, "dump-ready"));
          break;
        } catch {
          if (Date.now() > deadline)
            throw Error("Backup did not reach dump gate");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(await readerIds()).toHaveLength(2);
      await storage.db
        .deleteFrom("revision_readers")
        .where("id", "=", retainedReader.id)
        .execute();
      await expect(
        storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("skills")
            .set({ active_revision: null })
            .where("tenant_id", "=", owner.tenantId)
            .where("id", "=", published.skill_id)
            .execute();
          await tx
            .deleteFrom("skill_revisions")
            .where("tenant_id", "=", owner.tenantId)
            .where("skill_id", "=", published.skill_id)
            .execute();
        }),
      ).rejects.toThrow();
      await storage.db
        .insertInto("revision_readers")
        .values(retainedReader)
        .execute();
      await writeFile(join(root, "dump-release"), "continue");
      expect(JSON.parse((await pendingBackup).stdout).status).toBe("created");
      expect(await readerIds()).toEqual([retainedReader.id]);
      await expect(run("backup", source, backup)).rejects.toThrow();
      expect(
        JSON.parse((await run("restore", backup, restored)).stdout)
          .sessions_revoked,
      ).toBe(true);
      const target = await openDatabase({
        dataDir: restored,
        postgresUrl: targetUrl.toString(),
      });
      try {
        expect(
          await target.db.selectFrom("revision_readers").selectAll().execute(),
        ).toHaveLength(0);
        expect(
          (
            await new PackageStore(target, restored).files(
              owner,
              published.skill_id,
              published.revision,
            )
          ).files["SKILL.md"]!.toString(),
        ).toContain("Gerçek paket");
        expect(
          await (
            await SecretVault.open(restored)
          ).get(owner.tenantId, owner.userId, secret),
        ).toBe("fixture-only-secret");
        expect(
          (
            await target.db.selectFrom("auth_sessions").selectAll().execute()
          ).every((row) => row.revoked === 1),
        ).toBe(true);
      } finally {
        await target.close();
      }
      await expect(run("restore", backup, restored)).rejects.toThrow();
      const manifest = JSON.parse(
        await readFile(join(backup, "backup.json"), "utf8"),
      );
      const revision = manifest.files.find((entry: { path: string }) =>
        entry.path.endsWith("SKILL.md"),
      );
      await writeFile(join(backup, revision.path), "corrupt");
      await expect(run("restore", backup, join(root, "bad"))).rejects.toThrow();
      await expect(access(join(root, "bad"))).rejects.toThrow();
      // Matching outer inventory cannot hide a corrupted DB-referenced revision.
      revision.bytes = 7;
      revision.hash = createHash("sha256").update("corrupt").digest("hex");
      await writeFile(join(backup, "backup.json"), JSON.stringify(manifest));
      await expect(run("restore", backup, join(root, "bad"))).rejects.toThrow();
      await expect(access(join(root, "bad"))).rejects.toThrow();
      expect(
        (
          await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
            `${targetName}_bad`,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await store.files(owner, published.skill_id, published.revision)
        ).files["SKILL.md"]!.toString(),
      ).toContain("Gerçek paket");
      await rm(join(source, revision.path));
      await expect(
        run("backup", source, join(root, "missing")),
      ).rejects.toThrow();
      await expect(access(join(root, "missing"))).rejects.toThrow();
      expect(await readerIds()).toEqual([retainedReader.id]);
    } finally {
      await writeFile(join(root, "dump-release"), "continue");
      await pendingBackup?.catch(() => undefined);
      await storage.close();
      await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE "${sourceName}" WITH (FORCE)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
