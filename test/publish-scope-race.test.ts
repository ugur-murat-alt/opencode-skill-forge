import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { PackageStore } from "../src/skills/store.js";

const SKILL_MD = Buffer.from(
  "---\nname: scope-race\ndescription: Publish/scope race fixture.\n---\nBody.\n",
);
const SIMPLE_FILES = { "SKILL.md": SKILL_MD };
const SCRIPT_FILES = {
  "SKILL.md": SKILL_MD,
  "scripts/main.js": Buffer.from(
    "const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8')).x;console.log(JSON.stringify({value:x*2}));",
  ),
  "forge.json": Buffer.from(
    JSON.stringify({
      version: 1,
      entrypoints: {
        calculate: {
          runtime: "node",
          path: "scripts/main.js",
          inputSchema: {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
          },
          tests: [{ name: "double", input: { x: 3 }, expected: { value: 6 } }],
        },
      },
    }),
  ),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(postgresUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), "forge-race-"));
  const storage = await openDatabase({ dataDir: root, postgresUrl });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const project = await identities.createProject(owner, "Writer project");
  const members = new MemberService(storage.db);
  const writerRow = await members.create(owner, {
    subject: `fixture|${randomUUID()}`,
    display_name: "Writer",
    role: "writer",
  });
  await members.update(owner, writerRow.user_id, {
    project_ref: project.id,
    generation: 0,
    project_generation: null,
    role: "writer",
    disabled: false,
    project_role: "writer",
  });
  const writer: Identity = { ...owner, userId: writerRow.user_id };
  return { root, storage, owner, project, writer };
}

type MoveInput =
  { scope: "workspace" } | { scope: "project"; projectId: string };

/**
 * Issue #2: a publish that starts while the skill sits in one scope must not
 * commit after the skill was moved to another scope concurrently. The writer
 * only holds project write authority; the move lands during the
 * script-validation barrier.
 */
async function scopeRace(move: MoveInput, postgresUrl?: string) {
  const { root, storage, owner, project, writer } = await setup(postgresUrl);
  try {
    const store = new PackageStore(storage, root);
    const first = await store.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: SIMPLE_FILES,
    });
    expect(first.decision).toBe("create");
    const base = first.revision;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const racing = new PackageStore(storage, root, async (_path, manifest) => {
      reached = true;
      await gate;
      return {
        hash: manifest.hash,
        passed: true,
        sandbox: "barrier",
        report: null,
      };
    });
    const pending = racing.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: base,
      files: SCRIPT_FILES,
    });
    pending.catch(() => {});
    for (let i = 0; i < 400 && !reached; i++) await sleep(10);
    expect(reached).toBe(true);

    await store.setScope(owner, first.skill_id, {
      ...move,
      expectedRevision: base,
    });

    release();
    await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });

    const row = await storage.db
      .selectFrom("skills")
      .select(["scope_key", "project_id", "active_revision"])
      .where("id", "=", first.skill_id)
      .executeTakeFirst();
    expect(row!.scope_key).toBe(
      move.scope === "project" ? `project:${move.projectId}` : "workspace",
    );
    // Active content did not change: the stale publish was fully discarded.
    expect(row!.active_revision).toBe(base);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("P1 #2 stale publish stops after project→workspace scope move", async () => {
  await scopeRace({ scope: "workspace" });
});

test("P1 #2 stale publish stops after project→another project move", async () => {
  const { root, storage, owner, project, writer } = await setup();
  try {
    const other = await new IdentityService(storage.db).createProject(
      owner,
      "Other project",
    );
    const store = new PackageStore(storage, root);
    const first = await store.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: SIMPLE_FILES,
    });
    const base = first.revision;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const racing = new PackageStore(storage, root, async (_path, manifest) => {
      reached = true;
      await gate;
      return {
        hash: manifest.hash,
        passed: true,
        sandbox: "barrier",
        report: null,
      };
    });
    const pending = racing.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: base,
      files: SCRIPT_FILES,
    });
    pending.catch(() => {});
    for (let i = 0; i < 400 && !reached; i++) await sleep(10);
    expect(reached).toBe(true);

    await store.setScope(owner, first.skill_id, {
      scope: "project",
      projectId: other.id,
      expectedRevision: base,
    });

    release();
    await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
    const row = await storage.db
      .selectFrom("skills")
      .select(["scope_key", "active_revision"])
      .where("id", "=", first.skill_id)
      .executeTakeFirst();
    expect(row!.scope_key).toBe(`project:${other.id}`);
    expect(row!.active_revision).toBe(base);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P1 #2 stale personal publish stops after personal→workspace move", async () => {
  const { root, storage, owner } = await setup();
  try {
    const store = new PackageStore(storage, root);
    const first = await store.publish(owner, {
      name: "scope-race",
      scope: "personal",
      baseRevision: null,
      files: SIMPLE_FILES,
    });
    const base = first.revision;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const racing = new PackageStore(storage, root, async (_path, manifest) => {
      reached = true;
      await gate;
      return {
        hash: manifest.hash,
        passed: true,
        sandbox: "barrier",
        report: null,
      };
    });
    const pending = racing.publish(owner, {
      name: "scope-race",
      scope: "personal",
      baseRevision: base,
      files: SCRIPT_FILES,
    });
    pending.catch(() => {});
    for (let i = 0; i < 400 && !reached; i++) await sleep(10);
    expect(reached).toBe(true);

    await store.setScope(owner, first.skill_id, {
      scope: "workspace",
      expectedRevision: base,
    });

    release();
    await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
    const row = await storage.db
      .selectFrom("skills")
      .select(["scope_key", "active_revision"])
      .where("id", "=", first.skill_id)
      .executeTakeFirst();
    expect(row!.scope_key).toBe("workspace");
    expect(row!.active_revision).toBe(base);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P1 #2 legitimate publish still passes the validation barrier", async () => {
  const { root, storage, project, writer } = await setup();
  try {
    const store = new PackageStore(storage, root);
    const first = await store.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: SIMPLE_FILES,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barriered = new PackageStore(storage, root, async (_p, manifest) => {
      await gate;
      return {
        hash: manifest.hash,
        passed: true,
        sandbox: "barrier",
        report: null,
      };
    });
    const pending = barriered.publish(writer, {
      name: "scope-race",
      scope: "project",
      projectId: project.id,
      baseRevision: first.revision,
      files: SCRIPT_FILES,
    });
    pending.catch(() => {});
    release();
    const second = await pending;
    expect(second.decision).toBe("update");
    const row = await storage.db
      .selectFrom("skills")
      .select("active_revision")
      .where("id", "=", second.skill_id)
      .executeTakeFirst();
    expect(row!.active_revision).toBe(second.revision);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P1 #2 stale publish stops after scope move on PostgreSQL",
  async () => {
    const admin = new Client({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const dbName = `forge_race_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${dbName}`;
    try {
      await scopeRace({ scope: "workspace" }, url.toString());
    } finally {
      await admin.query(`DROP DATABASE "${dbName}"`).catch(() => {});
      await admin.end();
    }
  },
);
