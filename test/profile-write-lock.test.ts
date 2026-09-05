import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database.js";
import { SecretVault } from "../src/storage/secrets.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { ProviderService } from "../src/application/providers.js";
import { SettingsService } from "../src/application/settings.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`settings and provider writes ${backend}: CAS, metadata audit and revocation lock`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-profile-lock-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const auth = new IdentityService(storage.db),
        owner = await auth.bootstrapLocal();
      const member = await new MemberService(storage.db).create(owner, {
        subject: `fixture|${crypto.randomUUID()}`,
        display_name: "Profile writer",
        role: "editor",
      });
      const actor = { ...owner, userId: member.user_id },
        vault = await SecretVault.open(root);
      const provider = new ProviderService(auth, vault);
      const body = {
        role: "prompt",
        base_revision: 0,
        profile: { provider: "ollama", model: "fixture-model" },
        credential: "synthetic-profile-secret",
      };
      const writes = await Promise.allSettled([
        provider.update(actor, body),
        provider.update(actor, body),
      ]);
      expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (writes.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason.code,
      ).toBe("revision_conflict");
      const audit = await storage.db
        .selectFrom("audit_events")
        .select("detail")
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("kind", "=", "provider.updated")
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain("synthetic-profile-secret");
      expect(JSON.stringify(audit)).not.toContain("fixture-model");
      if (backend === "postgres") {
        // Hold the same row as membership updates. Both requests pass their
        // initial read, then must wait for revocation to commit and reauthorize.
        let started = 0;
        let ready!: () => void;
        const checked = new Promise<void>((resolve) => {
          ready = resolve;
        });
        class ObservedIdentity extends IdentityService {
          override async authorize(
            ...args: Parameters<IdentityService["authorize"]>
          ) {
            const result = await super.authorize(...args);
            if (++started === 2) ready();
            return result;
          }
        }
        let pending!: Promise<PromiseSettledResult<unknown>[]>;
        await storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("tenants")
            .set({ name: sql`name` })
            .where("id", "=", actor.tenantId)
            .execute();
          const observed = new ObservedIdentity(storage.db);
          pending = Promise.allSettled([
            new ProviderService(observed, vault).update(actor, {
              ...body,
              base_revision: 1,
            }),
            new SettingsService(observed).update(
              actor,
              `personal:${actor.userId}`,
              0,
              { promptEnabled: false },
            ),
          ]);
          await checked;
          await tx
            .updateTable("memberships")
            .set({ disabled: 1, generation: sql`generation + 1` })
            .where("tenant_id", "=", actor.tenantId)
            .where("user_id", "=", actor.userId)
            .execute();
        });
        const outcomes = await pending;
        expect(outcomes.every((r) => r.status === "rejected")).toBe(true);
        for (const outcome of outcomes)
          expect((outcome as PromiseRejectedResult).reason.status).toBe(403);
      } else {
        await storage.db
          .updateTable("memberships")
          .set({ disabled: 1 })
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .execute();
      }
      await expect(
        provider.update(actor, { ...body, base_revision: 1 }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        new SettingsService(auth).update(actor, `personal:${actor.userId}`, 0, {
          promptEnabled: false,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await storage.db
          .selectFrom("provider_profiles")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await storage.db
          .selectFrom("config_revisions")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("scope_key", "=", `personal:${actor.userId}`)
          .execute(),
      ).toHaveLength(0);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
