import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SettingsService } from "../src/application/settings.js";
import { resolveSettings } from "../src/domain/settings.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  describe(`storage contract: ${backend}`, () => {
    test("migration, scope FK, ACL, one-use pairing, config CAS and persistence", async () => {
      const root = await mkdtemp(join(tmpdir(), "forge-db-contract-"));
      const options = {
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      };
      let handle = await openDatabase(options);
      try {
        const service = new IdentityService(handle.db);
        const owner = await service.bootstrapLocal();
        const project = await service.createProject(owner, "Çalışma ağacı");
        const id = crypto.randomUUID();
        await handle.db
          .insertInto("users")
          .values({
            id,
            subject: id,
            display_name: "İkinci kullanıcı",
            created_at: Date.now(),
          })
          .execute();
        await handle.db
          .insertInto("tenants")
          .values({ id, name: "İkinci tenant", created_at: Date.now() })
          .execute();
        await handle.db
          .insertInto("memberships")
          .values({ tenant_id: id, user_id: id, role: "owner" })
          .execute();
        const other = { userId: id, tenantId: id };
        await expect(
          service.authorize(other, "read", project.id),
        ).rejects.toMatchObject({ code: "project_unavailable" });
        await expect(
          handle.db
            .insertInto("project_members")
            .values({
              tenant_id: id,
              project_id: project.id,
              user_id: id,
              role: "editor",
            })
            .execute(),
        ).rejects.toThrow();
        const code = await service.issueSession(owner.userId, "pairing", 5000);
        const results = await Promise.allSettled([
          service.redeemPairing(code),
          service.redeemPairing(code),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const token = (
          results.find(
            (r) => r.status === "fulfilled",
          ) as PromiseFulfilledResult<string>
        ).value;
        expect(await service.authenticate(token, owner.tenantId)).toEqual(
          owner,
        );
        await expect(
          service.authenticate(token, other.tenantId),
        ).rejects.toMatchObject({ code: "forbidden" });
        await service.revoke(token);
        await expect(
          service.authenticate(token, owner.tenantId),
        ).rejects.toMatchObject({ code: "unauthorized" });
        const settings = new SettingsService(service, {
          maxCalls: 6,
          maxCostMicros: 500,
        });
        const scope = `project:${project.id}`;
        await settings.update(owner, scope, 0, { maxCalls: 3 });
        await expect(
          settings.update(owner, scope, 0, { maxCalls: 6 }),
        ).rejects.toMatchObject({ code: "revision_conflict" });
        expect(
          (await settings.effective(owner, project.id, { maxCalls: 99 })).values
            .maxCalls,
        ).toBe(3);
        expect(
          (await settings.effective(owner, project.id)).sources.maxCalls,
        ).toBe(scope);
        await expect(settings.get(other, scope)).rejects.toThrow();
        const now = await handle.now();
        expect(Math.abs(now - Date.now())).toBeLessThan(2000);
        await handle.close();
        handle = await openDatabase(options);
        expect(
          (
            await new SettingsService(new IdentityService(handle.db)).get(
              owner,
              scope,
            )
          ).revision,
        ).toBe(1);
      } finally {
        await handle.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
test("specific settings cannot broaden policy and cannot smuggle unknown permission keys", () => {
  const result = resolveSettings(
    {
      maxCalls: 6,
      allowPaid: false,
      allowedOrigins: ["https://one.test", "https://two.test"],
    },
    [
      {
        source: "project",
        values: {
          maxCalls: 99,
          allowPaid: true,
          allowedOrigins: ["https://one.test", "https://evil.test"],
        },
      },
    ],
  );
  expect(result.values.maxCalls).toBe(6);
  expect(result.sources.maxCalls).toBe("system_policy");
  expect(result.values.allowPaid).toBe(false);
  expect(result.values.allowedOrigins).toEqual(["https://one.test"]);
  expect(() =>
    resolveSettings({}, [
      { source: "untrusted", values: { admin: true } as never },
    ]),
  ).toThrow();
});
