import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import type { PackageManifest } from "../src/skills/validate.js";

const FILES = {
  "SKILL.md": Buffer.from(
    "---\nname: winner\ndescription: Failed publish staging cleanup fixture.\n---\nBody.\n",
  ),
};
const SCRIPT_FILES = {
  "SKILL.md": Buffer.from(
    "---\nname: leftover\ndescription: Failed publish staging cleanup fixture.\n---\nBody.\n",
  ),
  "scripts/main.js": Buffer.from("const fs=require('fs');console.log('{}');"),
  "forge.json": Buffer.from(
    JSON.stringify({
      version: 1,
      entrypoints: {
        run: {
          runtime: "node",
          path: "scripts/main.js",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          tests: [{ name: "noop", input: {}, expected: {} }],
        },
      },
    }),
  ),
};

const tenantHash = (tenantId: string) =>
  createHash("sha256").update(tenantId).digest("hex");

/** Issue #13: failed publishes must not leak staging space, and revisions
 * renamed before a DB failure must be reported and safely reclaimed. */
test("P2 #13 failed validation reclaims staging space", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-staging-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const actor = await new IdentityService(storage.db).bootstrapLocal();
    const project = await new IdentityService(storage.db).createProject(
      actor,
      "Leftovers",
    );
    const store = new PackageStore(storage, root);
    const storeAny = store as unknown as {
      validateScripts?: (
        path: string,
        manifest: PackageManifest,
      ) => Promise<{
        hash: string;
        passed: boolean;
        sandbox: string;
        report: unknown;
      }>;
    };
    storeAny.validateScripts = async (_path, manifest) => ({
      hash: manifest.hash,
      passed: false,
      sandbox: "fixture",
      report: null,
    });
    await expect(
      store.publish(actor, {
        name: "leftover",
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: SCRIPT_FILES,
      }),
    ).rejects.toMatchObject({ code: "candidate_tests_failed" });
    // Tekrarlı başarısız import yükünde disk kullanımı sınırsız büyümez.
    for (let i = 0; i < 3; i++)
      await expect(
        store.publish(actor, {
          name: "leftover",
          scope: "project",
          projectId: project.id,
          baseRevision: null,
          files: SCRIPT_FILES,
        }),
      ).rejects.toMatchObject({ code: "candidate_tests_failed" });
    const staging = join(
      root,
      "tenants",
      tenantHash(actor.tenantId),
      "staging",
    );
    const leftovers = await readdir(staging).catch(() => []);
    expect(leftovers).toEqual([]);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #13 sandbox-unavailable publish leaves no staging behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-staging2-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const actor = await new IdentityService(storage.db).bootstrapLocal();
    const project = await new IdentityService(storage.db).createProject(
      actor,
      "Leftovers two",
    );
    const store = new PackageStore(storage, root); // validateScripts yok
    await expect(
      store.publish(actor, {
        name: "leftover",
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: SCRIPT_FILES,
      }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    const staging = join(
      root,
      "tenants",
      tenantHash(actor.tenantId),
      "staging",
    );
    expect(await readdir(staging).catch(() => [])).toEqual([]);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #13 unreferenced revision dirs are reported and reclaimed; winners survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-orphan-rev-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const actor = await new IdentityService(storage.db).bootstrapLocal();
    const project = await new IdentityService(storage.db).createProject(
      actor,
      "Orphan revisions",
    );
    const store = new PackageStore(storage, root);
    // Başarılı yayın: kazananın dizini asla silinmez.
    const winner = await store.publish(actor, {
      name: "winner",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES,
    });
    // DB tx'i başarısız olan yayın simülasyonu: revision dizinini elle kur
    // (rename sonrası tx öncesi crash eşdeğeri) ve mtime'ı eskit.
    const skillDir = join(
      root,
      "tenants",
      tenantHash(actor.tenantId),
      "packages",
      createHash("sha256")
        .update(`project:${project.id}`)
        .digest("hex")
        .slice(0, 20),
      winner.skill_id,
      "revisions",
    );
    const orphanDir = join(skillDir, "f".repeat(64), "winner");
    await (
      await import("node:fs/promises")
    ).mkdir(orphanDir, {
      recursive: true,
    });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(orphanDir, "SKILL.md"), Buffer.from("orphan")),
    );
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(join(skillDir, "f".repeat(64)), stale, stale);
    await utimes(orphanDir, stale, stale);
    const reconciled = await store.reconcile(actor);
    expect(reconciled.reclaimed_revisions).toBeGreaterThanOrEqual(1);
    expect(reconciled.reclaimed_staging).toBe(0);
    const winnerDir = join(skillDir, winner.revision, "winner");
    expect((await stat(winnerDir)).isDirectory()).toBe(true);
    const gone = await stat(orphanDir).then(
      () => false,
      () => true,
    );
    expect(gone).toBe(true);
    // Başarılı paket hâlâ okunur (immutable veri korundu).
    const reload = await store.files(actor, winner.skill_id, winner.revision);
    expect(reload.files["SKILL.md"]).toBeDefined();
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
