import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { api, setActiveTenant } from "../web/src/api.js";

const originalFetch = globalThis.fetch;
type Captured = { path: string; headers: Record<string, string> };
const captured: Captured[] = [];

function spyFetch() {
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({
      path: String(input),
      headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
    });
    return new Response(JSON.stringify({ csrf: "csrf-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setActiveTenant("");
  captured.length = 0;
});

test("P1 #3 API calls carry the visible screen tenant header", async () => {
  spyFetch();
  setActiveTenant("tenant-b");
  await api("/api/roles");
  expect(captured[0]!.headers["x-forge-tenant"]).toBe("tenant-b");
});

test("P1 #3 auth and non-API paths do not claim a tenant", async () => {
  spyFetch();
  setActiveTenant("tenant-b");
  await api("/auth/pair", { method: "POST", body: "{}" });
  expect(captured[0]!.headers["x-forge-tenant"]).toBeUndefined();
});

test("P1 #3 unset tenant sends no header", async () => {
  spyFetch();
  await api("/api/roles");
  expect(captured[0]!.headers["x-forge-tenant"]).toBeUndefined();
});

test("P1 #3 explicit tenant without membership is forbidden (server)", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-tenant-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const member = await new MemberService(storage.db).create(owner, {
      subject: "fixture|member",
      display_name: "Member",
      role: "writer",
    });
    const session = await identities.issueSession(
      member.user_id,
      "session",
      60_000,
    );
    const own = await identities.authenticate(session, owner.tenantId);
    expect(own.userId).toBe(member.user_id);
    await expect(
      identities.authenticate(session, "foreign-tenant-id"),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
