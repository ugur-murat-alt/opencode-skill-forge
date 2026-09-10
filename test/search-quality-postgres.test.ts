import { test, expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { EnvironmentService } from "../src/application/environments.js";
import { OrganizationService } from "../src/application/organization.js";
import { PackageStore, searchText } from "../src/skills/store.js";

const revisionFor = (id: string) =>
  createHash("sha256").update(id).digest("hex");
const idAt = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

/** Issue #24: the new group-stream/keyset SQL uses window functions and
 * dialect-sensitive LIKE/aggregate expressions, so the acceptance scenarios
 * also run on PostgreSQL when the test URL is configured. A dedicated
 * organization keeps the shared test database isolated from other files. */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #24 PostgreSQL keeps global ranking, scope merge and complete enumeration",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-pg-search-"));
    const storage = await openDatabase({
      dataDir,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    try {
      const identities = new IdentityService(storage.db);
      const localOwner = await identities.bootstrapLocal();
      const organization = await new OrganizationService(
        storage.db,
      ).createOrganization(localOwner.userId, `PG search ${randomUUID()}`);
      const owner = {
        tenantId: organization.id,
        userId: localOwner.userId,
      };
      const environment = await new EnvironmentService(storage.db).create(
        owner,
        { name: "staging" },
      );
      const project = await identities.createProject(
        owner,
        "PG search",
        environment.id,
      );
      const store = new PackageStore(storage, dataDir);
      const entries: {
        id: string;
        name: string;
        description: string;
        scopeKey: string;
        projectId: string | null;
      }[] = [];
      const filler = (i: number) =>
        entries.push({
          id: idAt(i),
          name: `pg-filler-${String(i).padStart(4, "0")}`,
          description: `Pg rank probe fixture ${i}.`,
          scopeKey: `project:${project.id}`,
          projectId: project.id,
        });
      for (let i = 0; i < 99; i++) filler(i);
      entries.push({
        id: idAt(99),
        name: "scope-merge-probe",
        description: "Pg scope merge probe copy.",
        scopeKey: "workspace",
        projectId: null,
      });
      entries.push({
        id: idAt(100),
        name: "scope-merge-probe",
        description: "Pg scope merge probe copy.",
        scopeKey: `personal:${owner.userId}`,
        projectId: null,
      });
      for (let i = 101; i <= 200; i++) filler(i);
      entries.push({
        id: idAt(201),
        name: "scope-merge-probe",
        description: "Pg scope merge probe copy.",
        scopeKey: `project:${project.id}`,
        projectId: project.id,
      });
      entries.push({
        id: idAt(202),
        name: "scope-merge-probe",
        description: "Pg scope merge probe copy.",
        scopeKey: `environment:${environment.id}`,
        projectId: null,
      });
      entries.push({
        id: idAt(203),
        name: "probe-rank-target",
        description: "Pg rank probe target.",
        scopeKey: `project:${project.id}`,
        projectId: project.id,
      });
      const now = Date.now();
      await storage.db.transaction().execute(async (tx) => {
        for (let offset = 0; offset < entries.length; offset += 100) {
          const chunk = entries.slice(offset, offset + 100);
          await tx
            .insertInto("skills")
            .values(
              chunk.map((entry) => ({
                tenant_id: owner.tenantId,
                id: entry.id,
                scope_key: entry.scopeKey,
                project_id: entry.projectId,
                owner_id: owner.userId,
                name: entry.name,
                description: entry.description,
                search_text: searchText(`${entry.name} ${entry.description}`),
                active_revision: null,
                managed: 1,
                pinned: 0,
                protected: 0,
                archived: 0,
                created_at: now,
                updated_at: now,
              })),
            )
            .execute();
          await tx
            .insertInto("skill_revisions")
            .values(
              chunk.map((entry) => ({
                tenant_id: owner.tenantId,
                skill_id: entry.id,
                revision: revisionFor(entry.id),
                manifest_json: JSON.stringify({ files: [] }),
                package_path: `pg/${entry.id}`,
                created_by: owner.userId,
                run_id: null,
                validation_json: JSON.stringify({ passed: true }),
                created_at: now,
              })),
            )
            .execute();
          for (const entry of chunk)
            await tx
              .updateTable("skills")
              .set({ active_revision: revisionFor(entry.id) })
              .where("tenant_id", "=", owner.tenantId)
              .where("id", "=", entry.id)
              .execute();
        }
      });
      const ranked = await store.search(owner, {
        projectId: project.id,
        query: "rank probe",
        limit: 5,
      });
      expect(ranked.items[0]!.skill_id).toBe(idAt(203));
      expect(ranked.scanned).toBeGreaterThan(0);
      expect(ranked.scored).toBeGreaterThan(0);
      expect(ranked.queries).toBeGreaterThanOrEqual(1);
      const merged = await store.search(owner, {
        projectId: project.id,
        query: "scope merge probe",
        limit: 5,
      });
      const copies = merged.items.filter(
        (item) => item.name === "scope-merge-probe",
      );
      expect(copies).toHaveLength(1);
      expect(copies[0]!.skill_id).toBe(idAt(201));
      expect(copies[0]!.other_scopes).toEqual([
        `environment:${environment.id}`,
        "workspace",
        `personal:${owner.userId}`,
      ]);
      expect(copies[0]!.other_skill_ids).toEqual([
        idAt(202),
        idAt(99),
        idAt(100),
      ]);
      const flat: { skill_id: string; name: string }[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 100; pages++) {
        const page = await store.search(owner, {
          projectId: project.id,
          limit: 20,
          ...(after ? { after } : {}),
        });
        flat.push(
          ...page.items.map((item) => ({
            skill_id: item.skill_id,
            name: item.name,
          })),
        );
        if (!page.next) break;
        after = page.next;
      }
      // 199 fillers + one merged name group + the target group.
      expect(flat).toHaveLength(201);
      expect(new Set(flat.map((row) => row.skill_id)).size).toBe(201);
      expect(new Set(flat.map((row) => row.name)).size).toBe(201);
    } finally {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);
