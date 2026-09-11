import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { IdentityService } from "../src/application/identity.js";
import { openDatabase } from "../src/storage/database.js";
import { MemoryService } from "../src/memory/service.js";
import { MemorySourceService } from "../src/memory/sources.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Issue #39 HTTP region: independent profile binding, readiness status,
 * manual run acceptance and a read-only proposal list. No endpoint writes a
 * note; auto-write stays inside the finalized run policy.
 */
test("curator HTTP region exposes profile, status, run and proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-curator-http-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({
      memoryEnabled: true,
      evolutionEnabled: false,
      memoryCuratorMode: "manual",
      allowPaid: false,
      allowedOrigins: ["http://127.0.0.1:11434"],
    }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const memory = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await memory.ensureSpace(owner, { type: "personal" });
    const sourceRoot = join(root, "sources");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "prefs.md"), "# Tercih\n\nKoyu tema.\n");
    const source = await new MemorySourceService({
      db: storage.db,
      service: memory,
      vaultRoot: vaultRoot(root),
    }).registerSource(owner, {
      spaceId: space.id,
      rootPath: sourceRoot,
      mode: "read_only",
    });
    await app.listen({ host: "127.0.0.1", port: config.port });
    const base = config.url;
    const headers = {
      host: new URL(base).host,
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    } as Record<string, string>;

    const profile = await fetch(`${base}/api/memory/curator/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        base_revision: 0,
        profile: {
          provider: "ollama",
          model: "fixture-curator",
          baseUrl: "http://127.0.0.1:11434/v1",
          allowPaid: false,
          maxOutputTokens: 512,
        },
      }),
    });
    expect(profile.status).toBe(200);
    expect(((await profile.json()) as { revision: number }).revision).toBe(1);

    const status = await fetch(`${base}/api/memory/curator/status`, {
      headers,
    });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      model_ready: boolean;
      mode: string;
      memory_enabled: boolean;
      credential: string;
      extractor_version: string;
    };
    expect(statusBody.model_ready).toBe(true);
    expect(statusBody.mode).toBe("manual");
    expect(statusBody.memory_enabled).toBe(true);
    expect(statusBody.credential).toBe("missing");
    expect(statusBody.extractor_version).toMatch(/^m06-/);

    const body = {
      space_id: space.id,
      source_refs: [{ source_id: source.id, path: "prefs.md" }],
      idempotency_key: "http-curator-1",
    };
    const accepted = await fetch(`${base}/api/memory/curator/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { status: string }).status).toBe(
      "accepted",
    );
    const duplicate = await fetch(`${base}/api/memory/curator/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(((await duplicate.json()) as { status: string }).status).toBe(
      "duplicate",
    );

    const proposals = await fetch(
      `${base}/api/memory/curator/proposals?space_id=${space.id}`,
      { headers },
    );
    expect(proposals.status).toBe(200);
    expect(((await proposals.json()) as { items: unknown[] }).items).toEqual(
      [],
    );
  } finally {
    await app.close().catch(() => undefined);
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
