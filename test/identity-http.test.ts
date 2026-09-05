import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { SecretVault } from "../src/storage/secrets.js";
import { redact } from "../src/telemetry/redact.js";
test("local browser login uses a one-use code, HttpOnly session, CSRF and logout revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-login-")),
    cfg = await localConfig(root),
    app = await createHttpServer(cfg);
  try {
    const base = { host: new URL(cfg.url).host, origin: cfg.url };
    const issued = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...base, authorization: `Bearer ${cfg.token}` },
    });
    expect(issued.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers["set-cookie"])).toContain("HttpOnly");
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const repeated = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    expect(repeated.statusCode).toBe(401);
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...base, cookie },
      payload: { name: "API testi" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    const headers = { ...base, cookie, "x-forge-csrf": login.json().csrf };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "API testi" },
    });
    expect(project.statusCode).toBe(200);
    const list = await app.inject({ url: "/api/projects", headers });
    expect(list.json().items[0].name).toBe("API testi");
    expect(
      (await app.inject({ method: "POST", url: "/api/logout", headers }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/me", headers })).statusCode).toBe(
      401,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("scoped encrypted secrets and redacted metadata never expose another owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-secrets-"));
  try {
    const vault = await SecretVault.open(root);
    const [a, b] = await Promise.all([
      vault.put("tenant-a", "alice", "alice-private-key"),
      vault.put("tenant-b", "bob", "bob-private-key"),
    ]);
    expect(await vault.get("tenant-a", "alice", a)).toBe("alice-private-key");
    expect(await vault.get("tenant-b", "bob", b)).toBe("bob-private-key");
    await expect(vault.get("tenant-b", "bob", a)).rejects.toMatchObject({
      code: "secret_unavailable",
    });
    for (const file of await readdir(join(root, "secrets")))
      if (file.endsWith(".json"))
        expect(
          await readFile(join(root, "secrets", file), "utf8"),
        ).not.toContain("private-key");
    expect(
      redact({
        authorization: "Bearer secret",
        nested: { api_key: "private", count: 1 },
      }),
    ).toEqual({
      authorization: "[redacted]",
      nested: { api_key: "[redacted]", count: 1 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
