import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { exportPackage } from "../src/skills/archive.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`server migration HTTP ${backend}: authenticated bytes, CSRF, forged identity and package receipt`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-transfer-")),
      cfg = await localConfig(root);
    cfg.profile = "server";
    if (backend === "postgres")
      cfg.postgresUrl = process.env.FORGE_TEST_POSTGRES_URL;
    const storage = await openDatabase({
        dataDir: root,
        postgresUrl: cfg.postgresUrl,
      }),
      ids = new IdentityService(storage.db),
      owner = await ids.bootstrapLocal(),
      project = await ids.createProject(owner, "Server transfer"),
      token = await ids.issueSession(owner.userId, "session", 60000),
      otherId = randomUUID();
    await storage.db
      .insertInto("users")
      .values({
        id: otherId,
        subject: `fixture|${otherId}`,
        display_name: "Other migration owner",
        created_at: Date.now(),
      })
      .execute();
    await storage.db
      .insertInto("memberships")
      .values({ tenant_id: owner.tenantId, user_id: otherId, role: "founder" })
      .execute();
    const otherToken = await ids.issueSession(otherId, "session", 60000);
    await storage.close();
    const app = await createHttpServer(cfg),
      base = { host: new URL(cfg.url).host },
      headers = {
        ...base,
        cookie: `forge_session=${token}; forge_tenant=${owner.tenantId}`,
        "x-forge-csrf": hash(token),
      },
      other = {
        ...base,
        cookie: `forge_session=${otherToken}; forge_tenant=${owner.tenantId}`,
        "x-forge-csrf": hash(otherToken),
      };
    try {
      const name = `transfer-${randomUUID()}`,
        files = {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Preserve portable migration bytes.\n---\nApply the verified method.\n`,
          ),
        },
        fileChecksum = hash(
          JSON.stringify([
            {
              path: "SKILL.md",
              bytes: files["SKILL.md"].length,
              sha256: hash(files["SKILL.md"]),
            },
          ]),
        ),
        body = {
          kind: "package",
          project_ref: project.id,
          source_id: hash(name),
          checksum: fileChecksum,
          content_base64: exportPackage(name, files).toString("base64"),
          scope: "personal",
          flags: { managed: true, protected: false, pinned: false },
        };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/migrations/import",
            headers: { ...base, authorization: `Bearer ${cfg.token}` },
            payload: body,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/migrations/import",
            headers: { ...base, cookie: headers.cookie },
            payload: body,
          })
        ).statusCode,
      ).toBe(403);
      const response = await app.inject({
        method: "POST",
        url: "/api/migrations/import",
        headers,
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("applied");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/migrations/import",
            headers,
            payload: { ...body, user_id: otherId },
          })
        ).statusCode,
      ).not.toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/migrations/import",
            headers,
            payload: { ...body, content_base64: "%%%=" },
          })
        ).json().error.code,
      ).toBe("invalid_transfer");
      const published = await app.inject({
        method: "POST",
        url: "/api/migrations/import",
        headers,
        payload: body,
      });
      expect(published.statusCode).toBe(200);
      expect(published.json().state).toBe("applied");
      const replay = await app.inject({
        method: "POST",
        url: "/api/migrations/import",
        headers,
        payload: body,
      });
      expect(replay.json().replayed).toBe(true);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/migrations/package/${published.json().receipt_id}/rollback`,
            headers: other,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/migrations/package/${published.json().receipt_id}/rollback`,
            headers,
          })
        ).json().state,
      ).toBe("rolled_back");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
