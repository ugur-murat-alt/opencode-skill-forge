import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { ForgeService } from "../src/application/forge.js";
import { RoleService } from "../src/application/roles.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-roles-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const project = await identities.createProject(owner, "Matrix fixture");
  return { root, storage, identities, owner, project };
}

async function memberAs(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
  role: string,
) {
  const created = await new MemberService(storage.db).create(owner, {
    subject: `fixture|${randomUUID()}`,
    display_name: `Role ${role}`,
    role,
  });
  return { tenantId: owner.tenantId, userId: created.user_id };
}

test("P18 builtin tool matrix denies by role with explanations", async () => {
  const { root, storage, owner, project } = await setup();
  try {
    const forge = new ForgeService(storage, root, "test-key");
    const base = { project_ref: project.id, query: "" };
    const runArgs = {
      project_ref: project.id,
      skill_id: "missing",
      revision: "0".repeat(64),
      entrypoint: "calculate",
      args: {},
      idempotency_key: "matrix-no-run",
    };
    const handoffArgs = {
      project_ref: project.id,
      summary: "Reusable method.",
      idempotency_key: "matrix-no-handoff",
      source: { client: "matrix" },
      evidence: [{ kind: "test", summary: "Verified in matrix." }],
    };
    await expect(
      forge.invoke(
        "forge_run",
        await asRole(storage, owner, "reader"),
        runArgs,
      ),
    ).rejects.toMatchObject({ code: "tool_denied" });
    try {
      await forge.invoke(
        "forge_run",
        await asRole(storage, owner, "reader"),
        runArgs,
      );
      expect.unreachable();
    } catch (error: any) {
      expect(error.detail.role).toBe("reader");
      expect(error.detail.tool).toBe("forge_run");
    }
    const auditor = await asRole(storage, owner, "auditor");
    const auditorRow = (
      await new MemberService(storage.db).list(owner, project.id)
    ).items.find((m) => m.user_id === auditor.userId)!;
    await new MemberService(storage.db).update(owner, auditor.userId, {
      project_ref: project.id,
      generation: auditorRow.generation,
      project_generation: null,
      role: "auditor",
      disabled: false,
      project_role: "reader",
    });
    await expect(
      forge.invoke("forge_search", auditor, base),
    ).rejects.toMatchObject({ code: "tool_denied" });
    const report = await forge.invoke("forge_report", auditor, {
      project_ref: project.id,
    });
    expect(report).toBeDefined();
    const writer = await asRole(storage, owner, "writer");
    const writerRow = (
      await new MemberService(storage.db).list(owner, project.id)
    ).items.find((m) => m.user_id === writer.userId)!;
    await new MemberService(storage.db).update(owner, writer.userId, {
      project_ref: project.id,
      generation: writerRow.generation,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    await expect(
      forge.invoke("forge_search", writer, base),
    ).resolves.toBeDefined();
    const handed = await forge.invoke("forge_handoff", writer, {
      ...handoffArgs,
      idempotency_key: "matrix-handoff-ok",
    });
    expect(handed.status).toBe("accepted");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function asRole(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
  role: string,
) {
  return memberAs(storage, owner, role);
}

test("P18 custom roles narrow tools and unknown roles fail closed", async () => {
  const { root, storage, owner, project } = await setup();
  try {
    const roles = new RoleService(storage.db);
    const custom = await roles.create(owner, {
      name: "reporter",
      base: "reader",
      tools: ["forge_report"],
    });
    expect(custom.name).toBe("reporter");
    const member = await memberAs(storage, owner, "reporter");
    const reporterRow = (
      await new MemberService(storage.db).list(owner, project.id)
    ).items.find((m) => m.user_id === member.userId)!;
    await new MemberService(storage.db).update(owner, member.userId, {
      project_ref: project.id,
      generation: reporterRow.generation,
      project_generation: null,
      role: "reporter",
      disabled: false,
      project_role: "reader",
    });
    const forge = new ForgeService(storage, root, "test-key");
    await expect(
      forge.invoke("forge_search", member, {
        project_ref: project.id,
        query: "",
      }),
    ).rejects.toMatchObject({ code: "tool_denied" });
    await expect(
      forge.invoke("forge_report", member, { project_ref: project.id }),
    ).resolves.toBeDefined();
    await expect(
      roles.create(owner, { name: "founder", base: "reader" }),
    ).rejects.toMatchObject({ code: "role_reserved" });
    await expect(
      roles.create(owner, { name: "Bad Name!", base: "reader" }),
    ).rejects.toMatchObject({ code: "invalid_role" });
    const ghostId = randomUUID();
    await storage.db
      .insertInto("users")
      .values({
        id: ghostId,
        subject: `fixture|${ghostId}`,
        display_name: "Ghost",
        created_at: Date.now(),
      })
      .execute();
    await storage.db
      .insertInto("memberships")
      .values({
        tenant_id: owner.tenantId,
        user_id: ghostId,
        role: "ghost-role",
        generation: 0,
      })
      .execute();
    const ghost = { tenantId: owner.tenantId, userId: ghostId };
    await expect(
      forge.invoke("forge_search", ghost, {
        project_ref: project.id,
        query: "",
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P18 role deletion requires empty membership and protects founder", async () => {
  const { root, storage, owner, project } = await setup();
  try {
    const roles = new RoleService(storage.db);
    await expect(roles.remove(owner, "founder")).rejects.toMatchObject({
      code: "role_protected",
    });
    await roles.create(owner, { name: "temp", base: "reader" });
    const member = await memberAs(storage, owner, "temp");
    await expect(roles.remove(owner, "temp")).rejects.toMatchObject({
      code: "role_in_use",
    });
    await new MemberService(storage.db).update(owner, member.userId, {
      project_ref: project.id,
      generation: 0,
      project_generation: null,
      role: "reader",
      disabled: false,
      project_role: null,
    });
    await roles.remove(owner, "temp");
    const listed = await roles.list(owner);
    expect(listed.some((r) => r.name === "temp" && !r.deleted)).toBe(false);
    expect(
      listed.some((r) => r.name === "temp" && r.deleted && r.builtin === false),
    ).toBe(true);
    const restored = await new RoleService(storage.db).restore(owner, "temp");
    expect(restored).toMatchObject({ name: "temp", restored: true });
    expect(
      (await roles.list(owner)).some((r) => r.name === "temp" && !r.deleted),
    ).toBe(true);
    const again = await new RoleService(storage.db).restore(owner, "temp");
    expect(again).toMatchObject({ name: "temp", restored: false });
    await roles.remove(owner, "writer");
    expect(
      (await roles.list(owner)).some((r) => r.name === "writer" && r.deleted),
    ).toBe(true);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P18 MCP tool list is filtered by membership role", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-role-mcp-")),
    config = await localConfig(root);
  const seed = await openDatabase({ dataDir: root });
  const tokens: Record<string, string> = {};
  try {
    const identities = new IdentityService(seed.db);
    const owner = await identities.bootstrapLocal();
    for (const role of ["reader", "auditor", "writer"] as const) {
      const created = await new MemberService(seed.db).create(owner, {
        subject: `fixture|${randomUUID()}`,
        display_name: `Role ${role}`,
        role,
      });
      tokens[role] = await identities.issueSession(
        created.user_id,
        "session",
        60000,
      );
    }
  } finally {
    await seed.close();
  }
  const app = await createHttpServer(config);
  try {
    await app.listen({ host: config.host, port: config.port });
    const me = await (
      await fetch(`${config.url}/api/me`, {
        headers: {
          host: new URL(config.url).host,
          authorization: `Bearer ${config.token}`,
        },
      })
    ).json();
    const tenant = me.identity.tenantId;
    const list = async (role: string) => {
      const session = tokens[role]!;
      const client = new Client({ name: "role-matrix", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
            requestInit: {
              headers: {
                host: new URL(config.url).host,
                cookie: `forge_session=${session}; forge_tenant=${tenant}`,
                "x-forge-csrf": createHash("sha256")
                  .update(session)
                  .digest("hex"),
              },
            },
          }),
        );
        return (await client.listTools()).tools.map((t) => t.name).sort();
      } finally {
        await client.close();
      }
    };
    expect(await list("reader")).toEqual([
      "forge_load",
      "forge_report",
      "forge_search",
    ]);
    expect(await list("auditor")).toEqual(["forge_report"]);
    expect(await list("writer")).toEqual([
      "forge_handoff",
      "forge_load",
      "forge_report",
      "forge_run",
      "forge_search",
    ]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P18 grant cannot escalate above the grantor", async () => {
  const { root, storage, owner } = await setup();
  try {
    const admin = await memberAs(storage, owner, "admin");
    await expect(
      new MemberService(storage.db).create(admin, {
        subject: `fixture|${randomUUID()}`,
        display_name: "Peer admin",
        role: "admin",
      }),
    ).resolves.toBeDefined();
    await expect(
      new MemberService(storage.db).create(admin, {
        subject: `fixture|${randomUUID()}`,
        display_name: "Sneaky founder",
        role: "founder",
      }),
    ).rejects.toMatchObject({ code: "grant_denied" });
    const writer = await memberAs(storage, owner, "writer");
    await expect(
      new MemberService(storage.db).create(writer, {
        subject: `fixture|${randomUUID()}`,
        display_name: "Nope",
        role: "reader",
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
