import { registerMigrationHttp } from "../migration/http.js";
import {
  SessionPreferences,
  sessionSourceSchema,
  sessionValuesSchema,
} from "../application/session-preferences.js";
import { RewriteMigration } from "../migration/rewrites.js";
import { MemberService } from "../application/members.js";
import { TelemetryService } from "../application/telemetry.js";
import { MaintenanceService } from "../application/maintenance.js";
import { terminalStates } from "../jobs/queue.js";
import { redact as redactMetadata } from "../telemetry/redact.js";
import { PackageManager } from "../application/packages.js";
import { PackageStore } from "../skills/store.js";
import { DockerExecutor } from "../execution/docker.js";
import { LearningStore } from "../prompt/learning.js";
import { basename } from "node:path";
import { ForgeService } from "../application/forge.js";
import { ForgeWorker } from "../jobs/worker.js";
import { productionHandler } from "../runner/handler.js";
import { toolSchemas, type ToolName } from "../mcp/schemas.js";
import { SecretVault } from "../storage/secrets.js";
import { ProviderService } from "../application/providers.js";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { timingSafeEqual, createHash } from "node:crypto";
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
  const settings = new SettingsService(identityService, config.policy);
  const vault = await SecretVault.open(config.dataDir);
  const providers = new ProviderService(identityService, vault);
  const forge = new ForgeService(
    storage,
    config.dataDir,
    config.token,
    config.policy,
  );
  const worker = new ForgeWorker(
    forge.queue,
    productionHandler(
      storage,
      config.dataDir,
      vault,
      config.profile !== "server",
    ),
    { postgresUrl: config.postgresUrl },
  );
  const localOwner =
    config.profile !== "server" ? await identityService.bootstrapLocal() : null;
  const oidc = config.oidc
    ? await OidcIdentity.create(config.oidc, identityService)
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
      if (!closingStartup) await worker.start();
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
        "/auth/start",
        "/auth/callback",
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
        identity = await identityService.authenticate(sessionToken, tenant);
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
  app.get("/auth/start", async (_request, reply) => {
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
    const membership = await storage.db
      .selectFrom("memberships")
      .select("tenant_id")
      .where("user_id", "=", userId)
      .orderBy("tenant_id")
      .executeTakeFirst();
    if (!membership)
      throw new ForgeError(
        "membership_required",
        "Çalışma alanı üyeliği gerekiyor.",
        403,
      );
    const token = await identityService.issueSession(
      userId,
      "session",
      12 * 60 * 60 * 1000,
    );
    reply
      .setCookie("forge_session", token, cookieOptions)
      .setCookie("forge_tenant", membership.tenant_id, cookieOptions);
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
  app.get("/api/projects", async (request) => ({
    items: await identityService.listProjects(requestIdentity(request)),
  }));
  app.post("/api/projects", async (request) =>
    identityService.createProject(
      requestIdentity(request),
      z.object({ name: z.string() }).strict().parse(request.body).name,
    ),
  );
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
    const body = z
      .object({
        client_id: z.string().min(1).max(200),
        path: z.string().min(1).max(4096),
      })
      .strict()
      .parse(request.body);
    const identity = requestIdentity(request);
    await identityService.authorize(identity, "write", id);
    await storage.db
      .insertInto("project_bindings")
      .values({
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        project_id: id,
        client_id: body.client_id,
        path: body.path,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "user_id", "client_id", "path"]).doNothing(),
      )
      .execute();
    const bound = await storage.db
      .selectFrom("project_bindings")
      .select("project_id")
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("client_id", "=", body.client_id)
      .where("path", "=", body.path)
      .executeTakeFirstOrThrow();
    if (bound.project_id !== id)
      throw new ForgeError(
        "binding_conflict",
        "Bu istemci yolu başka projeye bağlı.",
        409,
      );
    return { bound: true };
  });
  const members = new MemberService(storage.db);
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
    return new PackageStore(storage, config.dataDir).reconcile(
      requestIdentity(request),
      query.after_skill
        ? { skill_id: query.after_skill, revision: query.after_revision! }
        : undefined,
    );
  });
  const learning = new LearningStore(storage);
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
  const maintenance = new MaintenanceService(storage);
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
    const scope = [
      "workspace",
      `personal:${actor.userId}`,
      `project:${project_ref}`,
    ];
    const [active, packages, profiles, usage, jobs, events] = await Promise.all(
      [
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
      ],
    );
    return {
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
  app.get("/api/logs", async (request) => {
    const actor = requestIdentity(request),
      query = z
        .object({
          project_ref: z.string(),
          kind: z.string().max(100).optional(),
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
    return {
      items: (
        await selected.orderBy("created_at", "desc").limit(100).execute()
      ).map((row) => ({
        ...row,
        detail: redactMetadata(JSON.parse(row.detail)),
      })),
    };
  });
  app.get("/api/installations", async (request) => {
    const actor = requestIdentity(request),
      query = z.object({ project_ref: z.string() }).parse(request.query);
    await identityService.authorize(actor, "read", query.project_ref);
    const items = await storage.db
      .selectFrom("client_installations")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", query.project_ref)
      .limit(100)
      .execute();
    return {
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
        prepare_mode:
          body.client === "chatgpt"
            ? "best_effort_tool"
            : "additional_context_hook",
        handoff:
          body.client === "chatgpt"
            ? "best_effort_tool"
            : "final_tool_and_stop_fallback",
        visible_prompt_replacement: false,
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
    forge.invoke("forge_search", requestIdentity(request), request.query),
  );
  app.get("/api/skills/:id/revisions", async (request) => {
    const actor = requestIdentity(request),
      id = (request.params as { id: string }).id;
    await forge.packages.authorizedSkill(actor, id);
    const items = await storage.db
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
      .where("skill_id", "=", id)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    return {
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
  app.post(
    "/api/skills/import",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body = z
        .object({
          archive: z.string().max(7 * 1024 * 1024),
          scope: z.enum(["personal", "project", "workspace"]),
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
    forge.invoke("forge_report", requestIdentity(request), request.query),
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
  app.get("/api/settings/session", async (request) => {
    const q = z
      .object({
        project_ref: z.string(),
        client: z.string(),
        session: z.string(),
      })
      .strict()
      .parse(request.query);
    return new SessionPreferences(new IdentityService(storage.db)).get(
      requestIdentity(request),
      q.project_ref,
      { client: q.client, session: q.session },
    );
  });
  app.put("/api/settings/session", async (request) => {
    const body = z
      .object({
        project_ref: z.string(),
        source: sessionSourceSchema,
        base_revision: z.number().int().nonnegative(),
        values: sessionValuesSchema,
      })
      .strict()
      .parse(request.body);
    return new SessionPreferences(new IdentityService(storage.db)).update(
      requestIdentity(request),
      body.project_ref,
      body.source,
      body.base_revision,
      body.values,
    );
  });
  app.get("/api/prompts/imported-rewrites", async (request) => {
    const query = z
      .object({ project_ref: z.string(), after: z.string().optional() })
      .parse(request.query);
    return new RewriteMigration(storage).list(
      requestIdentity(request),
      query.project_ref,
      query.after,
    );
  });
  app.get("/api/prompts/imported-rewrites/:id", async (request) =>
    new RewriteMigration(storage).detail(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).parse(request.query).project_ref,
      (request.params as { id: string }).id,
    ),
  );
  app.get("/api/prompts/learning", async (request) => ({
    items: await learning.list(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).parse(request.query).project_ref,
    ),
  }));
  app.post("/api/prompts/learning", async (request) => {
    const body = z
      .object({
        project_ref: z.string(),
        content: z.string(),
        triggers: z.string(),
        personal: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return learning.save(requestIdentity(request), body.project_ref, body);
  });
  app.get("/api/prompts/learning/:id/history", async (request) => ({
    items: await learning.history(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).parse(request.query).project_ref,
      (request.params as { id: string }).id,
    ),
  }));
  app.patch("/api/prompts/learning/:id", async (request) => {
    const { project_ref, ...input } = z
      .object({
        project_ref: z.string(),
        base_revision: z.number().int().positive(),
        content: z.string(),
        triggers: z.string(),
        disabled: z.boolean(),
      })
      .strict()
      .parse(request.body);
    return learning.update(
      requestIdentity(request),
      project_ref,
      (request.params as { id: string }).id,
      input,
    );
  });
  app.delete("/api/prompts/learning/:id", async (request) =>
    learning.remove(
      requestIdentity(request),
      z.object({ project_ref: z.string() }).parse(request.query).project_ref,
      (request.params as { id: string }).id,
    ),
  );
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
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      requestIdentity(request);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = createMcpServer(
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
