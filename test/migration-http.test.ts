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
  test(`server migration HTTP ${backend}: authenticated bytes, CSRF, private export and package receipt`, async () => {
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
      .values({ tenant_id: owner.tenantId, user_id: otherId, role: "owner" })
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
      const bytes = Buffer.from(
          "# Prompt Editor — Learn\r\n\r\n## [1700000000000]\r\nPreserve explicit constraints.\r\n",
        ),
        body = {
          kind: "learning",
          project_ref: project.id,
          source_id: hash("remote-source"),
          checksum: hash(bytes),
          content_base64: bytes.toString("base64"),
          enabled: false,
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
      const receipt = response.json().receipt_id;
      expect(response.json().review_required).toBe(0);
      const original = await app.inject({
        url: `/api/migrations/learning/${receipt}/original`,
        headers,
      });
      expect(original.rawPayload).toEqual(bytes);
      expect(
        (
          await app.inject({
            url: `/api/migrations/learning/${receipt}/original`,
            headers: other,
          })
        ).statusCode,
      ).toBe(404);
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
      for (const entry of [
        {
          kind: "rewrites",
          bytes: Buffer.from(
            JSON.stringify({
              ts: 1700000000000,
              sessionID: "server-session",
              messageID: "one",
              outcome: "rewritten",
              original: "Preserve the scope.",
              rewritten: "Preserve the stated scope.",
              durationMs: 12,
            }) + "\n",
          ),
          extra: {},
        },
        {
          kind: "flags",
          bytes: Buffer.from(
            JSON.stringify({ old: { enabled: false, autoAccept: false } }),
          ),
          extra: {
            sessions: [
              {
                legacy_session: "old",
                target: { client: "claude", session: "server-target" },
                base_revision: 0,
                defaults: { enabled: true, autoAccept: true },
              },
            ],
          },
        },
      ]) {
        const uploaded = await app.inject({
          method: "POST",
          url: "/api/migrations/import",
          headers,
          payload: {
            kind: entry.kind,
            project_ref: project.id,
            source_id: hash(entry.kind),
            checksum: hash(entry.bytes),
            content_base64: entry.bytes.toString("base64"),
            ...entry.extra,
          },
        });
        expect(uploaded.statusCode).toBe(200);
        expect(uploaded.json().review_required).toBe(0);
        expect(
          (
            await app.inject({
              url: `/api/migrations/${entry.kind}/${uploaded.json().receipt_id}/original`,
              headers,
            })
          ).rawPayload,
        ).toEqual(entry.bytes);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/migrations/${entry.kind}/${uploaded.json().receipt_id}/rollback`,
              headers,
            })
          ).json().state,
        ).toBe("rolled_back");
      }
      const name = `transfer-${randomUUID()}`,
        files = {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Preserve portable migration bytes.\n---\nApply the verified method.\n`,
          ),
        },
        checksum = hash(
          JSON.stringify([
            {
              path: "SKILL.md",
              bytes: files["SKILL.md"].length,
              sha256: hash(files["SKILL.md"]),
            },
          ]),
        );
      const packageBody = {
        kind: "package",
        project_ref: project.id,
        source_id: hash(name),
        checksum,
        content_base64: exportPackage(name, files).toString("base64"),
        scope: "personal",
        flags: { managed: true, protected: false, pinned: false },
      };
      const published = await app.inject({
        method: "POST",
        url: "/api/migrations/import",
        headers,
        payload: packageBody,
      });
      expect(published.statusCode).toBe(200);
      expect(published.json().state).toBe("applied");
      const replay = await app.inject({
        method: "POST",
        url: "/api/migrations/import",
        headers,
        payload: packageBody,
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
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/migrations/learning/${receipt}/rollback`,
            headers,
          })
        ).json().state,
      ).toBe("rolled_back");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
