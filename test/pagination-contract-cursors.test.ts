import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

const SKILL = {
  "SKILL.md": Buffer.from(
    "---\nname: cursor-fixture\ndescription: Cursor contract fixture.\n---\nBody.\n",
  ),
};

async function withServer(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof createHttpServer>>;
    storage: Awaited<ReturnType<typeof openDatabase>>;
    actor: { userId: string; tenantId: string };
    headers: Record<string, string>;
    projectId: string;
    root: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "forge-cursor-"));
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
      payload: { name: "Cursor anchor" },
    });
    const actor = await new IdentityService(storage.db).bootstrapLocal();
    await fn({
      app,
      storage,
      actor,
      headers,
      projectId: anchor.json().id,
      root,
    });
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Issue #29: /api/installations ignored `after`, so the UI re-merged the
 * first 100 rows 50 times. The endpoint must validate the cursor and apply
 * the same `id` keyset it orders by. */
test("P1 #29 installations pages every row once through a validated id cursor", async () => {
  await withServer(async ({ app, headers, projectId }) => {
    const ids = Array.from({ length: 105 }, (_, i) =>
      createHash("sha256").update(`cursor-install-${i}`).digest("hex"),
    );
    for (const [i, id] of ids.entries()) {
      const recorded = await app.inject({
        method: "POST",
        url: "/api/installations",
        headers,
        payload: {
          id,
          project_ref: projectId,
          client: "codex",
          version: "1.0.0",
          directory: `/seed/${i}`,
          event: "mcp_connected",
        },
      });
      expect(recorded.statusCode).toBe(200);
    }
    const seen: string[] = [];
    let next: string | null = null;
    for (let page = 0; page < 10; page++) {
      const response = await app.inject({
        url: `/api/installations?project_ref=${projectId}${next ? `&after=${next}` : ""}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      seen.push(...(body.items as { id: string }[]).map((row) => row.id));
      next = body.next;
      if (!next) break;
    }
    // Every installation exactly once: no repeated first page, no gap.
    expect(seen.length).toBe(105);
    expect(new Set(seen).size).toBe(105);
    expect([...seen].sort()).toEqual([...ids].sort());
    // The cursor is part of the request contract; garbage is a client error.
    const bogus = await app.inject({
      url: `/api/installations?project_ref=${projectId}&after=not-a-cursor`,
      headers,
    });
    expect(bogus.statusCode).toBe(400);
  });
});

/** Issue #29: the log cursor compares (created_at,id) but the SQL only
 * ordered by created_at; ties then follow the index/insertion order and
 * pages skip or repeat rows. */
test("P1 #29 logs ties break by id even when insertion order disagrees", async () => {
  await withServer(async ({ app, storage, actor, headers, projectId }) => {
    const total = 120;
    const at = Date.now();
    // Without the audit_time index the query planner cannot "accidentally"
    // return (created_at,id) order; the SQL must order ties explicitly.
    await sql`DROP INDEX audit_time`.execute(storage.db);
    const id = (i: number) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const order: number[] = [];
    for (let i = 0; i < total; i += 2) order.push(i);
    for (let i = 1; i < total; i += 2) order.push(i);
    for (const i of order)
      await storage.db
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: id(i),
          user_id: actor.userId,
          project_id: projectId,
          kind: "tie.event",
          detail: JSON.stringify({ i }),
          created_at: at,
        })
        .execute();
    const seen: string[] = [];
    let next: string | null = null;
    for (let page = 0; page < 10; page++) {
      const response = await app.inject({
        url: `/api/logs?project_ref=${projectId}&kind=tie.event${next ? `&after=${encodeURIComponent(next)}` : ""}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      seen.push(...(body.items as { id: string }[]).map((row) => row.id));
      next = body.next;
      if (!next) break;
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });
});

/** Issue #29: the revision cursor compares (created_at,revision) but the SQL
 * only ordered by created_at. Equal timestamps must still page completely. */
test("P1 #29 revisions tie-break by revision when timestamps are equal", async () => {
  await withServer(
    async ({ app, storage, actor, headers, projectId, root }) => {
      const store = new PackageStore(storage, root);
      const published = await store.publish(actor, {
        name: "cursor-fixture",
        scope: "project",
        projectId,
        baseRevision: null,
        files: SKILL,
      });
      const total = 60;
      const at = Date.now() + 60_000;
      const revision = (i: number) => i.toString(16).padStart(64, "0");
      const order: number[] = [];
      for (let i = 0; i < total; i += 2) order.push(i);
      for (let i = 1; i < total; i += 2) order.push(i);
      for (const i of order)
        await storage.db
          .insertInto("skill_revisions")
          .values({
            tenant_id: actor.tenantId,
            skill_id: published.skill_id,
            revision: revision(i),
            manifest_json: JSON.stringify({ files: [] }),
            package_path: `/tmp/unused/${i}`,
            created_by: actor.userId,
            run_id: null,
            validation_json: JSON.stringify({ passed: true }),
            created_at: at,
          })
          .execute();
      const seen: string[] = [];
      let next: string | null = null;
      for (let page = 0; page < 10; page++) {
        const response = await app.inject({
          url: `/api/skills/${published.skill_id}/revisions${next ? `?after=${encodeURIComponent(next)}` : ""}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        seen.push(
          ...(body.items as { revision: string }[]).map((row) => row.revision),
        );
        next = body.next;
        if (!next) break;
      }
      expect(seen.length).toBe(total + 1);
      expect(new Set(seen).size).toBe(total + 1);
      expect(seen).toContain(published.revision);
      for (let i = 0; i < total; i++) expect(seen).toContain(revision(i));
    },
  );
});
