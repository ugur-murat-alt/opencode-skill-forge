import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
import { DeletionService } from "../src/application/deletion.js";

async function archivedPackage(root: string) {
  const storage = await openDatabase({ dataDir: root });
  const actor = await new IdentityService(storage.db).bootstrapLocal();
  const project = await new IdentityService(storage.db).createProject(
    actor,
    "Reader liveness",
  );
  const store = new PackageStore(storage, root);
  const name = `reader-pin-${randomUUID().slice(0, 8)}`;
  const pkg = await store.publish(actor, {
    name,
    scope: "project",
    projectId: project.id,
    baseRevision: null,
    files: {
      "SKILL.md": Buffer.from(
        `---\nname: ${name}\ndescription: Orphaned reader pin acceptance.\n---\nBody.\n`,
      ),
    },
  });
  const loaded = await store.files(actor, pkg.skill_id, pkg.revision);
  await new MaintenanceService(storage, root).apply(actor, {
    project_ref: project.id,
    operation_id: randomUUID(),
    action: "archive",
    items: [
      {
        skill_id: pkg.skill_id,
        revision: pkg.revision,
        updated_at: loaded.skill.updated_at,
      },
    ],
  });
  return {
    storage,
    actor,
    project,
    store,
    skillId: pkg.skill_id,
    revision: pkg.revision,
  };
}

/** Issue #12: a crashed process or failed cleanup leaves a durable reader
 * pin that used to block permanent deletion forever. Expired pins are now
 * cleared by the bounded reconcile sweep; live and ownerless pins stay. */
test.skipIf(process.platform !== "linux")(
  "P2 #12 expired reader pins clear safely; live/backup pins survive",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-reader-"));
    const { storage, actor, project, store, skillId, revision } =
      await archivedPackage(root);
    try {
      const insertPin = (owner: string | null, expiresAt: number | null) =>
        storage.db
          .insertInto("revision_readers")
          .values({
            tenant_id: actor.tenantId,
            id: randomUUID(),
            skill_id: skillId,
            revision,
            created_at: Date.now(),
            owner,
            expires_at: expiresAt,
          })
          .execute();
      const deletion = new DeletionService(storage, root);
      const archived = await store.authorizedSkill(actor, skillId);
      const input = {
        project_ref: project.id,
        operation_id: randomUUID(),
        action: "delete" as const,
        items: [
          {
            skill_id: skillId,
            revision,
            updated_at: archived.updated_at,
          },
        ],
      };
      // 1) Sahipsiz pin: DELETE hatası/crash sonrası kalıntı. Süresi geçmiş
      // pin artık silmeyi engellemez (sahibi kanıtla ölü); satır temizliği
      // uzlaştırmaya kalır.
      await insertPin("dead-generation", Date.now() - 1000);
      const unblocked = await deletion.preview(actor, input);
      expect(JSON.stringify(unblocked.items[0])).not.toContain(
        "skill_referenced",
      );
      // 2) Uzlaştırma süresi geçen pin'i güvenle temizler ve raporlar.
      const reconciled = await store.reconcile(actor);
      expect(reconciled.cleared_readers).toBeGreaterThanOrEqual(1);
      const orphanRow = await storage.db
        .selectFrom("revision_readers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "=", "dead-generation")
        .executeTakeFirst();
      expect(orphanRow).toBeUndefined();
      const cleared = await deletion.preview(actor, input);
      expect(JSON.stringify(cleared.items[0])).not.toContain(
        "skill_referenced",
      );
      // 3) Aktif uzun okuma korunur ve silmeyi engellemeye devam eder.
      await insertPin("live-generation", Date.now() + 60_000);
      const second = await store.reconcile(actor);
      expect(second.cleared_readers).toBe(0);
      const stillBlocked = await deletion.preview(actor, input);
      expect(stillBlocked.items[0]).toMatchObject({
        status: "blocked",
        error: { code: "skill_referenced" },
      });
      const liveRow = await storage.db
        .selectFrom("revision_readers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "=", "live-generation")
        .executeTakeFirst();
      expect(liveRow).toBeDefined();
      // 4) Sahipsiz (yedek) pin'ler sweep edilmemesi kuralıyla korunur.
      await insertPin(null, null);
      const third = await store.reconcile(actor);
      expect(third.cleared_readers).toBe(0);
      const ownerless = await storage.db
        .selectFrom("revision_readers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "is", null)
        .execute();
      expect(ownerless.length).toBe(1);
      await storage.db
        .deleteFrom("revision_readers")
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "is", null)
        .execute();
      await storage.db
        .deleteFrom("revision_readers")
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "=", "live-generation")
        .execute();
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
