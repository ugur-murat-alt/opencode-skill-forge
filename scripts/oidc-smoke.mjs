import { zipSync } from "fflate";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import https from "node:https";
import { Client } from "pg";
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "forge-real-oidc-"));
const suffix = randomUUID().replaceAll("-", "");
const database = `forge_oidc_${suffix}`,
  kc = `forge-kc-${suffix}`,
  proxy = `forge-tls-${suffix}`;
const reportPath = process.argv[2] ?? "docs/evidence/p03-live-oidc.json";
const report = {
  status: "running",
  provider: "Keycloak 26.7.3",
  proxy: "Caddy 2.11.4",
  profile: "server",
  tls_verification: true,
};
let child,
  admin,
  dbCreated = false;
const run = async (file, args, options = {}) =>
  (
    await execute(file, args, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      ...options,
    })
  ).stdout.trim();
const ports = new Set();
async function port() {
  for (;;) {
    const s = createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    if (!ports.has(p)) {
      ports.add(p);
      return p;
    }
  }
}
try {
  if (!process.env.FORGE_TEST_POSTGRES_URL)
    throw Error("FORGE_TEST_POSTGRES_URL is required");
  const kcPort = await port(),
    issuerPort = await port(),
    appPort = await port(),
    publicPort = await port();
  const issuer = `https://127.0.0.1:${issuerPort}/realms/forge`,
    publicUrl = `https://127.0.0.1:${publicPort}`;
  const userId = randomUUID(),
    password = randomBytes(24).toString("hex"),
    secret = randomBytes(24).toString("hex");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    join(root, "server.key"),
    "-out",
    join(root, "server.crt"),
  ]);
  await writeFile(
    join(root, "forge-realm.json"),
    JSON.stringify({
      realm: "forge",
      enabled: true,
      sslRequired: "all",
      users: [
        {
          id: userId,
          username: "fixture",
          enabled: true,
          email: "fixture@example.test",
          emailVerified: true,
          firstName: "Fixture",
          lastName: "User",
          credentials: [
            { type: "password", value: password, temporary: false },
          ],
        },
      ],
      clients: [
        {
          clientId: "forge",
          protocol: "openid-connect",
          publicClient: false,
          secret,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          redirectUris: [publicUrl + "/auth/callback"],
          webOrigins: [publicUrl],
          attributes: { "pkce.code.challenge.method": "S256" },
          defaultClientScopes: ["profile", "basic"],
          optionalClientScopes: ["forge"],
        },
      ],
      clientScopes: [
        { name: "profile", protocol: "openid-connect" },
        {
          name: "basic",
          protocol: "openid-connect",
          protocolMappers: [
            {
              name: "subject",
              protocol: "openid-connect",
              protocolMapper: "oidc-sub-mapper",
              config: {
                "access.token.claim": "true",
                "introspection.token.claim": "true",
              },
            },
          ],
        },
        {
          name: "forge",
          protocol: "openid-connect",
          attributes: { "include.in.token.scope": "true" },
          protocolMappers: [
            {
              name: "forge-audience",
              protocol: "openid-connect",
              protocolMapper: "oidc-audience-mapper",
              config: {
                "included.custom.audience": publicUrl,
                "access.token.claim": "true",
                "id.token.claim": "false",
              },
            },
          ],
        },
      ],
    }),
    // The parent is private (0700); Keycloak must read its bind mount as UID 1000.
    { mode: 0o644 },
  );
  await writeFile(
    join(root, "Caddyfile"),
    `{\n auto_https off\n admin off\n}\nhttps://127.0.0.1:${issuerPort} {\n bind 127.0.0.1\n tls /fixture/server.crt /fixture/server.key\n reverse_proxy 127.0.0.1:${kcPort}\n}\nhttps://127.0.0.1:${publicPort} {\n bind 127.0.0.1\n tls /fixture/server.crt /fixture/server.key\n reverse_proxy 127.0.0.1:${appPort}\n}\n`,
  );
  await run("docker", [
    "run",
    "-d",
    "--name",
    kc,
    "-p",
    `127.0.0.1:${kcPort}:8080`,
    "--mount",
    `type=bind,source=${join(root, "forge-realm.json")},target=/opt/keycloak/data/import/forge-realm.json,readonly`,
    "quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54",
    "start-dev",
    "--import-realm",
    "--hostname",
    `https://127.0.0.1:${issuerPort}`,
    "--proxy-headers",
    "xforwarded",
  ]);
  await run("docker", [
    "run",
    "-d",
    "--name",
    proxy,
    "--network",
    "host",
    "--mount",
    `type=bind,source=${root},target=/fixture,readonly`,
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
    "caddy",
    "run",
    "--config",
    "/fixture/Caddyfile",
  ]);
  const ca = await readFile(join(root, "server.crt"));
  const jar = new Map();
  const request = (address, { method = "GET", body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(address),
        cookies = jar.get(url.origin) ?? new Map();
      const q = https.request(
        url,
        {
          method,
          ca,
          headers: {
            ...headers,
            ...(cookies.size
              ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
              : {}),
          },
        },
        (r) => {
          for (const c of r.headers["set-cookie"] ?? []) {
            const pair = c.split(";")[0],
              at = pair.indexOf("=");
            cookies.set(pair.slice(0, at), pair.slice(at + 1));
          }
          jar.set(url.origin, cookies);
          let text = "";
          r.on("data", (b) => {
            text += b;
            if (text.length > 2 * 1024 * 1024)
              r.destroy(Error("response limit"));
          });
          r.on("error", reject);
          r.on("end", () =>
            resolve({ status: r.statusCode, headers: r.headers, text }),
          );
        },
      );
      q.setTimeout(10000, () => q.destroy(Error("request timeout")));
      q.on("error", reject);
      if (body) q.write(body);
      q.end();
    });
  const wait = async (url) => {
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      try {
        const r = await request(url);
        if (r.status === 200) return r;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw Error("Readiness timeout");
  };
  const discovery = JSON.parse(
    (await wait(issuer + "/.well-known/openid-configuration")).text,
  );
  if (discovery.issuer !== issuer) throw Error("Issuer mismatch");
  admin = new Client({ connectionString: process.env.FORGE_TEST_POSTGRES_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  dbCreated = true;
  const dbUrl = new URL(process.env.FORGE_TEST_POSTGRES_URL);
  dbUrl.pathname = "/" + database;
  const env = {
    PATH: process.env.PATH,
    SKILL_FORGE_PROFILE: "server",
    SKILL_FORGE_DATA_DIR: join(root, "data"),
    SKILL_FORGE_PORT: String(appPort),
    SKILL_FORGE_POSTGRES_URL: dbUrl.href,
    SKILL_FORGE_PUBLIC_URL: publicUrl,
    SKILL_FORGE_OIDC_ISSUER: issuer,
    SKILL_FORGE_OIDC_CLIENT_ID: "forge",
    SKILL_FORGE_OIDC_CLIENT_SECRET: secret,
    NODE_EXTRA_CA_CERTS: join(root, "server.crt"),
  };
  await run(
    "node",
    [
      resolve("dist/cli.js"),
      "bootstrap-server",
      "--tenant-id",
      "acceptance",
      "--tenant-name",
      "OIDC acceptance",
      "--subject",
      issuer + "|" + userId,
      "--display-name",
      "Fixture",
    ],
    { env },
  );
  await writeFile(
    join(root, "serve.mjs"),
    `import {localConfig,createHttpServer} from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)}; const app=await createHttpServer({...await localConfig(),host:'127.0.0.1'});app.addHook('onError',async (_q,_r,e)=>process.stderr.write(JSON.stringify({name:e.name,code:e.code,message:e.message,cause:e.cause?.message})+'\\n'));await app.listen({host:'127.0.0.1',port:Number(process.env.SKILL_FORGE_PORT)});process.once('SIGTERM',()=>{void app.close();});`,
  );
  child = spawn("node", [join(root, "serve.mjs")], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    if (diagnostics.length < 4000) diagnostics += chunk;
  });
  await wait(publicUrl + "/health/ready");
  if ((await request(publicUrl + "/health")).status !== 401)
    throw Error("Anonymous private health accepted");
  async function authorize(url) {
    let response = await request(url);
    for (let i = 0; i < 8; i++) {
      if (response.headers.location) {
        const next = new URL(response.headers.location, url).href;
        if (next.startsWith(publicUrl + "/auth/callback")) return next;
        url = next;
        response = await request(url);
        continue;
      }
      const action = response.text
        .match(/<form[^>]*action="([^"]+)"/i)?.[1]
        ?.replaceAll("&amp;", "&");
      if (!action) throw Error("Keycloak login form missing");
      response = await request(action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: "fixture",
          password,
          credentialId: "",
        }).toString(),
      });
      url = action;
    }
    throw Error("Login redirect limit");
  }
  const start = await request(publicUrl + "/auth/start");
  if (start.status !== 302) throw Error("Forge login did not redirect");
  const callback = await authorize(start.headers.location);
  const providerError = new URL(callback).searchParams.get("error");
  if (providerError)
    throw Error("Keycloak authorization error: " + providerError);
  const completed = await request(callback);
  if (completed.status !== 302)
    throw Error(
      "Forge callback failed with " + completed.status + " " + diagnostics,
    );
  const session = await request(publicUrl + "/api/me");
  if (session.status !== 200)
    throw Error("Authenticated session unavailable: " + session.status);
  const principal = JSON.parse(session.text);
  if (principal.identity.tenantId !== "acceptance" || !principal.csrf)
    throw Error("Session identity mismatch");
  if (
    (
      await request(publicUrl + "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "OIDC project" }),
      })
    ).status !== 403
  )
    throw Error("Cookie write accepted without CSRF");
  const projectResponse = await request(publicUrl + "/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forge-csrf": principal.csrf,
    },
    body: JSON.stringify({ name: "OIDC project" }),
  });
  if (projectResponse.status !== 200)
    throw Error("Authenticated project write failed");
  const projectId = JSON.parse(projectResponse.text).id;
  report.csrf_and_project_write = "passed";
  report.authorization_code_pkce = "passed";
  const sessionCookie = completed.headers["set-cookie"]?.find((c) =>
    c.startsWith("forge_session="),
  );
  if (
    !sessionCookie ||
    !/; Secure/i.test(sessionCookie) ||
    !/; HttpOnly/i.test(sessionCookie)
  )
    throw Error("Session cookie flags missing");
  report.secure_session = "passed";
  const deniedStart = await request(publicUrl + "/auth/start");
  const deniedState = new URL(deniedStart.headers.location).searchParams.get(
    "state",
  );
  const deniedCallback =
    publicUrl +
    "/auth/callback?" +
    new URLSearchParams({ error: "access_denied", state: deniedState });
  if ((await request(deniedCallback)).status !== 401)
    throw Error("OIDC denial did not return 401");
  report.authorization_denial = "401";
  // A second authorization grant exercises a real provider-signed access token.
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(16).toString("hex");
  const authUrl = new URL(discovery.authorization_endpoint);
  Object.entries({
    client_id: "forge",
    response_type: "code",
    redirect_uri: publicUrl + "/auth/callback",
    scope: "openid profile forge",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const tokenCallback = new URL(await authorize(authUrl.href));
  if (tokenCallback.searchParams.get("state") !== state)
    throw Error("Token state mismatch");
  const tokenResponse = await request(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " + Buffer.from("forge:" + secret).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: tokenCallback.searchParams.get("code"),
      redirect_uri: publicUrl + "/auth/callback",
      code_verifier: verifier,
    }).toString(),
  });
  if (tokenResponse.status !== 200) throw Error("Token grant failed");
  const access = JSON.parse(tokenResponse.text).access_token;
  report.access_claim_names = Object.keys(
    JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()),
  ).sort();
  jar.delete(publicUrl);
  const bearer = await request(publicUrl + "/health", {
    headers: {
      authorization: "Bearer " + access,
      "x-forge-tenant": "acceptance",
    },
  });
  if (bearer.status !== 200)
    throw Error("Bearer rejected: " + bearer.status + " " + diagnostics);
  const parts = access.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  if (
    (
      await request(publicUrl + "/health", {
        headers: {
          authorization: "Bearer " + parts.join("."),
          "x-forge-tenant": "acceptance",
        },
      })
    ).status !== 401
  )
    throw Error("Invalid signature did not return 401");
  if (
    (
      await request(publicUrl + "/api/me", {
        headers: {
          authorization: "Bearer " + access,
          "x-forge-tenant": "unrelated",
        },
      })
    ).status !== 403
  )
    throw Error("Foreign tenant accepted");
  report.invalid_signature_and_foreign_tenant = "rejected";
  const content =
    "---\nname: oidc-transport-helper\ndescription: Verify authenticated transport with an immutable reference.\n---\nUse the verified reference in this package.\n";
  const archive = Buffer.from(
    zipSync({ "oidc-transport-helper/SKILL.md": Buffer.from(content) }),
  ).toString("base64");
  const imported = await request(publicUrl + "/api/skills/import", {
    method: "POST",
    headers: {
      authorization: "Bearer " + access,
      "x-forge-tenant": "acceptance",
      "content-type": "application/json",
    },
    body: JSON.stringify({ archive, scope: "project", project_ref: projectId }),
  });
  if (imported.status !== 200)
    throw Error("Bearer package import failed: " + imported.status);
  const published = JSON.parse(imported.text);
  const mcpProbe = `import {Client,StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/client"))};
const client=new Client({name:'real-oidc-acceptance',version:'1'});
const headers={authorization:'Bearer '+process.env.FORGE_ACCEPTANCE_TOKEN,'x-forge-tenant':'acceptance'};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(${JSON.stringify(publicUrl + "/mcp")}),{requestInit:{headers}}));
  const tools=(await client.listTools()).tools.map(t=>t.name).sort();
  const expected=['forge_search','forge_load','forge_run','forge_handoff','forge_report'].sort();
  if(JSON.stringify(tools)!==JSON.stringify(expected))throw Error('five-tool contract mismatch');
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error('MCP call failed: '+name);return JSON.parse(r.content.find(c=>c.type==='text').text);};
  const found=await call('forge_search',{project_ref:${JSON.stringify(projectId)},query:'authenticated transport'});
  if(!found.items.some(x=>x.skill_id===${JSON.stringify(published.skill_id)}))throw Error('Imported package missing');
  const loaded=await call('forge_load',{project_ref:${JSON.stringify(projectId)},skill_id:${JSON.stringify(published.skill_id)},revision:${JSON.stringify(published.revision)}});
  if(!JSON.stringify(loaded).includes('Use the verified reference'))throw Error('Revision content missing');
  const denied=await client.callTool({name:'forge_search',arguments:{project_ref:${JSON.stringify(randomUUID())},query:'transport'}});
  if(!denied.isError)throw Error('Unregistered project accepted');
  console.log(JSON.stringify({tools,search_load:true,foreign_project_rejected:true}));
} finally {await client.close();}`;
  await writeFile(join(root, "mcp-probe.mjs"), mcpProbe, { mode: 0o600 });
  report.mcp = JSON.parse(
    await run("node", [join(root, "mcp-probe.mjs")], {
      env: {
        PATH: process.env.PATH,
        NODE_EXTRA_CA_CERTS: join(root, "server.crt"),
        FORGE_ACCEPTANCE_TOKEN: access,
      },
    }),
  );
  report.bearer_jwks_audience_scope = "passed";
  report.tenant = "acceptance";
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message).slice(0, 500);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  const cleanupErrors = [];
  for (const name of [proxy, kc]) {
    try {
      await run("docker", ["rm", "-f", name]);
    } catch {
      cleanupErrors.push("container cleanup failed");
    }
  }
  if (admin) {
    if (dbCreated) {
      try {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      } catch {
        cleanupErrors.push("database cleanup failed");
      }
    }
    await admin.end();
  }
  if (cleanupErrors.length) {
    report.cleanup_errors = cleanupErrors;
    report.status = "failed";
    process.exitCode = 1;
  }
  await rm(root, { recursive: true, force: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ status: report.status, report: reportPath }));
