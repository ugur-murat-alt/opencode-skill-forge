import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import type { MemberRole } from "../src/domain/roles.js";

/**
 * Issue #34 (M01): the personal/project/organization scope matrix. Authority
 * always comes from identity/membership rows, never from the space name or a
 * note claim. Same-named spaces stay distinct identities, tenants never leak
 * into each other, and the first version creates no automatic cross-space
 * links or copies.
 */

async function addMember(
  storage: DatabaseHandle,
  tenantId: string,
  role: MemberRole,
  id: string = crypto.randomUUID(),
): Promise<Identity> {
  const now = Date.now();
  await storage.db
    .insertInto("users")
    .values({
      id,
      subject: `subject-${id}`,
      display_name: id,
      created_at: now,
    })
    .execute();
  await storage.db
    .insertInto("memberships")
    .values({ tenant_id: tenantId, user_id: id, role })
    .execute();
  return { userId: id, tenantId };
}

const denied = { code: "forbidden", status: 403 };
const unavailable = { code: "memory_space_unavailable", status: 404 };

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#34 space scope matrix is enforced per identity and backend (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-memory-scope-"));
    // Her backend kendi geçici veritabanını açar; paylaşımlı DB'de iz kalmaz.
    let postgresUrl: string | undefined;
    let admin: PgClient | undefined;
    const databaseName = `forge_mem_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    if (backend === "postgres") {
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const storage = await openDatabase({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
    const service = new MemoryService(storage.db);
    try {
      const identities = new IdentityService(storage.db);
      const owner = await identities.bootstrapLocal();
      const project = await identities.createProject(owner, "Ortak ad");

      // Aynı adlı ikinci bir kiracı ve üyeleri: izolasyon kanıtı için.
      const otherTenantId = crypto.randomUUID();
      await storage.db
        .insertInto("tenants")
        .values({ id: otherTenantId, name: "Diğer", created_at: Date.now() })
        .execute();
      const outsider = await addMember(storage, owner.tenantId, "writer");
      const reader = await addMember(storage, owner.tenantId, "reader");
      const otherTenant = await addMember(storage, otherTenantId, "founder");
      // Kiracı üyesi olmayan kimlik: hiçbir membership satırı yok.
      const nonMember: Identity = {
        userId: crypto.randomUUID(),
        tenantId: owner.tenantId,
      };
      await storage.db
        .insertInto("project_members")
        .values([
          {
            tenant_id: owner.tenantId,
            project_id: project.id,
            user_id: outsider.userId,
            role: "writer",
          },
          {
            tenant_id: owner.tenantId,
            project_id: project.id,
            user_id: reader.userId,
            role: "reader",
          },
        ])
        .execute();

      // Kişisel alan: yalnız sahibi. Proje alanı: proje üyeliği + rol.
      // Organizasyon alanı: kiracı üyeliği, yazma reader/auditor hariç.
      const personal = await service.ensureSpace(owner, { type: "personal" });
      const personalAgain = await service.ensureSpace(owner, {
        type: "personal",
      });
      expect(personalAgain.id).toBe(personal.id);
      const projectSpace = await service.ensureSpace(owner, {
        type: "project",
        projectId: project.id,
      });
      expect(
        (
          await service.ensureSpace(owner, {
            type: "project",
            projectId: project.id,
          })
        ).id,
      ).toBe(projectSpace.id);
      const organization = await service.createOrganizationSpace(
        owner,
        "Ortak ad",
      );
      // Aynı ad (proje adıyla ve başka bir organizasyon alanıyla) aynı kimlik
      // değildir; her alan kendi ACL'ini taşır.
      const organizationTwin = await service.createOrganizationSpace(
        owner,
        "Ortak ad",
      );
      expect(organizationTwin.id).not.toBe(organization.id);
      expect(organization.name).toBe(projectSpace.name);
      expect(organization.id).not.toBe(projectSpace.id);

      // Personal: owner okur/yazar; diğer herkes reddedilir.
      expect(
        (await service.authorizeSpace(owner, personal.id, "read")).id,
      ).toBe(personal.id);
      await expect(
        service.authorizeSpace(owner, personal.id, "write"),
      ).resolves.toMatchObject({ kind: "personal" });
      for (const actor of [outsider, reader, nonMember]) {
        await expect(
          service.authorizeSpace(actor, personal.id, "read"),
        ).rejects.toMatchObject(denied);
        await expect(
          service.authorizeSpace(actor, personal.id, "write"),
        ).rejects.toMatchObject(denied);
      }
      await expect(
        service.authorizeSpace(otherTenant, personal.id, "read"),
      ).rejects.toMatchObject(unavailable);

      // Project: üye yazar, reader okur ama yazamaz, üye olmayan reddedilir.
      await expect(
        service.authorizeSpace(owner, projectSpace.id, "write"),
      ).resolves.toMatchObject({ kind: "project" });
      await expect(
        service.authorizeSpace(outsider, projectSpace.id, "write"),
      ).resolves.toMatchObject({ kind: "project" });
      await expect(
        service.authorizeSpace(reader, projectSpace.id, "read"),
      ).resolves.toMatchObject({ kind: "project" });
      await expect(
        service.authorizeSpace(reader, projectSpace.id, "write"),
      ).rejects.toMatchObject(denied);
      await expect(
        service.authorizeSpace(otherTenant, projectSpace.id, "read"),
      ).rejects.toMatchObject(unavailable);

      // Aynı adlı organizasyon alanı farklı ACL taşır: proje üyesi olmayan
      // kiracı üyesi organizasyona yazabilir ama proje alanına yazamaz.
      await expect(
        service.authorizeSpace(otherTenant, organization.id, "read"),
      ).rejects.toMatchObject(unavailable);
      const tenantOnly = await addMember(storage, owner.tenantId, "writer");
      await expect(
        service.authorizeSpace(tenantOnly, organization.id, "write"),
      ).resolves.toMatchObject({ kind: "organization" });
      await expect(
        service.authorizeSpace(tenantOnly, projectSpace.id, "write"),
      ).rejects.toMatchObject(denied);

      // Organization: reader okur ama yazamaz; non-member reddedilir.
      await expect(
        service.authorizeSpace(reader, organization.id, "read"),
      ).resolves.toMatchObject({ kind: "organization" });
      await expect(
        service.authorizeSpace(reader, organization.id, "write"),
      ).rejects.toMatchObject(denied);
      await expect(
        service.authorizeSpace(nonMember, organization.id, "read"),
      ).rejects.toMatchObject(denied);
      await expect(
        service.createOrganizationSpace(reader, "Reader alanı"),
      ).rejects.toMatchObject(denied);

      // Kişisel alan ancak yazma yetkili üye tarafından açılır.
      await expect(
        service.ensureSpace(reader, { type: "personal" }),
      ).rejects.toMatchObject(denied);

      // Alanlar arası otomatik kalıcı link/kopya yok: kişisel alana yazılan
      // olay başka alanın uzlaştırmasında görünmez.
      const event = await service.recordEvent(owner, {
        spaceId: personal.id,
        sourceEventKey: "session:1",
        sourceKind: "session",
        contentHash: "a".repeat(64),
      });
      expect(event.status).toBe("recorded");
      const ownerReport = await service.reconcile(owner);
      expect(ownerReport.checked).toBe(1);
      const orgReport = await service.reconcile(outsider, {
        spaceId: organization.id,
      });
      expect(orgReport).toEqual({
        checked: 0,
        pending: 0,
        committed: 0,
        rejected: 0,
        conflicts: 0,
      });
      // Kiracı dışından kişisel alan hiç görünmez.
      await expect(
        service.reconcile(otherTenant, { spaceId: personal.id }),
      ).rejects.toMatchObject(unavailable);
      const events = await storage.db
        .selectFrom("memory_events")
        .select(["space_id"])
        .where("tenant_id", "=", owner.tenantId)
        .execute();
      expect(events).toEqual([{ space_id: personal.id }]);
    } finally {
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
