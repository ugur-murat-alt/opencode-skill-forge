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
test("Node SQLite backup: live snapshot, revision/secret/session restore, corrupt and occupied targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-backup-"));
  const source = join(root, "source"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  await mkdir(source, { mode: 0o700 });
  const storage = await openDatabase({ dataDir: source });
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
      [resolve("dist/cli.js"), command, "--data-dir", src, "--output", dst],
      {
        env: {
          ...process.env,
          SKILL_FORGE_POSTGRES_URL: "",
          SKILL_FORGE_DATA_DIR: source,
          OC_SKILL_POWER_HOME: join(root, "legacy"),
        },
      },
    );
  try {
    expect(
      JSON.parse((await run("backup", source, backup)).stdout).status,
    ).toBe("created");
    expect(await readerIds()).toEqual([retainedReader.id]);
    await expect(run("backup", source, backup)).rejects.toThrow();
    expect(
      JSON.parse((await run("restore", backup, restored)).stdout)
        .sessions_revoked,
    ).toBe(true);
    const target = await openDatabase({ dataDir: restored });
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
    expect(
      (await store.files(owner, published.skill_id, published.revision)).files[
        "SKILL.md"
      ]!.toString(),
    ).toContain("Gerçek paket");
    await rm(join(source, revision.path));
    await expect(
      run("backup", source, join(root, "missing")),
    ).rejects.toThrow();
    await expect(access(join(root, "missing"))).rejects.toThrow();
    expect(await readerIds()).toEqual([retainedReader.id]);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
