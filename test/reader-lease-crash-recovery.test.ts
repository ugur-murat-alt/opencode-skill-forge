import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";

const childScript = new URL("./file-lifecycle-child.ts", import.meta.url)
  .pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(process.platform !== "linux")(
  "P2 #27 integrity scan killed after its pin commit: restart reclaims the owned pins without touching revisions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-lease-crash-"));
    const storage = await openDatabase({ dataDir: root });
    let child: ChildProcess | undefined;
    try {
      const actor = await new IdentityService(storage.db).bootstrapLocal();
      const project = await new IdentityService(storage.db).createProject(
        actor,
        "Integrity crash",
      );
      const store = new PackageStore(
        storage,
        root,
        undefined,
        {},
        {
          leaseMs: 500,
        },
      );
      const name = `integrity-crash-${randomUUID().slice(0, 8)}`;
      let base: string | null = null;
      let skillId: string | undefined;
      for (let revision = 0; revision < 25; revision++) {
        const files: Record<string, Buffer> = {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Integrity crash revision ${revision}.\n---\nBody ${revision}.\n`,
          ),
        };
        for (let file = 0; file < 64; file++)
          files[`files/f${file}.txt`] = Buffer.from(
            `revision-${revision}-file-${file}-${"x".repeat(2048)}`,
          );
        const pkg = await store.publish(actor, {
          name,
          scope: "project",
          projectId: project.id,
          skillId,
          baseRevision: base,
          files,
        });
        skillId = pkg.skill_id;
        base = pkg.revision;
      }
      const revisionRows = await storage.db
        .selectFrom("skill_revisions")
        .select("revision")
        .where("tenant_id", "=", actor.tenantId)
        .where("skill_id", "=", skillId!)
        .execute();
      expect(revisionRows).toHaveLength(25);
      child = spawn(process.execPath, [childScript, "reconcile"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          FORGE_TEST_ROOT: root,
          FORGE_TEST_RESULT: join(root, "child-result.json"),
          FORGE_TEST_LEASE_MS: "500",
        },
      });
      // Pin commit'i görülür görülmez süreç öldürülür (cleanup çalışamaz).
      let pins = 0;
      for (let attempt = 0; attempt < 5_000 && pins === 0; attempt++) {
        pins = Number(
          (
            await storage.db
              .selectFrom("revision_readers")
              .select((eb) => eb.fn.countAll<number>().as("n"))
              .where("tenant_id", "=", actor.tenantId)
              .where("kind", "=", "integrity")
              .executeTakeFirstOrThrow()
          ).n,
        );
        if (pins === 0) await sleep(1);
      }
      expect(pins).toBeGreaterThan(0);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      const leftover = await storage.db
        .selectFrom("revision_readers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("kind", "=", "integrity")
        .execute();
      expect(leftover.length).toBeGreaterThan(0);
      for (const pin of leftover) {
        expect(pin.owner).not.toBeNull();
        expect(pin.expires_at).not.toBeNull();
      }
      // Yeniden başlatma: süresi geçen sahipli pin'ler kurtarılır, revision'lar korunur.
      await sleep(800);
      const restarted = new PackageStore(
        storage,
        root,
        undefined,
        {},
        {
          leaseMs: 500,
        },
      );
      const recovered = await restarted.reconcile(actor);
      expect(recovered.cleared_readers).toBeGreaterThanOrEqual(leftover.length);
      expect(recovered.issues).toEqual([]);
      expect(
        await storage.db
          .selectFrom("revision_readers")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .execute(),
      ).toEqual([]);
      const revisionsDir = join(
        root,
        (
          await storage.db
            .selectFrom("skill_revisions")
            .select("package_path")
            .where("tenant_id", "=", actor.tenantId)
            .where("skill_id", "=", skillId!)
            .limit(1)
            .executeTakeFirstOrThrow()
        ).package_path
          .split("/")
          .slice(0, -2)
          .join("/"),
      );
      expect((await readdir(revisionsDir)).length).toBe(25);
      const reload = await restarted.files(
        actor,
        skillId!,
        revisionRows[0]!.revision,
      );
      expect(reload.files["SKILL.md"]).toBeDefined();
      expect(reload.files["files/f0.txt"]).toBeDefined();
      child = undefined;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
