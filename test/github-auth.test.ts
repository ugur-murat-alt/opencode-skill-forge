import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { GithubIdentity } from "../src/http/github.js";

async function fixture(
  handler: (url: string, body: string) => { status: number; json: unknown },
) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const out = handler(req.url ?? "", body);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    authBase: `http://127.0.0.1:${port}`,
    apiBase: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("GitHub login resolves provisioned subjects and rejects strangers", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-github-"));
  const storage = await openDatabase({ dataDir: root });
  const fx = await fixture(() => ({ status: 200, json: {} }));
  try {
    const identities = new IdentityService(storage.db);
    const github = new GithubIdentity(
      {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        publicUrl: "https://forge.invalid",
        authBase: fx.authBase,
        apiBase: fx.apiBase,
      },
      identities,
    );
    const begun = github.begin();
    expect(begun.url).toContain("login/oauth/authorize");
    await expect(
      github.callback("code", "wrong-state", {
        state: begun.state,
        expires: Date.now() + 60000,
      }),
    ).rejects.toMatchObject({ code: "invalid_login_state" });
    await expect(
      github.callback("code", begun.state, {
        state: begun.state,
        expires: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ code: "login_expired" });
  } finally {
    await fx.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub callback exchanges code and gates on provisioned membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-github-callback-"));
  const storage = await openDatabase({ dataDir: root });
  const fx = await fixture((url) =>
    url.includes("access_token")
      ? { status: 200, json: { access_token: "fixture-token" } }
      : { status: 200, json: { id: 424242 } },
  );
  try {
    const identities = new IdentityService(storage.db);
    const github = new GithubIdentity(
      {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        publicUrl: "https://forge.invalid",
        authBase: fx.authBase,
        apiBase: fx.apiBase,
      },
      identities,
    );
    const begun = github.begin();
    await expect(
      github.callback("auth-code", begun.state, {
        state: begun.state,
        expires: Date.now() + 60000,
      }),
    ).rejects.toMatchObject({ code: "membership_required" });
    await storage.db
      .insertInto("users")
      .values({
        id: randomUUID(),
        subject: "github|424242",
        display_name: "Octocat",
        created_at: Date.now(),
      })
      .execute();
    const userId = await github.callback("auth-code", begun.state, {
      state: begun.state,
      expires: Date.now() + 60000,
    });
    expect(typeof userId).toBe("string");
  } finally {
    await fx.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
