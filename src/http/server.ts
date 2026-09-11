import { DeletionService } from "../application/deletion.js";
import { decodeQueryToolInput } from "./query-decode.js";
import { Throttle } from "./throttle.js";
import { registerMigrationHttp } from "../migration/http.js";
import { MemberService } from "../application/members.js";
import { OrganizationService } from "../application/organization.js";
import { RoleService } from "../application/roles.js";
import { AgentPromptService } from "../application/agent-prompts.js";
import {
  EnvironmentService,
  visibleScopes,
} from "../application/environments.js";
import { BindingService } from "../application/bindings.js";
import { TelemetryService } from "../application/telemetry.js";
import { MaintenanceService } from "../application/maintenance.js";
import { JobQueue, terminalStates } from "../jobs/queue.js";
import { redact as redactMetadata } from "../telemetry/redact.js";
import { PackageManager } from "../application/packages.js";
import { PackageStore } from "../skills/store.js";
import { DockerExecutor } from "../execution/docker.js";
import { basename } from "node:path";
import { ForgeService } from "../application/forge.js";
import { ForgeWorker } from "../jobs/worker.js";
import { BudgetService } from "../jobs/budgets.js";
import { productionHandler } from "../runner/handler.js";
import { MemoryService } from "../memory/service.js";
import { jobScopeForSpace } from "../memory/service.js";
import { MemoryCommitService } from "../memory/commit.js";
import { MemorySourceService } from "../memory/sources.js";
import { MEMORY_SCAN_DEFAULT_LIMIT } from "../memory/sources.js";
import { memoryJobHandlers } from "../memory/worker.js";
import { productionJobKinds } from "../memory/job-kinds.js";
import { MEMORY_INGEST_CONTENT_MAX } from "../memory/job-kinds.js";
import { sha256Hex } from "../memory/files.js";
import { vaultRoot } from "../memory/paths.js";
import { MEMORY_KINDS } from "../domain/memory.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import { SecretVault } from "../storage/secrets.js";
import { ProviderService } from "../application/providers.js";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z, ZodError } from "zod";
import { createMcpServer } from "../mcp/server.js";
import {
  PRODUCT_VERSION,
  PROTOCOL_VERSION,
  type LocalConfig,
} from "../cli/config.js";
import { ForgeError, errorEnvelope } from "../domain/errors.js";
import { openDatabase } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { SettingsService } from "../application/settings.js";
import { OidcIdentity } from "./oidc.js";
import { GithubIdentity } from "./github.js";
const identities = new WeakMap<FastifyRequest, Identity>();
export function requestIdentity(request: FastifyRequest) {
  const identity = identities.get(request);
  if (!identity)
    throw new ForgeError("unauthorized", "Kimlik doğrulaması gerekiyor.", 401);
  return identity;
}
export function tokenMatches(
  value: string | undefined,
  expected: string,
): boolean {
  const a = Buffer.from(value ?? ""),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function createHttpServer(config: LocalConfig) {
  const storage = await openDatabase({
    dataDir: config.dataDir,
    postgresUrl: config.postgresUrl,
  });
  const identityService = new IdentityService(storage.db);
  const publicThrottle = new Throttle(30, 60000);
  const settings = new SettingsService(identityService, config.policy);
  const vault = await SecretVault.open(config.dataDir);
  const providers = new ProviderService(identityService, vault);
  const forge = new ForgeService(
    storage,
    config.dataDir,
    config.token,
    config.policy,
  );
  const memoryRoot = vaultRoot(config.dataDir);
  const memory = new MemoryService(storage.db, identityService, memoryRoot);
  const memoryCommits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: memoryRoot,
    service: memory,
  });
  const memorySources = new MemorySourceService({
    db: storage.db,
    vaultRoot: memoryRoot,
    service: memory,
  });
  const memoryAudit = async (
    identity: Identity,
    kind: string,
    detail: Record<string, unknown>,
    projectId: string | null = null,
  ) => {
    await storage.db
      .insertInto("audit_events")
      .values({
        tenant_id: identity.tenantId,
        id: randomUUID(),
        user_id: identity.userId,
        project_id: projectId,
        kind,
        detail: JSON.stringify(detail),
        created_at: Date.now(),
      })
      .execute();
  };
  const memoryQueue = new JobQueue(storage, config.policy, productionJobKinds);
  const worker = new ForgeWorker(
    memoryQueue,
    productionHandler(
      storage,
      config.dataDir,
      vault,
      config.profile !== "server",
    ),
    {
      postgresUrl: config.postgresUrl,
      handlers: memoryJobHandlers(memory, memoryCommits),
    },
  );
  const localOwner =
    config.profile !== "server" ? await identityService.bootstrapLocal() : null;
  const oidc = config.oidc
    ? await OidcIdentity.create(config.oidc, identityService)
    : null;
  const github = config.github
    ? new GithubIdentity(config.github, identityService)
    : null;
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30_000,
  });
  app.decorate("forge", { storage, identityService, settings });
  await app.register(cookie, { secret: config.token });
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure: config.profile === "server",
    sameSite: "strict" as const,
    maxAge: 12 * 60 * 60,
  };
  const packageIntegrity = {
    status: localOwner ? "checking" : "not_scanned",
    checked: 0,
    issues: 0,
  };
  let startupWork: Promise<void> | undefined;
  let closingStartup = false;
  let startupReady = false;
  app.addHook("onReady", async () => {
    startupWork = (async () => {
      if (localOwner) {
        try {
          const store = new PackageStore(storage, config.dataDir);
          let after: { skill_id: string; revision: string } | undefined;
          do {
            if (closingStartup) {
              packageIntegrity.status = "interrupted";
              return;
            }
            const page = await store.reconcile(localOwner, after);
            packageIntegrity.checked += page.checked;
            packageIntegrity.issues += page.issues.length;
            after = page.next ?? undefined;
          } while (after);
          packageIntegrity.status = packageIntegrity.issues
            ? "degraded"
            : "verified";
        } catch {
          packageIntegrity.status = "failed";
        }
      }
      if (!closingStartup) {
        await worker.start();
        startupReady = true;
      }
    })().catch(() => {
      packageIntegrity.status = "failed";
    });
  });
  app.addHook("onClose", async () => {
    closingStartup = true;
    await startupWork;
    await worker.stop();
    await storage.close();
  });
  app.setErrorHandler((error, request, reply) => {
    const known =
      error instanceof ZodError
        ? new ForgeError("invalid_input", "Girdi şemayla uyuşmuyor.", 400)
        : !(error instanceof ForgeError) &&
            typeof (error as { statusCode?: number }).statusCode === "number" &&
            (error as { statusCode: number }).statusCode < 500
          ? new ForgeError(
              "invalid_request",
              "İstek biçimi geçersiz.",
              (error as { statusCode: number }).statusCode,
            )
          : error;
    if (
      known instanceof ForgeError &&
      known.status === 401 &&
      config.profile === "server"
    )
      reply.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.url}/.well-known/oauth-protected-resource", scope="forge"`,
      );
    reply
      .code(known instanceof ForgeError ? known.status : 500)
      .send({ ...errorEnvelope(known), correlation_id: request.id });
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers.host !== new URL(config.url).host)
      throw new ForgeError("invalid_host", "Host doğrulanamadı.", 403);
    if (request.headers.origin && request.headers.origin !== config.url)
      throw new ForgeError("invalid_origin", "Origin reddedildi.", 403);
    const path = request.url.split("?")[0]!;
    const publicRoute =
      [
        "/",
        "/auth/pair",
        "/health/live",
        "/health/ready",
        "/auth/start",
        "/auth/callback",
        "/auth/github/start",
        "/auth/github/callback",
        "/api/invitations/accept",
        "/.well-known/oauth-protected-resource",
      ].includes(path) || path.startsWith("/assets/");
    if (publicRoute) return;
    let identity: Identity;
    if (
      localOwner &&
      tokenMatches(request.headers.authorization, `Bearer ${config.token}`)
    )
      identity = localOwner;
    else {
      const tenant =
        typeof request.headers["x-forge-tenant"] === "string"
          ? request.headers["x-forge-tenant"]
          : (request.cookies.forge_tenant ?? "local");
      const sessionToken = request.cookies.forge_session;
      if (sessionToken) {
        let sessionOnly = false;
        try {
          identity = await identityService.authenticate(sessionToken, tenant);
        } catch (error) {
          // Issue #5: a valid session whose selected tenant lost access must
          // keep a recovery path instead of a blanket 403.
          if (!(error instanceof ForgeError) || error.status !== 403)
            throw error;
          sessionOnly = true;
          identity = await identityService.sessionIdentity(sessionToken);
        }
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          !tokenMatches(
            request.headers["x-forge-csrf"] as string | undefined,
            createHash("sha256").update(sessionToken).digest("hex"),
          )
        )
          throw new ForgeError(
            "csrf_required",
            "İşlem doğrulama anahtarı eksik.",
            403,
          );
        if (
          sessionOnly &&
          ![
            "/api/my-memberships",
            "/api/tenants/switch",
            "/api/logout",
          ].includes(path)
        )
          throw new ForgeError(
            "tenant_unavailable",
            "Seçili organizasyona erişiminiz yok; aktif üyeliğinizi seçin.",
            403,
          );
      } else if (oidc && request.headers.authorization?.startsWith("Bearer ")) {
        identity = {
          userId: await oidc.bearer(request.headers.authorization.slice(7)),
          tenantId: tenant,
        };
        await identityService.authorize(identity, "read");
      } else
        throw new ForgeError(
          "unauthorized",
          "Kimlik doğrulaması gerekiyor.",
          401,
        );
    }
    identities.set(request, identity);
  });
  app.post(
    "/api/service/stop",
    {
      onResponse: async (request, reply) => {
        if (
          reply.statusCode === 202 &&
          request.headers.authorization === `Bearer ${config.token}`
        )
          setImmediate(() => {
            void app.close().catch(() => {
              process.exitCode = 1;
            });
          });
      },
    },
    async (request, reply) => {
      if (
        !localOwner ||
        !tokenMatches(request.headers.authorization, `Bearer ${config.token}`)
      )
        throw new ForgeError(
          "stop_denied",
          "Servis yalnız yerel owner CLI kimliğiyle durdurulabilir.",
          403,
        );
      return reply.code(202).send({
        service: "skill-forge",
        protocol: PROTOCOL_VERSION,
        version: PRODUCT_VERSION,
        pid: process.pid,
        status: "stopping",
      });
    },
  );
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    if (
      !startupReady ||
      closingStartup ||
      ["failed", "degraded"].includes(packageIntegrity.status)
    )
      return reply.code(503).send({ status: "not_ready" });
    try {
      await storage.now();
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
    return { status: "ready" };
  });
  app.get("/health", async () => ({
    status:
      packageIntegrity.status === "checking"
        ? "checking"
        : ["degraded", "failed"].includes(packageIntegrity.status)
          ? "degraded"
          : "healthy",
    package_integrity: packageIntegrity,
    service: "skill-forge",
    version: PRODUCT_VERSION,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
  }));
  app.get("/ready", async () => {
    await storage.now();
    return {
      status: "ready",
      version: PRODUCT_VERSION,
      protocol: PROTOCOL_VERSION,
      backend: storage.backend,
    };
  });
  app.post("/auth/pair", async (request, reply) => {
    publicThrottle.check(request, "auth-pair");
    if (!localOwner)
      throw new ForgeError(
        "pairing_disabled",
        "Sunucu profilinde OIDC girişini kullanın.",
        403,
      );
    const { code } = z
      .object({ code: z.string().min(20).max(200) })
      .strict()
      .parse(request.body);
    const token = await identityService.redeemPairing(code);
    reply.setCookie("forge_session", token, cookieOptions);
    return {
      authenticated: true,
      csrf: createHash("sha256").update(token).digest("hex"),
    };
  });
  app.post("/api/pairing", async (request) => {
    const identity = requestIdentity(request);
    await identityService.authorize(identity, "admin");
    return {
      code: await identityService.issueSession(
        identity.userId,
        "pairing",
        300_000,
      ),
      expires_in: 300,
    };
  });
  app.get("/auth/start", async (request, reply) => {
    publicThrottle.check(request, "oidc-start");
    if (!oidc)
      throw new ForgeError(
        "oidc_unconfigured",
        "Yerel eşleme koduyla giriş yapın.",
        422,
      );
    const pending = await oidc.begin();
    reply.setCookie("forge_oidc", JSON.stringify(pending), {
      ...cookieOptions,
      signed: true,
      sameSite: "lax",
      maxAge: 300,
    });
    return reply.redirect(pending.url);
  });
  app.get("/auth/callback", async (request, reply) => {
    publicThrottle.check(request, "oidc-callback");
    if (!oidc)
      throw new ForgeError("oidc_unconfigured", "OIDC yapılandırılmamış.", 422);
    const value = request.unsignCookie(request.cookies.forge_oidc ?? "");
    reply.clearCookie("forge_oidc", { path: "/" });
    if (!value.valid || !value.value)
      throw new ForgeError(
        "invalid_login_state",
        "Giriş durumu geçersiz.",
        401,
      );
    const userId = await oidc.callback(
      new URL(request.url, config.url),
      JSON.parse(value.value),
    );
    const membership = await identityService.firstActiveTenant(userId);
    // Known subject without an active membership still gets a session: the
    // web UI shows the recovery/membership screen instead of a JSON error.
    const token = await identityService.issueSession(
      userId,
      "session",
      12 * 60 * 60 * 1000,
    );
    reply.setCookie("forge_session", token, cookieOptions);
    if (membership)
      reply.setCookie("forge_tenant", membership.tenant_id, cookieOptions);
    return reply.redirect("/");
  });
  app.get("/auth/github/start", async (request, reply) => {
    publicThrottle.check(request, "github-start");
    if (!github)
      throw new ForgeError(
        "github_unconfigured",
        "GitHub girişi yapılandırılmamış.",
        422,
      );
    const pending = github.begin();
    reply.setCookie("forge_github", JSON.stringify(pending), {
      ...cookieOptions,
      signed: true,
      sameSite: "lax",
      maxAge: 300,
    });
    return reply.redirect(pending.url);
  });
  app.get("/auth/github/callback", async (request, reply) => {
    publicThrottle.check(request, "github-callback");
    if (!github)
      throw new ForgeError(
        "github_unconfigured",
        "GitHub girişi yapılandırılmamış.",
        422,
      );
    const value = request.unsignCookie(request.cookies.forge_github ?? "");
    reply.clearCookie("forge_github", { path: "/" });
    if (!value.valid || !value.value)
      throw new ForgeError(
        "invalid_login_state",
        "Giriş durumu geçersiz.",
        401,
      );
    const query = request.query as { code?: string; state?: string };
    const userId = await github.callback(
      query.code ?? "",
      query.state ?? "",
      JSON.parse(value.value),
    );
    const membership = await identityService.firstActiveTenant(userId);
    // Same recovery contract as the OIDC callback above.
    const token = await identityService.issueSession(
      userId,
      "session",
      12 * 60 * 60 * 1000,
    );
    reply.setCookie("forge_session", token, cookieOptions);
    if (membership)
      reply.setCookie("forge_tenant", membership.tenant_id, cookieOptions);
    return reply.redirect("/");
  });
  app.get("/.well-known/oauth-protected-resource", async () => {
    if (!oidc)
      throw new ForgeError(
        "oauth_unconfigured",
        "Yerel profil bearer kimliği kullanır.",
        404,
      );
    return {
      resource: config.url,
      authorization_servers: [oidc.options.issuer],
      scopes_supported: ["forge"],
      bearer_methods_supported: ["header"],
    };
  });
  app.get("/api/me", async (request) => ({
    identity: requestIdentity(request),
    role: await identityService.authorize(requestIdentity(request), "read"),
    projects: await identityService.listProjects(requestIdentity(request)),
    csrf: request.cookies.forge_session
      ? createHash("sha256").update(request.cookies.forge_session).digest("hex")
      : null,
  }));
  app.post("/api/logout", async (request, reply) => {
    if (request.cookies.forge_session)
      await identityService.revoke(request.cookies.forge_session);
    reply.clearCookie("forge_session", { path: "/" });
    return { logged_out: true };
  });
  app.get("/api/providers", async (request) => ({
    items: await providers.list(requestIdentity(request)),
  }));
  app.put("/api/providers", async (request) =>
    providers.update(requestIdentity(request), request.body),
  );
  app.get("/api/projects", async (request) => {
    const query = z
      .object({ after: z.string().max(200).optional() })
      .parse(request.query);
    const page = await identityService.listProjectsPage(
      requestIdentity(request),
      query.after,
    );
    if (query.after !== undefined && !page.items.length && page.next === null) {
      // Continuation cursors must resolve; a stale key is a client error.
      const probe = await identityService.listProjectsPage(
        requestIdentity(request),
        undefined,
      );
      if (!probe.items.some((row) => row.id === query.after))
        throw new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.", 400);
    }
    return page;
  });
  app.post("/api/projects", async (request) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        environment_id: z.string().min(1).max(100).optional(),
      })
      .parse(request.body);
    return identityService.createProject(
      requestIdentity(request),
      body.name,
      body.environment_id,
    );
  });
  app.get("/api/settings", async (request) => {
    const query = z
      .object({ scope: z.string().default("workspace") })
      .parse(request.query);
    return settings.get(requestIdentity(request), query.scope);
  });
  app.put("/api/settings", async (request) => {
    const body = z
      .object({
        scope: z.string(),
        base_revision: z.number().int().min(0),
        values: z.unknown(),
      })
      .strict()
      .parse(request.body);
    return settings.update(
      requestIdentity(request),
      body.scope,
      body.base_revision,
      body.values,
    );
  });
  app.get("/api/settings/effective", async (request) => {
    const query = z
      .object({ project_ref: z.string().optional() })
      .parse(request.query);
    return settings.effective(requestIdentity(request), query.project_ref);
  });
  app.post("/api/projects/:id/bindings", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return bindings.bind(requestIdentity(request), {
      ...(request.body as Record<string, unknown>),
      project_id: id,
    });
  });
  app.post("/api/bindings/verify", async (request) =>
    bindings.verify(requestIdentity(request), request.body),
  );
  app.get("/api/bindings", async (request) =>
    bindings.list(requestIdentity(request)),
  );
  app.get("/api/environments", async (request) =>
    environments.list(requestIdentity(request)),
  );
  app.post("/api/environments", async (request) =>
    environments.create(requestIdentity(request), request.body as never),
  );
  app.delete("/api/environments/:id", async (request) =>
    environments.remove(
      requestIdentity(request),
      (request.params as { id: string }).id,
    ),
  );
  const members = new MemberService(storage.db);
  const organizations = new OrganizationService(storage.db);
  const roles = new RoleService(storage.db);
  const environments = new EnvironmentService(storage.db);
  const bindings = new BindingService(storage.db);
  const agentPrompts = new AgentPromptService(storage.db);
  app.get("/api/members", async (request) => {
    const q = z
      .object({
        project_ref: z.string(),
        after: z.string().max(100).optional(),
      })
      .parse(request.query);
    return members.list(requestIdentity(request), q.project_ref, q.after);
  });
  app.post("/api/members", async (request) =>
    members.create(requestIdentity(request), request.body),
  );
  app.put("/api/members/:id", async (request) =>
    members.update(
      requestIdentity(request),
      (request.params as { id: string }).id,
      request.body,
    ),
  );
  app.get("/api/tenants", async (request) =>
    organizations.listTenants(requestIdentity(request).userId),
  );
  // Issue #5: session-only membership recovery list (own data, no tenant ACL).
  app.get("/api/my-memberships", async (request) => ({
    items: await organizations.listTenants(requestIdentity(request).userId),
    csrf: request.cookies.forge_session
      ? createHash("sha256").update(request.cookies.forge_session).digest("hex")
      : null,
  }));
  app.post("/api/tenants/switch", async (request, reply) => {
    const body = z.object({ tenant_id: z.string().min(1) }).parse(request.body);
    const identity = requestIdentity(request);
    const mine = await organizations.listTenants(identity.userId);
    if (!mine.some((m) => m.tenant_id === body.tenant_id && !m.disabled))
      throw new ForgeError(
        "tenant_unavailable",
        "Organizasyon bulunamadı.",
        404,
      );
    reply.setCookie("forge_tenant", body.tenant_id, cookieOptions);
    return { tenant_id: body.tenant_id };
  });
  app.post("/api/organizations", async (request) => {
    const body = z
      .object({ name: z.string().min(1).max(200) })
      .parse(request.body);
    return organizations.createOrganization(
      requestIdentity(request).userId,
      body.name,
    );
  });
  app.post("/api/invitations", async (request) =>
    organizations.createInvite(requestIdentity(request), request.body as never),
  );
  app.get("/api/invitations", async (request) =>
    organizations.listInvites(requestIdentity(request)),
  );
  app.post("/api/invitations/:id/revoke", async (request) =>
    organizations.revokeInvite(
      requestIdentity(request),
      (request.params as { id: string }).id,
    ),
  );
  app.post("/api/invitations/accept", async (request) => {
    publicThrottle.check(request, "invite-accept");
    return organizations.acceptInvite(request.body as never);
  });
  app.post("/api/organization/transfer", async (request) => {
    const body = z
      .object({ to_user_id: z.string().min(1) })
      .parse(request.body);
    return organizations.offerTransfer(
      requestIdentity(request),
      body.to_user_id,
    );
  });
  app.post("/api/organization/transfer/:id/accept", async (request) =>
    organizations.acceptTransfer(
      requestIdentity(request),
      (request.params as { id: string }).id,
    ),
  );
  app.post("/api/organization/deletion/request", async (request) => {
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    return organizations.requestDeletion(requestIdentity(request), body.name);
  });
  app.post("/api/organization/deletion/confirm", async (request) => {
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    return organizations.confirmDeletion(requestIdentity(request), body.name);
  });
  app.post("/api/organization/deletion/cancel", async (request) =>
    organizations.cancelDeletion(requestIdentity(request)),
  );
  app.get("/api/organization/transfer/offers", async (request) =>
    organizations.listOffers(requestIdentity(request)),
  );
  app.get("/api/organization/deletion/status", async (request) =>
    organizations.deletionStatus(requestIdentity(request)),
  );
  app.get("/api/roles", async (request) =>
    roles.list(requestIdentity(request)),
  );
  app.post("/api/roles", async (request) =>
    roles.create(requestIdentity(request), request.body as never),
  );
  app.delete("/api/roles/:name", async (request) =>
    roles.remove(
      requestIdentity(request),
      (request.params as { name: string }).name,
    ),
  );
  app.post("/api/roles/:name/restore", async (request) =>
    roles.restore(
      requestIdentity(request),
      (request.params as { name: string }).name,
    ),
  );
  app.get("/api/agent-prompts", async (request) => {
    const q = z
      .object({
        scope: z.string().min(1).max(200),
        profile: z.string().max(64).optional(),
      })
      .parse(request.query);
    const actor = requestIdentity(request);
    return {
      active: await agentPrompts.active(actor, q.scope, q.profile),
      history: await agentPrompts.history(actor, q.scope, q.profile),
    };
  });
  app.put("/api/agent-prompts", async (request) =>
    agentPrompts.update(requestIdentity(request), request.body as never),
  );
  app.post("/api/agent-prompts/rollback", async (request) =>
    agentPrompts.rollback(requestIdentity(request), request.body as never),
  );
  app.get("/api/packages/integrity", async (request) => {
    const query = z
      .object({
        after_skill: z.string().optional(),
        after_revision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(request.query);
    if (Boolean(query.after_skill) !== Boolean(query.after_revision))
      throw new ForgeError(
        "invalid_cursor",
        "İki cursor alanı birlikte gerekiyor.",
        400,
      );
    // Issue #28: salt bütünlük raporu; dosya silmez, okuyucu pin'i süpürmez.
    return new PackageStore(storage, config.dataDir).reconcile(
      requestIdentity(request),
      query.after_skill
        ? { skill_id: query.after_skill, revision: query.after_revision! }
        : undefined,
      { reclaim: false },
    );
  });
  app.post("/api/packages/integrity", async (request) => {
    const body = z
      .object({
        recover_ownerless_before: z.number().int().positive().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    // Issue #27/#28: mutasyon ayrı yöntemde, admin ACL ve denetim kaydıyla.
    return new PackageStore(storage, config.dataDir).reclaim(
      requestIdentity(request),
      {
        recoverOwnerlessBefore: body.recover_ownerless_before,
        audit: true,
      },
    );
  });
  const packageManager = (actor: Identity, projectId?: string) => {
    return new PackageManager(
      new PackageStore(storage, config.dataDir, async (path, manifest) => {
        const effective = await settings.effective(actor, projectId);
        return new DockerExecutor(config.dataDir, {
          trustScope: `${actor.tenantId}:${actor.userId}`,
          allowDependencyInstall: effective.values.dependencyInstall,
          allowedOrigins: effective.values.scriptAllowedOrigins,
        }).validate(path, manifest);
      }),
    );
  };
  registerMigrationHttp(
    app,
    storage,
    requestIdentity,
    (actor, project) => packageManager(actor, project || undefined).store,
  );
  const telemetry = new TelemetryService(storage, config.policy);
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let retentionWork: Promise<void> | undefined;
  const retain = () => {
    if (!retentionWork)
      retentionWork = telemetry
        .sweep()
        .catch(() => {
          process.stderr.write("Saklama taraması yeniden denenecek\n");
        })
        .finally(() => {
          retentionWork = undefined;
        });
  };
  app.addHook("onReady", async () => {
    retain();
    retentionTimer = setInterval(retain, 60000);
    retentionTimer.unref();
  });
  app.addHook("preClose", async () => {
    if (retentionTimer) clearInterval(retentionTimer);
    await retentionWork;
  });
  app.get("/api/reports/support", async (request) =>
    telemetry.support(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).parse(request.query).project_ref,
    ),
  );
  app.post("/api/telemetry/retain", async (request) =>
    telemetry.retain(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).strict().parse(request.body)
        .project_ref,
    ),
  );
  const maintenance = new MaintenanceService(storage, config.dataDir);
  const deletions = new DeletionService(storage, config.dataDir);
  app.get("/api/maintenance/deletions", async (request) => {
    const q = z
      .object({
        project_ref: z.string(),
        after: z.string().max(100).optional(),
      })
      .strict()
      .parse(request.query);
    return deletions.pending(requestIdentity(request), q.project_ref, q.after);
  });
  app.post("/api/maintenance/deletions/resume", async (request) => {
    const q = z
      .object({ project_ref: z.string(), skill_id: z.string().max(100) })
      .strict()
      .parse(request.body);
    return deletions.resume(
      requestIdentity(request),
      q.project_ref,
      q.skill_id,
    );
  });
  app.get("/api/maintenance", async (request) => {
    const q = z
      .object({
        project_ref: z.string(),
        days: z.coerce.number().int().min(1).max(365).optional(),
        after: z.string().max(100).optional(),
        state: z.enum(["active", "archived", "all"]).optional(),
      })
      .parse(request.query);
    return maintenance.report(requestIdentity(request), q.project_ref, q);
  });
  app.post("/api/maintenance/preview", async (request) =>
    maintenance.preview(requestIdentity(request), request.body),
  );
  app.post("/api/maintenance/apply", async (request) =>
    maintenance.apply(requestIdentity(request), request.body),
  );
  app.get("/api/overview", async (request) => {
    const actor = requestIdentity(request),
      { project_ref } = z
        .object({ project_ref: z.string() })
        .parse(request.query);
    await identityService.authorize(actor, "read", project_ref);
    const scope = await visibleScopes(storage.db, actor, project_ref);
    const [
      active,
      packages,
      profiles,
      usage,
      jobs,
      account,
      effective,
      events,
    ] = await Promise.all([
      storage.db
        .selectFrom("runs")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("project_id", "=", project_ref)
        .where("state", "not in", terminalStates)
        .executeTakeFirstOrThrow(),
      storage.db
        .selectFrom("skills")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("scope_key", "in", scope)
        .where("archived", "=", 0)
        .executeTakeFirstOrThrow(),
      providers.list(actor),
      storage.db
        .selectFrom("budget_reservations as b")
        .innerJoin("runs as r", (j) =>
          j
            .onRef("r.tenant_id", "=", "b.tenant_id")
            .onRef("r.id", "=", "b.run_id"),
        )
        .select(["b.actual_micros", "b.state"])
        .where("b.tenant_id", "=", actor.tenantId)
        .where("b.user_id", "=", actor.userId)
        .where("r.project_id", "=", project_ref)
        .limit(10000)
        .execute(),
      forge.invoke("forge_report", actor, { project_ref, limit: 5 }),
      new BudgetService(storage).accountSummary(actor),
      settings.effective(actor, project_ref),
      storage.db
        .selectFrom("audit_events")
        .select(["id", "kind", "created_at", "detail"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where((eb) =>
          eb.or([
            eb("project_id", "=", project_ref),
            eb("project_id", "is", null),
          ]),
        )
        .orderBy("created_at", "desc")
        .limit(5)
        .execute(),
    ]);
    return {
      // Issue #25: the ledger is user-scoped accounting, split by meaning.
      // `job_limit_micros` is the currently effective per-job policy for
      // this project; no account/period quota is derived from it.
      account_budget: {
        job_limit_micros: effective.values.maxCostMicros,
        reserved_micros: account.reserved_micros,
        uncertain_micros: account.uncertain_micros,
        spent_micros: account.spent_micros,
        uncertain_reservations: account.uncertain_reservations,
      },
      active_jobs: Number(active.n),
      skill_packages: Number(packages.n),
      model_status: profiles.some((p) => p.profile)
        ? "configured"
        : "unconfigured",
      observed_cost_micros:
        usage.length && usage.every((u) => u.state === "settled")
          ? usage.reduce((sum, u) => sum + (u.actual_micros ?? 0), 0)
          : null,
      usage_complete:
        usage.length < 10000 && usage.every((u) => u.state === "settled"),
      jobs: jobs.items,
      events: events.map((event) => ({
        ...event,
        detail: redactMetadata(JSON.parse(event.detail)),
      })),
    };
  });
  // Issue #25: authorized manual recovery for a held reservation whose
  // provider outcome is unknown. The explicit actual amount is recorded as
  // settled spending; holds are never zeroed silently.
  app.post("/api/budget/reservations/:id/reconcile", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const body = z
      .object({ actual_micros: z.number().int().min(0) })
      .strict()
      .parse(request.body);
    const actor = requestIdentity(request);
    const budget = new BudgetService(storage);
    const resolved = await budget.resolveReservation(
      actor,
      id,
      body.actual_micros,
    );
    const summary = await budget.accountSummary(actor);
    return {
      ...resolved,
      reserved_micros: summary.reserved_micros,
      uncertain_micros: summary.uncertain_micros,
      spent_micros: summary.spent_micros,
    };
  });
  app.get("/api/logs", async (request) => {
    const actor = requestIdentity(request),
      query = z
        .object({
          project_ref: z.string(),
          kind: z.string().max(100).optional(),
          after: z.string().max(200).optional(),
        })
        .parse(request.query);
    await identityService.authorize(actor, "read", query.project_ref);
    let selected = storage.db
      .selectFrom("audit_events")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where((eb) =>
        eb.or([
          eb("project_id", "=", query.project_ref),
          eb("project_id", "is", null),
        ]),
      );
    if (query.kind) selected = selected.where("kind", "=", query.kind);
    // Issue #15: bounded pages with a (created_at,id) keyset so equal
    // timestamps never skip or repeat rows.
    let next = null;
    if (query.after) {
      const sep = query.after.indexOf(":");
      const at = Number(query.after.slice(0, sep));
      const id = query.after.slice(sep + 1);
      if (sep <= 0 || !id || !Number.isSafeInteger(at))
        throw new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.", 400);
      selected = selected.where((eb) =>
        eb.or([
          eb("created_at", "<", at),
          eb.and([eb("created_at", "=", at), eb("id", "<", id)]),
        ]),
      );
    }
    const rows = await selected
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(101)
      .execute();
    const page = rows.length > 100 ? rows.slice(0, 100) : rows;
    if (rows.length > 100) {
      const anchor = page[99]!;
      next = `${anchor.created_at}:${anchor.id}`;
    }
    return {
      items: page.map((row) => ({
        ...row,
        detail: redactMetadata(JSON.parse(row.detail)),
      })),
      next,
    };
  });
  app.get("/api/installations", async (request) => {
    const actor = requestIdentity(request),
      query = z
        .object({
          project_ref: z.string(),
          after: z.string().max(200).optional(),
        })
        .parse(request.query);
    await identityService.authorize(actor, "read", query.project_ref);
    let selected = storage.db
      .selectFrom("client_installations")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", query.project_ref);
    if (query.after !== undefined) {
      // Issue #29: installation ids are SHA-256 fingerprints; the cursor must
      // be validated and applied with the same key the page is ordered by.
      if (!/^[a-f0-9]{64}$/.test(query.after))
        throw new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.", 400);
      selected = selected.where("id", ">", query.after);
    }
    const rows = await selected.orderBy("id").limit(101).execute();
    const items = rows.length > 100 ? rows.slice(0, 100) : rows;
    return {
      next: rows.length > 100 ? items[99]!.id : null,
      items: items.map((row) => ({
        ...row,
        capabilities: JSON.parse(row.capabilities_json),
        capabilities_json: undefined,
        health:
          row.last_seen === null
            ? "unknown"
            : Date.now() - row.last_seen > 300000
              ? "stale"
              : "connected",
        acceptance: "not_certified_by_heartbeat",
      })),
    };
  });
  app.post("/api/installations", async (request) => {
    const actor = requestIdentity(request),
      body = z
        .object({
          id: z.string().regex(/^[a-f0-9]{64}$/),
          project_ref: z.string(),
          client: z.enum(["codex", "claude", "chatgpt"]),
          version: z.string().max(100).nullable().default(null),
          directory: z.string().max(2000),
          event: z
            .enum(["installed", "UserPromptSubmit", "Stop", "mcp_connected"])
            .default("installed"),
        })
        .strict()
        .parse(request.body);
    await identityService.authorize(actor, "run", body.project_ref);
    const existing = await storage.db
      .selectFrom("client_installations")
      .select(["user_id", "project_id"])
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", body.id)
      .executeTakeFirst();
    if (
      existing &&
      (existing.user_id !== actor.userId ||
        existing.project_id !== body.project_ref)
    )
      throw new ForgeError(
        "installation_unavailable",
        "Kurulum başka kapsama ait.",
        403,
      );
    const values = {
      tenant_id: actor.tenantId,
      id: body.id,
      user_id: actor.userId,
      project_id: body.project_ref,
      client: body.client,
      version: body.version,
      directory: body.directory,
      capabilities_json: JSON.stringify({
        mcp: true,
        handoff:
          body.client === "chatgpt"
            ? "best_effort_tool"
            : "final_tool_and_stop_fallback",
      }),
      last_seen: body.event === "installed" ? null : Date.now(),
      last_event: body.event,
      created_at: Date.now(),
    };
    const recorded = await storage.db
      .insertInto("client_installations")
      .values(values)
      .onConflict((oc) =>
        oc
          .columns(["tenant_id", "id"])
          .doUpdateSet({
            last_seen: values.last_seen,
            last_event: values.last_event,
          })
          .where("client_installations.user_id", "=", actor.userId)
          .where("client_installations.project_id", "=", body.project_ref),
      )
      .returning("id")
      .executeTakeFirst();
    if (!recorded)
      throw new ForgeError(
        "installation_unavailable",
        "Kurulum başka kapsama ait.",
        403,
      );
    return { id: body.id, status: "recorded" };
  });
  app.get("/api/skills", async (request) =>
    forge.invoke(
      "forge_search",
      requestIdentity(request),
      decodeQueryToolInput(request.query),
    ),
  );
  app.get("/api/skills/:id/revisions", async (request) => {
    const actor = requestIdentity(request),
      id = (request.params as { id: string }).id;
    await forge.packages.authorizedSkill(actor, id);
    const query = z
      .object({ after: z.string().max(200).optional() })
      .parse(request.query);
    let selected = storage.db
      .selectFrom("skill_revisions")
      .select([
        "revision",
        "created_at",
        "created_by",
        "run_id",
        "manifest_json",
        "validation_json",
      ])
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", id);
    if (query.after) {
      const sep = query.after.indexOf(":");
      const at = Number(query.after.slice(0, sep));
      const rev = query.after.slice(sep + 1);
      if (sep <= 0 || !rev || !Number.isSafeInteger(at))
        throw new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.", 400);
      selected = selected.where((eb) =>
        eb.or([
          eb("created_at", "<", at),
          eb.and([eb("created_at", "=", at), eb("revision", "<", rev)]),
        ]),
      );
    }
    const rows = await selected
      .orderBy("created_at", "desc")
      .orderBy("revision", "desc")
      .limit(51)
      .execute();
    const items = rows.length > 50 ? rows.slice(0, 50) : rows;
    return {
      next:
        rows.length > 50
          ? `${rows[49]!.created_at}:${rows[49]!.revision}`
          : null,
      items: items.map((row) => ({
        ...row,
        file_count: JSON.parse(row.manifest_json).files.length,
        validation_passed: JSON.parse(row.validation_json).passed === true,
        manifest_json: undefined,
        validation_json: undefined,
      })),
    };
  });
  app.get("/api/skills/:id/manifest", async (request) => {
    const actor = requestIdentity(request),
      id = (request.params as { id: string }).id;
    await forge.packages.authorizedSkill(actor, id);
    const query = z
      .object({
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        after: z.coerce.number().int().min(0).max(256).default(0),
      })
      .parse(request.query);
    const row = await storage.db
      .selectFrom("skill_revisions")
      .select(["manifest_json", "validation_json"])
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", id)
      .where("revision", "=", query.revision)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError("revision_unavailable", "Sürüm bulunamadı.", 404);
    const manifest = JSON.parse(row.manifest_json);
    return {
      revision: query.revision,
      files: manifest.files.slice(query.after, query.after + 40),
      file_count: manifest.files.length,
      next: query.after + 40 < manifest.files.length ? query.after + 40 : null,
      execution: manifest.execution,
      validation: redactMetadata(JSON.parse(row.validation_json)),
    };
  });
  app.post(
    "/api/skills/:id/edit",
    { bodyLimit: 4 * 1024 * 1024 },
    async (request) => {
      const actor = requestIdentity(request),
        id = (request.params as { id: string }).id;
      const skill = await forge.packages.authorizedSkill(actor, id, true);
      return packageManager(actor, skill.project_id ?? undefined).edit(
        actor,
        id,
        request.body,
      );
    },
  );
  app.put("/api/skills/:id", async (request) =>
    packageManager(requestIdentity(request)).configure(
      requestIdentity(request),
      (request.params as { id: string }).id,
      request.body,
    ),
  );
  app.put("/api/skills/:id/scope", async (request) => {
    const body = z
      .object({
        scope: z.enum(["personal", "project", "workspace", "environment"]),
        project_ref: z.string().min(1).max(100).optional(),
        expected_revision: z.string().nullable(),
      })
      .strict()
      .parse(request.body);
    return forge.packages.setScope(
      requestIdentity(request),
      (request.params as { id: string }).id,
      {
        scope: body.scope,
        projectId: body.project_ref,
        expectedRevision: body.expected_revision,
      },
    );
  });
  app.post(
    "/api/skills/import",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body = z
        .object({
          archive: z.string().max(7 * 1024 * 1024),
          scope: z.enum(["personal", "project", "workspace", "environment"]),
          project_ref: z.string(),
          base_revision: z.string().nullable().default(null),
        })
        .strict()
        .parse(request.body);
      return packageManager(requestIdentity(request), body.project_ref).import(
        requestIdentity(request),
        Buffer.from(body.archive, "base64"),
        body.scope,
        body.project_ref,
        body.base_revision,
      );
    },
  );
  app.get("/api/skills/:id/export", async (request, reply) => {
    const value = await packageManager(requestIdentity(request)).export(
      requestIdentity(request),
      (request.params as { id: string }).id,
      z.object({ revision: z.string() }).parse(request.query).revision,
    );
    return reply
      .type("application/zip")
      .header("content-disposition", `attachment; filename="${value.name}"`)
      .send(value.bytes);
  });
  app.post("/api/skills/:id/rollback", async (request) => {
    const body = z
      .object({ target_revision: z.string(), base_revision: z.string() })
      .strict()
      .parse(request.body);
    const skill = await forge.packages.authorizedSkill(
      requestIdentity(request),
      (request.params as { id: string }).id,
      true,
    );
    return packageManager(
      requestIdentity(request),
      skill.project_id ?? undefined,
    ).rollback(
      requestIdentity(request),
      (request.params as { id: string }).id,
      body.target_revision,
      body.base_revision,
    );
  });
  app.get("/api/runs", async (request) =>
    // Issue #32: the HTTP adapter calls the shared run-report use-case
    // directly; the MCP `forge_report` dispatcher reaches the same function.
    forge.reports.report(
      requestIdentity(request),
      toolSchemas.forge_report.parse(decodeQueryToolInput(request.query)),
    ),
  );
  app.get("/api/runs/:id/attempts", async (request) => {
    const query = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(request.query);
    return forge.queue.attempts(
      requestIdentity(request),
      (request.params as { id: string }).id,
      query.after,
    );
  });
  app.post("/api/runs/:id/cancel", async (request) =>
    forge.queue.cancel(
      requestIdentity(request),
      (request.params as { id: string }).id,
    ),
  );
  app.get("/api/artifacts/:id", async (request, reply) => {
    const artifact = await forge.artifact(
      requestIdentity(request),
      (request.params as { id: string }).id,
      z.object({ reference: z.string().max(3000) }).parse(request.query)
        .reference,
    );
    return reply
      .type("application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(basename(artifact.path))}`,
      )
      .send(artifact.bytes);
  });
  app.post("/api/tools/:name", async (request) => {
    const name = (request.params as { name: string }).name;
    if (!Object.hasOwn(toolSchemas, name))
      throw new ForgeError("tool_unavailable", "Araç bulunamadı.", 404);
    return forge.invoke(
      name as ToolName,
      requestIdentity(request),
      request.body,
    );
  });
  // --- Hafıza (issue #35): GET salt-okunur; mutasyonlar açık POST + ACL +
  // audit. ACK yalnız kalıcı kabulden sonra döner; receipt ayrı okunur.
  app.get("/api/memory/spaces", async (request) => {
    const query = z
      .object({
        after: z.string().max(200).optional(),
        limit: z.string().regex(/^\d+$/).optional(),
      })
      .strict()
      .parse(request.query);
    return memory.listSpaces(requestIdentity(request), {
      after: query.after,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });
  app.get("/api/memory/notes", async (request) => {
    const query = z
      .object({
        space_id: z.string().min(1).max(200),
        after: z.string().max(200).optional(),
        limit: z.string().regex(/^\d+$/).optional(),
      })
      .strict()
      .parse(request.query);
    return memory.listNotes(requestIdentity(request), {
      spaceId: query.space_id,
      after: query.after,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });
  app.get("/api/memory/notes/:id", async (request) => {
    const query = z
      .object({ space_id: z.string().min(1).max(200) })
      .strict()
      .parse(request.query);
    return memory.readNote(requestIdentity(request), {
      spaceId: query.space_id,
      noteId: (request.params as { id: string }).id,
    });
  });
  app.get("/api/memory/events", async (request) => {
    const query = z
      .object({
        space_id: z.string().min(1).max(200),
        source_event_key: z.string().min(1).max(200),
      })
      .strict()
      .parse(request.query);
    return memoryCommits.receipt(
      requestIdentity(request),
      query.space_id,
      query.source_event_key,
    );
  });
  app.post("/api/memory/ingest", async (request) => {
    const identity = requestIdentity(request);
    const body = z
      .object({
        space_id: z.string().min(1).max(200),
        source_event_key: z.string().min(1).max(200),
        source_kind: z.string().min(1).max(40),
        content: z.string().min(1).max(MEMORY_INGEST_CONTENT_MAX),
        note_id: z.string().min(1).max(200).optional(),
        base_revision: z.number().int().min(0).optional(),
        kind: z.enum(MEMORY_KINDS).optional(),
      })
      .strict()
      .parse(request.body);
    // Mutasyon sınırında somut alan ACL'i; accept ayrıca tenant/kapsam
    // `run` iznini doğrular.
    const space = await memory.authorizeSpace(identity, body.space_id, "write");
    const contentHash = sha256Hex(body.content);
    const accepted = await memoryQueue.accept(identity, {
      scope: jobScopeForSpace(space),
      kind: "memory_ingest",
      // Kapsam/olay çifti kararlı ve sınırlı tek bir anahtara indirilir.
      key: sha256Hex(`${body.space_id}\u0000${body.source_event_key}`),
      payload: {
        spaceId: body.space_id,
        sourceEventKey: body.source_event_key,
        sourceKind: body.source_kind,
        contentHash,
        content: body.content,
        ...(body.note_id ? { noteId: body.note_id } : {}),
        ...(body.base_revision !== undefined
          ? { baseRevision: body.base_revision }
          : {}),
        ...(body.kind ? { kind: body.kind } : {}),
      },
    });
    await memoryAudit(
      identity,
      "memory.ingest.accepted",
      {
        space_id: body.space_id,
        run_id: accepted.run.id,
        source_event_key: body.source_event_key,
        duplicate: accepted.status === "duplicate",
      },
      space.kind === "project" ? space.project_id : null,
    );
    return {
      status: accepted.status,
      run_id: accepted.run.id,
      run_state: accepted.run.state,
    };
  });
  app.get("/api/memory/sources", async (request) => {
    const query = z
      .object({ space_id: z.string().min(1).max(200).optional() })
      .strict()
      .parse(request.query);
    return {
      items: await memorySources.listSources(requestIdentity(request), {
        spaceId: query.space_id,
      }),
    };
  });
  app.post("/api/memory/sources", async (request) => {
    const identity = requestIdentity(request);
    const body = z
      .object({
        space_id: z.string().min(1).max(200),
        root_path: z.string().min(1).max(4000),
        mode: z.enum(["read_only", "managed"]),
      })
      .strict()
      .parse(request.body);
    const source = await memorySources.registerSource(identity, {
      spaceId: body.space_id,
      rootPath: body.root_path,
      mode: body.mode,
    });
    await memoryAudit(identity, "memory.source.registered", {
      space_id: body.space_id,
      source_id: source.id,
      root_path: source.root_path,
      mode: source.mode,
    });
    return source;
  });
  app.post("/api/memory/sources/:id/scan", async (request) => {
    const identity = requestIdentity(request);
    const body = z
      .object({ limit: z.number().int().min(1).max(1000).optional() })
      .strict()
      .parse(request.body ?? {});
    const report = await memorySources.scan(identity, {
      sourceId: (request.params as { id: string }).id,
      limit: body.limit ?? MEMORY_SCAN_DEFAULT_LIMIT,
    });
    await memoryAudit(identity, "memory.source.scanned", {
      space_id: report.space_id,
      source_id: (request.params as { id: string }).id,
      scanned: report.scanned,
      read: report.read,
      candidates: report.candidates,
      conflicts: report.conflicts,
      done: report.done,
    });
    return report;
  });
  app.get("/api/memory/conflicts", async (request) => {
    const query = z
      .object({
        space_id: z.string().min(1).max(200).optional(),
        source_id: z.string().min(1).max(200).optional(),
        state: z
          .enum(["candidate", "conflict", "applied", "rejected", "quarantined"])
          .optional(),
        after: z.string().max(200).optional(),
        limit: z.string().regex(/^\d+$/).optional(),
      })
      .strict()
      .parse(request.query);
    return memorySources.listCandidates(requestIdentity(request), {
      spaceId: query.space_id,
      sourceId: query.source_id,
      state: query.state,
      after: query.after,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });
  app.post("/api/memory/notes/:id/archive", async (request) => {
    const identity = requestIdentity(request);
    const body = z
      .object({ space_id: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    const result = await memory.archiveNote(identity, {
      spaceId: body.space_id,
      noteId: (request.params as { id: string }).id,
    });
    await memoryAudit(identity, "memory.note.archived", {
      space_id: body.space_id,
      note_id: result.noteId,
    });
    return result;
  });
  app.post("/api/memory/notes/:id/restore", async (request) => {
    const identity = requestIdentity(request);
    const body = z
      .object({ space_id: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    const result = await memory.restoreNote(identity, {
      spaceId: body.space_id,
      noteId: (request.params as { id: string }).id,
    });
    await memoryAudit(identity, "memory.note.restored", {
      space_id: body.space_id,
      note_id: result.noteId,
    });
    return result;
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      requestIdentity(request);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = await createMcpServer(
        forge,
        requestIdentity(request),
        config.profile === "server",
      );
      await mcp.connect(transport);
      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } finally {
        await mcp.close();
      }
    },
  });
  const bundledWeb = fileURLToPath(new URL("./web/", import.meta.url));
  const webRoot = existsSync(bundledWeb) ? bundledWeb : resolve("dist/web");
  if (existsSync(webRoot))
    await app.register(staticFiles, {
      root: webRoot,
      prefix: "/",
      index: ["index.html"],
    });
  return app;
}
export async function serve(config: LocalConfig) {
  const app = await createHttpServer(config);
  await app.listen({ host: config.host, port: config.port });
  return app;
}
