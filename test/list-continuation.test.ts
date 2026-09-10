import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

const SKILL = {
  "SKILL.md": Buffer.from(
    "---\nname: paged\ndescription: Continuation paging fixture.\n---\nBody.\n",
  ),
};

async function login(app: Awaited<ReturnType<typeof createHttpServer>>) {
  const cfg = (app as unknown as { _cfg?: unknown }) ?? undefined;
  void cfg;
  return app;
}
void login;

/** Issue #15/#29: management and history lists must expose bounded
 * continuation pages instead of silently truncating at 100/50 rows, must not
 * repeat rows between pages, and the cursor must really be applied. */
test("P2 #15 projects, logs, installations and revisions page completely", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-pages-"));
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  const storage = await openDatabase({ dataDir: root });
  try {
    const base = { host: new URL(cfg.url).host, origin: cfg.url };
    const issued = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...base, authorization: `Bearer ${cfg.token}` },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    const cookie = loginRes.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const headers = { ...base, cookie, "x-forge-csrf": loginRes.json().csrf };
    const anchor = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "Anchor" },
    });
    const projectId = anchor.json().id as string;

    // 105 proje: /api/projects keyset taraması hepsini bulur.
    for (let i = 0; i < 104; i++)
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: `Page project ${i}` },
      });
    const projectIds: string[] = [];
    let next = null;
    for (let i = 0; i < 20; i++) {
      const page = await app.inject({
        url: `/api/projects${next ? `?after=${next}` : ""}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      for (const item of page.json().items as { id: string }[])
        projectIds.push(item.id);
      next = page.json().next;
      if (!next) break;
    }
    expect(projectIds.length).toBe(105);
    expect(new Set(projectIds).size).toBe(105);
    expect(projectIds).toContain(projectId);

    // 55 revision: tek pakette geçmiş tamamen keşfedilir (HTTP handler ile).
    const identities = new IdentityService(storage.db);
    const actor = await identities.bootstrapLocal();
    const store = new PackageStore(storage, root);
    const first = await store.publish(actor, {
      name: "paged",
      scope: "project",
      projectId,
      baseRevision: null,
      files: SKILL,
    });
    for (let i = 1; i < 55; i++)
      await store.publish(actor, {
        name: "paged",
        scope: "project",
        projectId,
        baseRevision:
          i === 1
            ? first.revision
            : (
                await storage.db
                  .selectFrom("skills")
                  .select("active_revision")
                  .where("tenant_id", "=", actor.tenantId)
                  .where("id", "=", first.skill_id)
                  .executeTakeFirstOrThrow()
              ).active_revision!,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: paged\ndescription: Continuation paging fixture v${i}.\n---\nBody.\n`,
          ),
        },
      });
    const revisions: string[] = [];
    let revisionNext: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await app.inject({
        url: `/api/skills/${first.skill_id}/revisions${revisionNext ? `?after=${revisionNext}` : ""}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      for (const item of page.json().items as { revision: string }[])
        revisions.push(item.revision);
      revisionNext = page.json().next;
      if (!revisionNext) break;
    }
    expect(revisions.length).toBe(55);
    expect(new Set(revisions).size).toBe(55);

    // 120 audit event (aynı timestamp'li çiftler dahil) tamamen taranır.
    const now = Date.now();
    const events = Array.from({ length: 120 }, (_, i) => ({
      tenant_id: actor.tenantId,
      id: randomUUID(),
      user_id: actor.userId,
      project_id: projectId,
      kind: `fixture.event.${i % 3}`,
      detail: JSON.stringify({ i }),
      created_at: now - (i % 5), // 120 kayıt, 3 ayrı timestamp'te kümelenir
    }));
    await storage.db.insertInto("audit_events").values(events).execute();
    const seen: string[] = [];
    let logNext: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await app.inject({
        url: `/api/logs?project_ref=${projectId}${logNext ? `&after=${logNext}` : ""}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      for (const item of page.json().items as { id: string }[])
        seen.push(item.id);
      logNext = page.json().next;
      if (!logNext) break;
    }
    // Fixtürün 120 kaydı eksiksiz ve tekrarsız taranır.
    expect(events.every((e) => seen.includes(e.id!))).toBe(true);
    expect(seen.length).toBe(new Set(seen).size);
    expect(seen.length).toBeGreaterThanOrEqual(120);
    expect(
      (
        await app.inject({
          url: `/api/logs?project_ref=${projectId}&after=bogus`,
          headers,
        })
      ).statusCode,
    ).toBe(400);

    // 105 kurulum: after cursor'ı gerçekten uygulanır, hiçbir satır
    // yinelenmez veya atlanmaz.
    const installationIds = Array.from({ length: 105 }, (_, i) =>
      createHash("sha256").update(`list-continuation-${i}`).digest("hex"),
    );
    for (const [i, id] of installationIds.entries()) {
      const recorded = await app.inject({
        method: "POST",
        url: "/api/installations",
        headers,
        payload: {
          id,
          project_ref: projectId,
          client: "claude",
          version: null,
          directory: `/continuation/${i}`,
          event: "installed",
        },
      });
      expect(recorded.statusCode).toBe(200);
    }
    const installed: string[] = [];
    let installNext: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await app.inject({
        url: `/api/installations?project_ref=${projectId}${installNext ? `&after=${installNext}` : ""}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      for (const item of page.json().items as { id: string }[])
        installed.push(item.id);
      installNext = page.json().next;
      if (!installNext) break;
    }
    expect(installed.length).toBe(105);
    expect(new Set(installed).size).toBe(105);
    expect([...installed].sort()).toEqual([...installationIds].sort());
    expect(
      (
        await app.inject({
          url: `/api/installations?project_ref=${projectId}&after=not-a-cursor`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
