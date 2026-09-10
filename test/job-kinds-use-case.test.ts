import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ForgeService } from "../src/application/forge.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { toolSchemas } from "../src/domain/tool-contracts.js";
import {
  defaultJobKinds,
  type JobKindDefinition,
} from "../src/domain/job-kinds.js";

/**
 * Issue #32 pilot: the run report read model lives in one application
 * use-case (`ForgeService.reports`); the HTTP `/api/runs` adapter, the MCP
 * `forge_report` dispatcher and a direct caller all read the same function.
 * Runs of both job kinds are visible through every entry point.
 */
test("P2 #32 run report use-case is shared by HTTP, MCP dispatch and direct call", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-use-case-"));
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Use case pilot");
    const fixtureKind: JobKindDefinition = {
      kind: "fixture_reconcile",
      payload: z.object({ note: z.string().min(1) }).strict(),
      skillProfile: false,
    };
    type TestKind = "skill_evolve" | "fixture_reconcile";
    const queue = new JobQueue<TestKind>(
      storage,
      {},
      { ...defaultJobKinds, fixture_reconcile: fixtureKind },
    );
    const fixture = await queue.accept(owner, {
      projectId: project.id,
      kind: "fixture_reconcile",
      key: crypto.randomUUID(),
      payload: { note: "use-case fixture" },
    });
    await queue.accept(owner, {
      projectId: project.id,
      kind: "skill_evolve",
      key: crypto.randomUUID(),
      payload: { summary: "use-case skill" },
    });

    // Direct use-case call (the API both adapters now share).
    const forge = new ForgeService(storage, root, config.token);
    const reportInput = toolSchemas.forge_report.parse({
      project_ref: project.id,
      limit: 20,
    });
    const direct = await forge.reports.report(owner, reportInput);
    const kindsSeen = direct.items.map((item) => item.kind).sort();
    expect(kindsSeen).toEqual(["fixture_reconcile", "skill_evolve"]);
    const directDetail = await forge.reports.report(owner, {
      ...reportInput,
      run_id: fixture.run.id,
    });

    // MCP tool dispatch reaches the same use-case.
    const viaMcp = await forge.invoke("forge_report", owner, {
      project_ref: project.id,
      limit: 20,
    });
    expect(
      (viaMcp.items as { run_id: string; kind: string }[])
        .map((item) => ({ run_id: item.run_id, kind: item.kind }))
        .sort((a, b) => a.run_id.localeCompare(b.run_id)),
    ).toEqual(
      direct.items
        .map((item) => ({ run_id: item.run_id, kind: item.kind }))
        .sort((a, b) => a.run_id.localeCompare(b.run_id)),
    );
    const mcpDetail = await forge.invoke("forge_report", owner, {
      project_ref: project.id,
      run_id: fixture.run.id,
    });
    expect(mcpDetail).toEqual(directDetail);

    // HTTP adapter calls the same use-case through the Fastify route.
    const headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
    const response = await app.inject({
      method: "GET",
      url: `/api/runs?project_ref=${project.id}&limit=20`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const httpBody = response.json() as { items: { kind: string }[] };
    expect(httpBody.items.map((item) => item.kind).sort()).toEqual([
      "fixture_reconcile",
      "skill_evolve",
    ]);
    const httpDetail = await app.inject({
      method: "GET",
      url: `/api/runs?project_ref=${project.id}&run_id=${fixture.run.id}`,
      headers,
    });
    expect(httpDetail.statusCode).toBe(200);
    expect(httpDetail.json()).toEqual(directDetail);

    // Cursor continuity: the run listing pages with the same opaque cursor
    // through HTTP and the MCP dispatcher (one binding implementation).
    const paged = await app.inject({
      method: "GET",
      url: `/api/runs?project_ref=${project.id}&limit=1`,
      headers,
    });
    const nextCursor = paged.json().next_cursor as string | null;
    expect(nextCursor).toBeTruthy();
    const viaMcpPage = await forge.invoke("forge_report", owner, {
      project_ref: project.id,
      limit: 1,
      cursor: nextCursor,
    });
    expect(viaMcpPage.items).toHaveLength(1);
    expect(direct.items.map((item) => item.run_id)).toEqual(
      expect.arrayContaining([viaMcpPage.items[0].run_id]),
    );
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
