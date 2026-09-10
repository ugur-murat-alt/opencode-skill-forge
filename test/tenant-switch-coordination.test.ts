import { test, expect, afterEach } from "bun:test";
import {
  api,
  setActiveTenant,
  activeTenantValue,
  beginTenantTransition,
  currentTenantTransition,
  settleTenantTransition,
  tenantTransitionPending,
} from "../web/src/api.js";

const originalFetch = globalThis.fetch;
type Captured = {
  path: string;
  method: string;
  headers: Record<string, string>;
};
const captured: Captured[] = [];

function spyFetch() {
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({
      path: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  settleTenantTransition(currentTenantTransition());
  setActiveTenant("");
  captured.length = 0;
});

/** Issue #22: the tenant transition is one coordinated operation. While it
 * is pending no ordinary mutation may go out under either context. */
test("P1 #22 pending tenant switch blocks ordinary mutations before fetch", async () => {
  spyFetch();
  setActiveTenant("tenant-a");
  beginTenantTransition();
  expect(tenantTransitionPending()).toBe(true);
  await expect(
    api("/api/projects", { method: "POST", body: "{}" }),
  ).rejects.toMatchObject({ code: "tenant_switch_pending" });
  await expect(
    api("/api/agent-prompts", { method: "PUT", body: "{}" }),
  ).rejects.toMatchObject({ code: "tenant_switch_pending" });
  expect(captured.length).toBe(0);
});

test("P1 #22 transition requests pass the target tenant explicitly", async () => {
  spyFetch();
  setActiveTenant("tenant-a");
  beginTenantTransition();
  await api(
    "/api/tenants/switch",
    { method: "POST", body: JSON.stringify({ tenant_id: "tenant-b" }) },
    { tenant: "tenant-b" },
  );
  await api("/api/me", {}, { tenant: "tenant-b" });
  expect(captured.map((c) => c.headers["x-forge-tenant"])).toEqual([
    "tenant-b",
    "tenant-b",
  ]);
});

test("P1 #22 reads during a pending switch keep the visible screen tenant", async () => {
  spyFetch();
  setActiveTenant("tenant-a");
  beginTenantTransition();
  await api("/api/roles");
  expect(captured[0]!.headers["x-forge-tenant"]).toBe("tenant-a");
});

/** Rapid A→B→C selections: only the newest generation may commit the visible
 * account context; superseded completions must not roll the screen back. */
test("P1 #22 superseded tenant transitions cannot commit", () => {
  setActiveTenant("tenant-a");
  const toB = beginTenantTransition();
  const toC = beginTenantTransition();
  expect(settleTenantTransition(toB, "tenant-b")).toBe(false);
  expect(tenantTransitionPending()).toBe(true);
  expect(activeTenantValue()).toBe("tenant-a");
  expect(settleTenantTransition(toC, "tenant-c")).toBe(true);
  expect(tenantTransitionPending()).toBe(false);
  expect(activeTenantValue()).toBe("tenant-c");
});

test("P1 #22 a failed transition clears pending without moving the context", () => {
  setActiveTenant("tenant-a");
  const failed = beginTenantTransition();
  expect(settleTenantTransition(failed)).toBe(true);
  expect(tenantTransitionPending()).toBe(false);
  expect(activeTenantValue()).toBe("tenant-a");
});
