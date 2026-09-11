import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M03-B yüzey doğrulaması: gerçek HTTP sunucusu + gerçek MCP istemcisi.
 *
 * - `memoryEnabled=false` iken katalogda yalnız beş `forge_*` aracı kalır.
 * - `memoryEnabled=true` iken altı `memory_*` aracı eklenir (11 toplam).
 * - MCP `memory_update` ile HTTP `POST /api/memory/update` aynı uygulama
 *   işlemine gider; MCP `memory_read` ile HTTP not ucu aynı kabul edilmiş
 *   içeriği/revision'ı gösterir; HTTP context ile MCP context aynı offered
 *   kimliklerini verir.
 */

const FIVE_FORGE_TOOLS = [
  "forge_handoff",
  "forge_load",
  "forge_report",
  "forge_run",
  "forge_search",
];

async function bootServer(memoryEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-surface-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  await app.listen({ host: config.host, port: config.port });
  const headers = {
    host: new URL(config.url).host,
    authorization: `Bearer ${config.token}`,
  };
  const client = new Client({ name: "m03-independent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
      requestInit: { headers },
    }),
  );
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const memory = new MemoryService(storage.db, identities, vaultRoot(root));
  const space = await memory.ensureSpace(owner, { type: "personal" });
  const http = async (path: string, init: RequestInit = {}) =>
    fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  return {
    root,
    config,
    app,
    client,
    storage,
    identities,
    owner,
    memory,
    space,
    http,
    call,
    close: async () => {
      await client.close();
      await app.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("memoryEnabled=false: katalog beş forge_* aracında kalır", async () => {
  const env = await bootServer(false);
  try {
    const names = (await env.client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([...FIVE_FORGE_TOOLS].sort());
    // memory_* katalog dışı: istemci çağrısı hata döner/fırlatır.
    let denied: unknown;
    try {
      denied = await env.client.callTool({
        name: "memory_context",
        arguments: {},
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeDefined();
    const message =
      denied instanceof Error
        ? denied.message
        : JSON.stringify(denied ?? "").slice(0, 300);
    expect(message).toMatch(/not found|unknown|tool|method/i);
  } finally {
    await env.close();
  }
}, 60000);

test("memoryEnabled=true: altı memory_* aracı eklenir; MCP ve HTTP aynı sonucu verir", async () => {
  const env = await bootServer(true);
  try {
    const names = (await env.client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    for (const tool of [
      "memory_context",
      "memory_recall",
      "memory_read",
      "memory_update",
      "memory_link",
      "memory_checkpoint",
    ])
      expect(names).toContain(tool);
    expect(names).toHaveLength(FIVE_FORGE_TOOLS.length + 6);

    // MCP ile oluştur.
    const created = await env.call("memory_update", {
      space_id: env.space.id,
      kind: "decision",
      title: "MCP kararı",
      body: "MCP gövdesi",
    });
    const noteId = created.note_id as string;
    expect(created.revision).toBe(1);
    // HTTP aynı kabul edilmiş içeriği gösterir.
    const httpNote = await env.http(
      `/api/memory/notes/${noteId}?space_id=${encodeURIComponent(env.space.id)}`,
    );
    expect(httpNote.status).toBe(200);
    const httpPayload = (await httpNote.json()) as {
      revision: { revision: number };
      content: string;
    };
    expect(httpPayload.revision.revision).toBe(1);
    expect(httpPayload.content).toContain("MCP gövdesi");
    // MCP read aynı içeriği ve revision'ı verir.
    const mcpRead = await env.call("memory_read", {
      space_id: env.space.id,
      note_id: noteId,
    });
    expect(mcpRead.revision.revision).toBe(1);
    expect(mcpRead.content).toContain("MCP gövdesi");
    // HTTP ile patch'le; MCP read yeni revizyonu görür.
    const patched = await env.http("/api/memory/update", {
      method: "POST",
      body: JSON.stringify({
        space_id: env.space.id,
        note_id: noteId,
        expected_revision: 1,
        body: "HTTP gövdesi",
      }),
    });
    expect(patched.status).toBe(200);
    const patchedPayload = (await patched.json()) as { revision: number };
    expect(patchedPayload.revision).toBe(2);
    const mcpAfter = await env.call("memory_read", {
      space_id: env.space.id,
      note_id: noteId,
    });
    expect(mcpAfter.revision.revision).toBe(2);
    expect(mcpAfter.content).toContain("HTTP gövdesi");
    // HTTP revisions ucu ile MCP revision okuması birebir.
    const revisions = await env.http(
      `/api/memory/notes/${noteId}/revisions?space_id=${encodeURIComponent(env.space.id)}`,
    );
    expect(revisions.status).toBe(200);
    const revisionList = (await revisions.json()) as {
      items: { revision: number }[];
    };
    expect(revisionList.items.map((item) => item.revision).sort()).toEqual([
      1, 2,
    ]);
    const mcpOld = await env.call("memory_read", {
      space_id: env.space.id,
      note_id: noteId,
      revision: 1,
    });
    expect(mcpOld.content).toContain("MCP gövdesi");
    // HTTP context ile MCP context aynı offered kimliklerini verir.
    const httpContext = await env.http(
      `/api/memory/context?space_id=${encodeURIComponent(env.space.id)}&max_tokens=2048`,
    );
    expect(httpContext.status).toBe(200);
    const httpPackage = (await httpContext.json()) as {
      offered: { note_id: string; revision: number }[];
    };
    const mcpPackage = await env.call("memory_context", {
      space_id: env.space.id,
      max_tokens: 2048,
    });
    expect(
      (mcpPackage.offered as { note_id: string }[])
        .map((item) => item.note_id)
        .sort(),
    ).toEqual(httpPackage.offered.map((item) => item.note_id).sort());
    // Link ve checkpoint MCP üzerinden de aynı servise gider.
    const second = await env.call("memory_update", {
      space_id: env.space.id,
      kind: "note",
      title: "Hedef not",
      body: "hedef",
    });
    const linked = await env.call("memory_link", {
      space_id: env.space.id,
      note_id: noteId,
      relation: "SUPPORTS",
      target_note_id: second.note_id,
      expected_revision: 2,
    });
    expect(linked.revision).toBe(3);
    const checkpoint = await env.call("memory_checkpoint", {
      space_id: env.space.id,
      goal: "MCP checkpoint",
      progress: "başladı",
    });
    expect(checkpoint.task_status).toBe("doing");
  } finally {
    await env.close();
  }
}, 90000);
