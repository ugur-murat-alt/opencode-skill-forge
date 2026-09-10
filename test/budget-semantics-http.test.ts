import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { JobQueue } from "../src/jobs/queue.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

/** Issue #25: the API and UI must show the effective per-job limit, the
 * normal in-flight holds, the genuinely uncertain holds and the settled
 * spending as separate amounts, and the authorized recovery path resolves
 * an uncertain hold with a recorded actual amount.
 *
 * The test drives a real listening HTTP server over fetch. */
test("P2 #25 real HTTP overview separates job limit, in-flight, uncertain and spent; recovery endpoint is authorized", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-budget-http-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ maxCostMicros: 1_234_000 }),
    { mode: 0o600 },
  );
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  const live = await openDatabase({ dataDir: root });
  let base = cfg.url;
  let headers = {
    host: new URL(cfg.url).host,
    authorization: `Bearer ${cfg.token}`,
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };
  try {
    // Bind an ephemeral port so parallel test files can never collide.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    base = `http://127.0.0.1:${address.port}`;
    // The configured host is what the server validates; the socket port is
    // ephemeral so parallel test files can never collide.
    headers = {
      host: new URL(cfg.url).host,
      authorization: `Bearer ${cfg.token}`,
    };
    const created = await call("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Budget HTTP" }),
    });
    expect(created.status).toBe(200);
    const projectId = created.body.id as string;
    const identities = new IdentityService(live.db);
    const owner = await identities.bootstrapLocal();
    const queue = new JobQueue(live);
    const budget = new BudgetService(live);
    await budget.reconcileAccount(owner, 1_234_000);
    const run = await queue.accept(owner, {
      projectId,
      kind: "skill_evolve",
      key: randomUUID(),
      payload: { summary: "HTTP budget" },
    });
    await budget.reserve(owner, run.run.id, randomUUID(), 100_000, 1_234_000);
    const uncertain = randomUUID();
    await budget.reserve(owner, run.run.id, uncertain, 200_000, 1_234_000);
    await budget.settle(owner, uncertain, null);
    const overview = await call(
      `/api/overview?project_ref=${encodeURIComponent(projectId)}`,
    );
    expect(overview.status).toBe(200);
    expect(overview.body.account_budget).toMatchObject({
      job_limit_micros: 1_234_000,
      reserved_micros: 100_000,
      uncertain_micros: 200_000,
      spent_micros: 0,
    });
    expect(overview.body.account_budget.uncertain_reservations).toEqual([
      expect.objectContaining({
        id: uncertain,
        run_id: run.run.id,
        project_id: projectId,
        reserved_micros: 200_000,
      }),
    ]);
    // Unauthorized callers cannot touch the hold.
    const anonymous = await fetch(
      `${base}/api/budget/reservations/${uncertain}/reconcile`,
      {
        method: "POST",
        headers: { host: headers.host },
        body: JSON.stringify({ actual_micros: 1 }),
      },
    );
    expect(anonymous.status).toBe(401);
    // Unknown ids and invalid amounts are rejected before any accounting.
    expect(
      (
        await call(`/api/budget/reservations/${randomUUID()}/reconcile`, {
          method: "POST",
          body: JSON.stringify({ actual_micros: 1 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/api/budget/reservations/${uncertain}/reconcile`, {
          method: "POST",
          body: JSON.stringify({ actual_micros: -1 }),
        })
      ).status,
    ).toBe(400);
    const resolved = await call(
      `/api/budget/reservations/${uncertain}/reconcile`,
      { method: "POST", body: JSON.stringify({ actual_micros: 180_000 }) },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      id: uncertain,
      state: "settled",
      actual_micros: 180_000,
      reserved_micros: 100_000,
      uncertain_micros: 0,
      spent_micros: 180_000,
    });
    // A settled hold is not silently re-resolved.
    expect(
      (
        await call(`/api/budget/reservations/${uncertain}/reconcile`, {
          method: "POST",
          body: JSON.stringify({ actual_micros: 180_000 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/budget/reservations/${uncertain}/reconcile`, {
          method: "POST",
          body: JSON.stringify({ actual_micros: 10 }),
        })
      ).status,
    ).toBe(409);
    const audit = await live.db
      .selectFrom("audit_events")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "=", "budget.reservation_reconciled")
      .execute();
    expect(audit).toHaveLength(1);
  } finally {
    await live.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
