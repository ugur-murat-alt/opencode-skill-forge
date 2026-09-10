import { test, expect } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";

const stale = new Date(Date.now() - 60 * 60 * 1000);
const tenantHash = (tenantId: string) =>
  createHash("sha256").update(tenantId).digest("hex");
function nameAbove(names: string[]): string {
  const digits = "0123456789abcdef";
  const chars = [...names.slice().sort().at(-1)!];
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = digits.indexOf(chars[index]!) + 1;
    if (next < digits.length) {
      chars[index] = digits[next]!;
      for (let tail = index + 1; tail < chars.length; tail++) chars[tail] = "0";
      return chars.join("");
    }
  }
  return "f".repeat(64);
}

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #28 postgres: bounded reclaim continuation, claim barrier and winner protection",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-gc-pg-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const storage = await openDatabase({
      dataDir,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    let store: PackageStore | undefined;
    try {
      const actor = { tenantId: randomUUID(), userId: randomUUID() };
      const now = Date.now();
      await storage.db
        .insertInto("tenants")
        .values({
          id: actor.tenantId,
          name: "PG file lifecycle",
          created_at: now,
        })
        .execute();
      await storage.db
        .insertInto("users")
        .values({
          id: actor.userId,
          subject: `fixture|${actor.userId}`,
          display_name: "Owner",
          created_at: now,
        })
        .execute();
      await storage.db
        .insertInto("memberships")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          role: "founder",
        })
        .execute();
      const project = await new IdentityService(storage.db).createProject(
        actor,
        "PG file lifecycle",
      );
      store = new PackageStore(
        storage,
        dataDir,
        undefined,
        {},
        {
          reclaimBudget: 4,
          reclaimGraceMs: 30,
          leaseMs: 60_000,
        },
      );
      const name = `pg-gc-${randomUUID().slice(0, 8)}`;
      let base: string | null = null;
      let skillId: string | undefined;
      for (let revision = 0; revision < 10; revision++) {
        const pkg = await store.publish(actor, {
          name,
          scope: "project",
          projectId: project.id,
          skillId,
          baseRevision: base,
          files: {
            "SKILL.md": Buffer.from(
              `---\nname: ${name}\ndescription: PG continuation ${revision}.\n---\nBody ${revision}.\n`,
            ),
          },
        });
        skillId = pkg.skill_id;
        base = pkg.revision;
      }
      const pathRow = await storage.db
        .selectFrom("skill_revisions")
        .select("package_path")
        .where("tenant_id", "=", actor.tenantId)
        .where("skill_id", "=", skillId!)
        .limit(1)
        .executeTakeFirstOrThrow();
      const revisionsDir = join(
        dataDir,
        dirname(dirname(pathRow.package_path)),
      );
      const liveNames = (await readdir(revisionsDir)).filter((entry) =>
        /^[a-f0-9]{64}$/.test(entry),
      );
      expect(liveNames.length).toBe(10);
      const orphan = nameAbove(liveNames);
      const orphanDir = join(revisionsDir, orphan, name);
      await mkdir(orphanDir, { recursive: true, mode: 0o700 });
      await writeFile(join(orphanDir, "SKILL.md"), "orphan");
      await utimes(join(revisionsDir, orphan), stale, stale);
      await utimes(orphanDir, stale, stale);
      let rounds = 0;
      let complete = false;
      let reclaimed = 0;
      while (!complete && rounds < 10) {
        const result = await store.reclaim(actor);
        rounds++;
        complete = result.reclaim_complete;
        reclaimed += result.reclaimed_revisions;
      }
      expect(rounds).toBeGreaterThanOrEqual(2);
      expect(complete).toBe(true);
      expect(reclaimed).toBe(1);
      expect(
        await lstat(join(revisionsDir, orphan)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      // Kazananlar korunur: bounded turlar tamamlanana kadar referanslı kalır.
      let protectedReferenced = 0;
      let protectedReclaimed = 0;
      let protectedComplete = false;
      for (let round = 0; round < 10 && !protectedComplete; round++) {
        const page = await store.reclaim(actor);
        protectedReferenced += page.skipped.referenced;
        protectedReclaimed += page.reclaimed_revisions;
        protectedComplete = page.reclaim_complete;
      }
      expect(protectedReclaimed).toBe(0);
      expect(protectedReferenced).toBeGreaterThanOrEqual(10);
      // Yaşayan publisher claim'i reclaim'i durdurur.
      const orphanTwo = "e".repeat(64);
      const orphanTwoDir = join(revisionsDir, orphanTwo, name);
      await mkdir(orphanTwoDir, { recursive: true, mode: 0o700 });
      await writeFile(join(orphanTwoDir, "SKILL.md"), "orphan-two");
      await utimes(join(revisionsDir, orphanTwo), stale, stale);
      await utimes(orphanTwoDir, stale, stale);
      const dbNow = await storage.now();
      await storage.db
        .insertInto("package_claims")
        .values({
          tenant_id: actor.tenantId,
          kind: "revision",
          claim_key: `${skillId!}/${orphanTwo}`,
          owner: "publisher-pg",
          expires_at: dbNow + 60_000,
          created_at: dbNow,
        })
        .execute();
      let waitingReclaimed = 0;
      let waitingClaims = 0;
      for (let round = 0, complete = false; round < 10 && !complete; round++) {
        const page = await store.reclaim(actor);
        waitingReclaimed += page.reclaimed_revisions;
        waitingClaims += page.skipped.claims;
        complete = page.reclaim_complete;
      }
      expect(waitingReclaimed).toBe(0);
      expect(waitingClaims).toBeGreaterThanOrEqual(1);
      expect(
        await lstat(join(revisionsDir, orphanTwo)).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      await storage.db
        .deleteFrom("package_claims")
        .where("tenant_id", "=", actor.tenantId)
        .where("claim_key", "=", `${skillId!}/${orphanTwo}`)
        .execute();
      let releasedReclaimed = 0;
      for (let round = 0, complete = false; round < 10 && !complete; round++) {
        const page = await store.reclaim(actor);
        releasedReclaimed += page.reclaimed_revisions;
        complete = page.reclaim_complete;
      }
      expect(releasedReclaimed).toBe(1);
      // Staging claim'i de geri kazanımı durdurur.
      const stagingRoot = join(
        dataDir,
        "tenants",
        tenantHash(actor.tenantId),
        "staging",
      );
      const stagingDir = join(stagingRoot, randomUUID());
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      await writeFile(join(stagingDir, "leftover"), "staging");
      await utimes(stagingDir, stale, stale);
      const stagingKey = `tenants/${tenantHash(actor.tenantId)}/staging/${stagingDir.split("/").at(-1)!}`;
      await storage.db
        .insertInto("package_claims")
        .values({
          tenant_id: actor.tenantId,
          kind: "staging",
          claim_key: stagingKey,
          owner: "publisher-pg",
          expires_at: (await storage.now()) + 60_000,
          created_at: await storage.now(),
        })
        .execute();
      expect((await store.reclaim(actor)).reclaimed_staging).toBe(0);
      await storage.db
        .deleteFrom("package_claims")
        .where("tenant_id", "=", actor.tenantId)
        .where("kind", "=", "staging")
        .execute();
      expect((await store.reclaim(actor)).reclaimed_staging).toBe(1);
    } finally {
      await store?.dispose();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
