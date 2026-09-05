import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
test("session preference HTTP controls the real queued prompt handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-session-http-")),
    config = await localConfig(root),
    app = await createHttpServer(config),
    headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
  try {
    const project = (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { name: "Session handler fixture" },
        })
      ).json(),
      source = { client: "codex", session: "session-http-fixture" };
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/session",
      headers,
      payload: {
        project_ref: project.id,
        source,
        base_revision: 0,
        values: { promptEnabled: false, autoApply: false },
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      url: `/api/settings/session?project_ref=${project.id}&client=codex&session=session-http-fixture`,
      headers,
    });
    expect(get.json()).toEqual({
      revision: 1,
      values: { promptEnabled: false, autoApply: false },
    });
    const original = "Preserve the scope and explain the requested change.";
    const response = await app.inject({
      method: "POST",
      url: "/api/tools/forge_prepare",
      headers,
      payload: {
        project_ref: project.id,
        source,
        original,
        idempotency_key: "session-http",
        wait_ms: 5000,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "unchanged",
      original,
      effective: original,
      auto_applied: false,
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
