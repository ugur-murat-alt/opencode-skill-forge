import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import {
  PackageStore,
  type PackageStoreLiveness,
} from "../src/skills/store.js";

const childScript = new URL("./file-lifecycle-child.ts", import.meta.url)
  .pathname;
const tenantHash = (tenantId: string) =>
  createHash("sha256").update(tenantId).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function fixture(root: string, liveness?: PackageStoreLiveness) {
  const storage = await openDatabase({ dataDir: root });
  const actor = await new IdentityService(storage.db).bootstrapLocal();
  const project = await new IdentityService(storage.db).createProject(
    actor,
    "File lifecycle crash",
  );
  const store = new PackageStore(storage, root, undefined, {}, liveness);
  return { storage, actor, project, store };
}

test.skipIf(process.platform !== "linux")(
  "P2 #28 real rename-then-crash before commit: the expired claim lets restart reclaim and republish safely",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-gc-crash-"));
    const { storage, actor, project, store } = await fixture(root, {
      leaseMs: 400,
      // Büyük grace: kurtarma yalnız claim süresi dolduğu için çalışır, mtime yaşından değil.
      reclaimGraceMs: 60_000,
      reclaimBudget: 50,
      claimWaitMs: 2_000,
    });
    let child: ChildProcess | undefined;
    try {
      const name = `crash-race-${randomUUID().slice(0, 8)}`;
      const frontmatter = (body: string) =>
        `---\nname: ${name}\ndescription: Rename crash ${body}.\n---\nBody ${body}.\n`;
      const first = await store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: { "SKILL.md": Buffer.from(frontmatter("one")) },
      });
      const firstPath = await storage.db
        .selectFrom("skill_revisions")
        .select("package_path")
        .where("tenant_id", "=", actor.tenantId)
        .where("skill_id", "=", first.skill_id)
        .executeTakeFirstOrThrow();
      const revisionsDir = join(root, dirname(dirname(firstPath.package_path)));
      const resultFile = join(root, "child-result.json");
      const diagnostics: string[] = [];
      child = spawn(process.execPath, [childScript, "publish"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          FORGE_TEST_ROOT: root,
          FORGE_TEST_RESULT: resultFile,
          FORGE_TEST_NAME: name,
          FORGE_TEST_PROJECT: project.id,
          FORGE_TEST_SKILL: first.skill_id,
          FORGE_TEST_BASE: first.revision,
          FORGE_TEST_CONTENT: frontmatter("two"),
          FORGE_TEST_STALL_COMMIT: "1",
          FORGE_TEST_LEASE_MS: "400",
          FORGE_TEST_GRACE_MS: "60000",
        },
      });
      child.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
      child.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
      const before = await readdir(revisionsDir);
      let arrived: string | undefined;
      for (let attempt = 0; attempt < 750 && !arrived; attempt++) {
        arrived = (await readdir(revisionsDir)).find(
          (entry) => !before.includes(entry),
        );
        if (!arrived) await sleep(20);
      }
      if (!arrived)
        throw new Error(
          `Yeni revision dizini görünmedi: ${diagnostics.join("")}`,
        );
      expect(arrived).toBeDefined();
      // Issue #28: sıra mkdir → claim → rename olduğundan hash dizini claim'den
      // önce görünebilir. Ebeveyn yalnız rename edilmiş içerik dizini VE claim
      // satırı birlikte görünene kadar bekler; kill bu durumda deterministiktir.
      const renamedPath = join(revisionsDir, arrived!, name);
      let claimSeen = false;
      for (let attempt = 0; attempt < 500 && !claimSeen; attempt++) {
        claimSeen =
          (await exists(renamedPath)) &&
          Boolean(
            await storage.db
              .selectFrom("package_claims")
              .select("kind")
              .where("tenant_id", "=", actor.tenantId)
              .where("kind", "=", "revision")
              .executeTakeFirst(),
          );
        if (!claimSeen) await sleep(10);
      }
      if (!claimSeen)
        throw new Error(
          `Rename/claim durumu görünmedi: ${diagnostics.join("")}`,
        );
      // Dizin rename edildi, DB commit'i askıda; claim sahibi süreç henüz canlı sanılır.
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      child = undefined;
      expect(
        await storage.db
          .selectFrom("skill_revisions")
          .select("revision")
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", first.skill_id)
          .execute(),
      ).toHaveLength(1);
      expect(await exists(join(revisionsDir, arrived!, name))).toBe(true);
      // Claim süresi dolar; restart kurtarır (mtime taze olsa bile).
      await sleep(700);
      const recovered = await store.reclaim(actor);
      expect(recovered.reclaimed_revisions).toBeGreaterThanOrEqual(1);
      expect(recovered.reclaimed_staging).toBeGreaterThanOrEqual(1);
      expect(await exists(join(revisionsDir, arrived!))).toBe(false);
      expect(
        await storage.db
          .selectFrom("package_claims")
          .select("claim_key")
          .where("tenant_id", "=", actor.tenantId)
          .execute(),
      ).toEqual([]);
      const republished = await store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        skillId: first.skill_id,
        baseRevision: first.revision,
        files: { "SKILL.md": Buffer.from(frontmatter("two")) },
      });
      expect(republished.decision).toBe("update");
      const reload = await store.files(
        actor,
        first.skill_id,
        republished.revision,
        ["SKILL.md"],
      );
      expect(reload.files["SKILL.md"]!.toString("utf8")).toContain("Body two");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(process.platform !== "linux")(
  "P2 #28 long active staging is preserved by its heartbeat; a paused publisher's staging is reclaimed and the publish fails safely",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-gc-staging-"));
    const { storage, actor, project, store } = await fixture(root, {
      leaseMs: 400,
      reclaimGraceMs: 100,
      reclaimBudget: 50,
      claimWaitMs: 2_000,
    });
    let child: ChildProcess | undefined;
    try {
      const name = `staging-live-${randomUUID().slice(0, 8)}`;
      const marker = join(root, "validating.marker");
      const gate = join(root, "validate.gate");
      const resultFile = join(root, "child-result.json");
      const diagnostics: string[] = [];
      child = spawn(process.execPath, [childScript, "staging"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          FORGE_TEST_ROOT: root,
          FORGE_TEST_RESULT: resultFile,
          FORGE_TEST_NAME: name,
          FORGE_TEST_PROJECT: project.id,
          FORGE_TEST_MARKER: marker,
          FORGE_TEST_GATE: gate,
          FORGE_TEST_LEASE_MS: "400",
          FORGE_TEST_GRACE_MS: "100",
        },
      });
      child.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
      child.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
      const stagingRoot = join(
        root,
        "tenants",
        tenantHash(actor.tenantId),
        "staging",
      );
      let marked = false;
      for (let attempt = 0; attempt < 500 && !marked; attempt++) {
        marked = await exists(marker);
        if (!marked) await sleep(20);
      }
      if (!marked)
        throw new Error(`Doğrulama işareti görünmedi: ${diagnostics.join("")}`);
      const stagingEntries = await readdir(stagingRoot);
      expect(stagingEntries).toHaveLength(1);
      // Uzun doğrulama: mtime grace'i aşsa da kalp atışı staging'i korur.
      await sleep(250);
      const active = await store.reclaim(actor);
      expect(active.reclaimed_staging).toBe(0);
      expect(active.skipped.claims).toBeGreaterThanOrEqual(1);
      expect(await exists(join(stagingRoot, stagingEntries[0]!))).toBe(true);
      // Süreç duraklatılır: heartbeat durur, staging geri kazanılır.
      child.kill("SIGSTOP");
      await sleep(800);
      const paused = await store.reclaim(actor);
      expect(paused.reclaimed_staging).toBeGreaterThanOrEqual(1);
      expect(await exists(join(stagingRoot, stagingEntries[0]!))).toBe(false);
      await writeFile(gate, "release");
      child.kill("SIGCONT");
      const exited = once(child, "exit");
      const [code] = await exited;
      expect(code).toBe(0);
      child = undefined;
      const result = JSON.parse(
        (await (
          await import("node:fs/promises")
        ).readFile(resultFile, "utf8")) as string,
      );
      expect(result.ok).toBe(false);
      expect(typeof result.code).toBe("string");
      expect(
        await storage.db
          .selectFrom("skills")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("name", "=", name)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await storage.db
          .selectFrom("skill_revisions")
          .select("revision")
          .where("tenant_id", "=", actor.tenantId)
          .execute(),
      ).toEqual([]);
      expect((await readdir(stagingRoot)).length).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
