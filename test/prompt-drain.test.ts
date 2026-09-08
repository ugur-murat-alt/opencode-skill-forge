import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../src/storage/schema.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { promptDrainMigration } from "../src/storage/prompt-drain-migration.js";

async function seedRun(
  db: Kysely<DB>,
  seed: {
    tenantId: string;
    userId: string;
    projectId: string;
    sessionId: string;
    kind: string;
    state: string;
  },
) {
  const now = Date.now(),
    id = randomUUID();
  await db
    .insertInto("forge_sessions")
    .values({
      tenant_id: seed.tenantId,
      id: seed.sessionId,
      user_id: seed.userId,
      project_id: seed.projectId,
      created_at: now,
    })
    .execute();
  await db
    .insertInto("runs")
    .values({
      tenant_id: seed.tenantId,
      id,
      session_id: seed.sessionId,
      user_id: seed.userId,
      project_id: seed.projectId,
      kind: seed.kind,
      state: seed.state,
      idempotency_key: randomUUID(),
      input_hash: "fixture",
      input_json: "{}",
      config_json: "{}",
      result_json: null,
      error_code: null,
      created_at: now,
      updated_at: now,
      available_at: now,
      deadline_at: now + 600000,
      lease_until: 0,
      worker_id: null,
      fence: 0,
      attempt: 0,
      max_attempts: 3,
    })
    .execute();
  return id;
}

test("P22 drain cancels stranded prompt runs without touching skill runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-prompt-drain-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const owner = await new IdentityService(storage.db).bootstrapLocal(),
      project = await new IdentityService(storage.db).createProject(
        owner,
        "Drain fixture",
      ),
      base = {
        tenantId: owner.tenantId,
        userId: owner.userId,
        projectId: project.id,
      };
    const stranded = await seedRun(storage.db, {
      ...base,
      sessionId: randomUUID(),
      kind: "prompt_edit",
      state: "queued",
    });
    const terminal = await seedRun(storage.db, {
      ...base,
      sessionId: randomUUID(),
      kind: "prompt_edit",
      state: "completed",
    });
    const skill = await seedRun(storage.db, {
      ...base,
      sessionId: randomUUID(),
      kind: "skill_evolve",
      state: "queued",
    });
    await promptDrainMigration.up(storage.db);
    const drained = await storage.db
      .selectFrom("runs")
      .select(["id", "state", "error_code"])
      .where("id", "in", [stranded, terminal, skill])
      .execute();
    const byId = new Map(drained.map((row) => [row.id, row]));
    expect(byId.get(stranded)).toMatchObject({
      state: "cancelled",
      error_code: "prompt_removed",
    });
    expect(byId.get(terminal)).toMatchObject({ state: "completed" });
    expect(byId.get(skill)).toMatchObject({ state: "queued" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P22 queue rejects removed run kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-prompt-drain-kind-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const owner = await new IdentityService(storage.db).bootstrapLocal(),
      project = await new IdentityService(storage.db).createProject(
        owner,
        "Kind guard fixture",
      );
    await expect(
      new JobQueue(storage).accept(owner, {
        projectId: project.id,
        kind: "prompt_edit" as "skill_evolve",
        key: randomUUID(),
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_kind" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
