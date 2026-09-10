import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";

/** Issue #5: disabled-first membership must not block login or recovery. */
test("first active tenant selection skips disabled memberships", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-member-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const now = Date.now();
    const userA = randomUUID();
    await storage.db
      .insertInto("users")
      .values({
        id: userA,
        subject: "fixture|a",
        display_name: "A",
        created_at: now,
      })
      .execute();
    // "a-tenant" sorts before "b-tenant": disabled-first must be skipped.
    for (const [id, disabled] of [
      ["a-tenant", 1],
      ["b-tenant", 0],
    ] as const) {
      await storage.db
        .insertInto("tenants")
        .values({ id, name: id, created_at: now })
        .execute();
      await storage.db
        .insertInto("memberships")
        .values({ tenant_id: id, user_id: userA, role: "reader", disabled })
        .execute();
    }
    expect(await identities.firstActiveTenant(userA)).toMatchObject({
      tenant_id: "b-tenant",
    });
    // Only disabled memberships: no active tenant.
    await storage.db
      .updateTable("memberships")
      .set({ disabled: 1 })
      .where("tenant_id", "=", "b-tenant")
      .execute();
    expect(await identities.firstActiveTenant(userA)).toBeUndefined();
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #5 session-only recovery: revoked tenant access can switch safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-recovery-"));
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  try {
    const base = { host: new URL(cfg.url).host, origin: cfg.url };
    const issued = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...base, authorization: `Bearer ${cfg.token}` },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { ...base, cookie, "x-forge-csrf": login.json().csrf };
    // Second organization for the same account.
    const org = await app.inject({
      method: "POST",
      url: "/api/organizations",
      headers,
      payload: { name: "Kurtarma Org" },
    });
    expect(org.statusCode).toBe(200);
    const orgId = org.json().id;
    // Revoke access to the current tenant (local) out-of-band.
    const { openDatabase } = await import("../src/storage/database.js");
    const live = await openDatabase({ dataDir: root });
    await live.db
      .updateTable("memberships")
      .set({ disabled: 1 })
      .where("tenant_id", "=", "local")
      .execute();
    await live.close();
    // /api/me now distinguishes tenant denial from network failure.
    const me = await app.inject({ url: "/api/me", headers });
    expect(me.statusCode).toBe(403);
    expect(me.json().error?.code).toBe("tenant_unavailable");
    // Other data routes stay blocked.
    const blocked = await app.inject({ url: "/api/projects", headers });
    expect(blocked.statusCode).toBe(403);
    // Recovery list works with the session alone and leaks only own data.
    const mine = await app.inject({
      url: "/api/my-memberships",
      headers: { ...base, cookie },
    });
    expect(mine.statusCode).toBe(200);
    const items = mine.json().items as {
      tenant_id: string;
      disabled: number;
      name: string;
    }[];
    expect(items.some((i) => i.tenant_id === "local" && i.disabled === 1)).toBe(
      true,
    );
    expect(items.some((i) => i.tenant_id === orgId && i.disabled === 0)).toBe(
      true,
    );
    expect(
      items.every((i) => i.tenant_id === "local" || i.tenant_id === orgId),
    ).toBe(true);
    // Recovery switch to the active tenant carries CSRF protection.
    const csrf = mine.json().csrf;
    expect(typeof csrf).toBe("string");
    const deniedSwitch = await app.inject({
      method: "POST",
      url: "/api/tenants/switch",
      headers: { ...base, cookie },
      payload: { tenant_id: orgId },
    });
    expect(deniedSwitch.statusCode).toBe(403);
    const switched = await app.inject({
      method: "POST",
      url: "/api/tenants/switch",
      headers: { ...base, cookie, "x-forge-csrf": csrf },
      payload: { tenant_id: orgId },
    });
    expect(switched.statusCode).toBe(200);
    const switchedCookie = /forge_tenant=/.test(cookie)
      ? cookie.replace(/forge_tenant=[^;]*/, `forge_tenant=${orgId}`)
      : `${cookie}; forge_tenant=${orgId}`;
    const recovered = await app.inject({
      url: "/api/me",
      headers: { ...base, cookie: switchedCookie },
    });
    expect(recovered.statusCode, JSON.stringify(recovered.json())).toBe(200);
    expect(recovered.json().identity.tenantId).toBe(orgId);
    // Disabled tenant switch stays denied for the same session.
    const disabledSwitch = await app.inject({
      method: "POST",
      url: "/api/tenants/switch",
      headers: { ...base, cookie: switchedCookie, "x-forge-csrf": csrf },
      payload: { tenant_id: "local" },
    });
    expect(disabledSwitch.statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
