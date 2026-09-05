import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
async function settledHealth(
  app: Awaited<ReturnType<typeof createHttpServer>>,
  headers: Record<string, string>,
) {
  const deadline = Date.now() + 5000;
  let result = (await app.inject({ url: "/health", headers })).json();
  while (
    result.package_integrity.status === "checking" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = (await app.inject({ url: "/health", headers })).json();
  }
  return result;
}
test("real service restart detects indexed package corruption without changing active revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-integrity-"));
  const config = await localConfig(root);
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db),
    owner = await identities.bootstrapLocal(),
    project = await identities.createProject(owner, "Integrity contract");
  const store = new PackageStore(storage, root);
  const first = await store.publish(owner, {
    name: "integrity-test",
    scope: "project",
    projectId: project.id,
    baseRevision: null,
    files: {
      "SKILL.md": Buffer.from(
        "---\nname: integrity-test\ndescription: Validate package recovery.\n---\nRead the package.\n",
      ),
    },
  });
  const loaded = await store.files(owner, first.skill_id, first.revision);
  expect((await store.reconcile(owner)).issues).toHaveLength(0);
  await writeFile(join(loaded.path, "unexpected.txt"), "unregistered");
  expect((await store.reconcile(owner)).issues).toHaveLength(1);
  await expect(
    store.files(owner, first.skill_id, first.revision, ["SKILL.md"]),
  ).rejects.toMatchObject({ code: "revision_corrupt" });
  await rm(join(loaded.path, "unexpected.txt"));

  await storage.close();
  try {
    const headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
    const healthy = await createHttpServer(config);
    try {
      expect((await settledHealth(healthy, headers)).package_integrity).toEqual(
        { status: "verified", checked: 1, issues: 0 },
      );
    } finally {
      await healthy.close();
    }
    await writeFile(join(loaded.path, "SKILL.md"), "corrupt");
    const restarted = await createHttpServer(config);
    try {
      const health = await settledHealth(restarted, headers);
      expect(health.status).toBe("degraded");
      expect(health.package_integrity.issues).toBe(1);
      const report = (
        await restarted.inject({ url: "/api/packages/integrity", headers })
      ).json();
      expect(report.issues).toEqual([
        {
          skill_id: first.skill_id,
          revision: first.revision,
          reason: "missing_or_corrupt",
        },
      ]);
      expect(JSON.stringify(report)).not.toContain(root);
      expect(
        (
          await restarted.inject({
            url: "/api/packages/integrity",
            headers: { host: headers.host },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await restarted.close();
    }
    const reopened = await openDatabase({ dataDir: root });
    try {
      expect(
        (
          await new PackageStore(reopened, root).authorizedSkill(
            owner,
            first.skill_id,
          )
        ).active_revision,
      ).toBe(first.revision);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
