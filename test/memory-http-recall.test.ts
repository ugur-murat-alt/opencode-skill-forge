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
 * Issue #36 (M03): real HTTP and real MCP calls hit the same application
 * operations. Recall/read return the same result and ACL for both surfaces,
 * the memory tools appear in the MCP catalog only while `memoryEnabled` is
 * on, and read endpoints never create runs.
 */

const doc = (
  noteId: string,
  spaceId: string,
  title: string,
  body: string,
  edges: { relation: string; target: string }[] = [],
) =>
  [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(noteId)}`,
    `memory_space_id: ${JSON.stringify(spaceId)}`,
    "kind: note",
    `title: ${JSON.stringify(title)}`,
    `edges: ${JSON.stringify(edges)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");

async function until<T>(
  check: () => Promise<T | null>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("receipt did not become durable in time");
}

function httpClient(base: string, config: { url: string; token: string }) {
  return async (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: new URL(config.url).host,
        authorization: `Bearer ${config.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
}

test("#36 real HTTP and MCP recall/read share results, scope and catalog gating", async () => {
  const enabledRoot = await mkdtemp(join(tmpdir(), "forge-m03-http-"));
  await writeFile(
    join(enabledRoot, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(enabledRoot);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: enabledRoot });
  let client: Client | undefined;
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const service = new MemoryService(
      storage.db,
      identities,
      vaultRoot(enabledRoot),
    );
    const space = await service.ensureSpace(owner, { type: "personal" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    const base = `http://127.0.0.1:${address.port}`;
    const request = httpClient(base, config);

    const ingest = async (key: string, content: string) => {
      const response = await request("/api/memory/ingest", {
        method: "POST",
        body: JSON.stringify({
          space_id: space.id,
          source_event_key: key,
          source_kind: "manual",
          content,
        }),
      });
      expect(response.status).toBe(200);
      return until(async () => {
        const receipt = await request(
          `/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
            `&source_event_key=${encodeURIComponent(key)}`,
        );
        if (receipt.status !== 200) return null;
        const payload = (await receipt.json()) as { state: string };
        return payload.state === "committed" ? payload : null;
      });
    };

    // İki not: biri diğerine tipli kenarla bağlı.
    await ingest(
      "m03-target",
      doc(
        "target-note",
        space.id,
        "Hedef karar",
        "hedef gövdesi paylaşılan terim",
      ),
    );
    await ingest(
      "m03-source",
      doc(
        "source-note",
        space.id,
        "Kaynak görev",
        "kaynak gövdesi benzersiz omega",
        [{ relation: "SUPPORTS", target: "target-note" }],
      ),
    );

    // HTTP recall: global aday keşfi ve skor.
    const recall = await request(
      `/api/memory/recall?query=${encodeURIComponent("benzersiz omega")}&space_id=${encodeURIComponent(space.id)}`,
    );
    expect(recall.status).toBe(200);
    const recallPayload = (await recall.json()) as {
      items: { note_id: string; revision: number; score: number }[];
    };
    expect(recallPayload.items[0]?.note_id).toBe("source-note");
    expect(recallPayload.items[0]?.revision).toBe(1);

    // HTTP graph: hedef düğüm ve kenar yetkili alandan görünür.
    const graph = await request(
      `/api/memory/graph?space_id=${encodeURIComponent(space.id)}&note_id=source-note`,
    );
    expect(graph.status).toBe(200);
    const graphPayload = (await graph.json()) as {
      nodes: { note_id: string }[];
      edges: { relation: string; target_note_id: string }[];
    };
    expect(graphPayload.nodes.map((node) => node.note_id).sort()).toEqual([
      "source-note",
      "target-note",
    ]);
    expect(graphPayload.edges).toEqual([
      {
        source_note_id: "source-note",
        relation: "SUPPORTS",
        target_note_id: "target-note",
      },
    ]);

    // Gerçek MCP: katalog ve çağrılar.
    client = new Client({ name: "m03-memory", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: {
            host: new URL(config.url).host,
            authorization: `Bearer ${config.token}`,
          },
        },
      }),
    );
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("memory_recall");
    expect(names).toContain("memory_read");
    expect(names.filter((name) => name.startsWith("forge_"))).toHaveLength(5);

    const recallTool = await client.callTool({
      name: "memory_recall",
      arguments: { query: "benzersiz omega", space_id: space.id },
    });
    expect(recallTool.isError).not.toBe(true);
    const mcpRecall = JSON.parse(
      (recallTool.content as { text: string }[])[0]!.text,
    ) as { items: { note_id: string }[] };
    expect(mcpRecall.items[0]?.note_id).toBe(recallPayload.items[0]?.note_id);

    const readTool = await client.callTool({
      name: "memory_read",
      arguments: { space_id: space.id, note_id: "source-note", neighbors: 3 },
    });
    expect(readTool.isError).not.toBe(true);
    const mcpRead = JSON.parse(
      (readTool.content as { text: string }[])[0]!.text,
    ) as { content: string | null; neighbors: { nodes: unknown[] } };
    expect(mcpRead.content).toContain("benzersiz omega");
    expect(mcpRead.neighbors.nodes.length).toBeGreaterThanOrEqual(2);

    // Yabancı/olmayan alan: MCP de sızıntısız hata döner.
    const denied = await client.callTool({
      name: "memory_recall",
      arguments: { query: "omega", space_id: "space-yok" },
    });
    expect(denied.isError).toBe(true);
    const deniedPayload = JSON.parse(
      (denied.content as { text: string }[])[0]!.text,
    ) as { error: { code: string } };
    expect(deniedPayload.error.code).toBe("memory_space_unavailable");

    // GET salt okunur: recall/graph run üretmez.
    const runsBefore = await storage.db
      .selectFrom("runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", owner.tenantId)
      .executeTakeFirstOrThrow();
    await request(
      `/api/memory/recall?query=${encodeURIComponent("omega")}&space_id=${encodeURIComponent(space.id)}`,
    );
    await request(
      `/api/memory/graph?space_id=${encodeURIComponent(space.id)}&note_id=source-note`,
    );
    const runsAfter = await storage.db
      .selectFrom("runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", owner.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(runsAfter.n)).toBe(Number(runsBefore.n));
  } finally {
    await client?.close().catch(() => undefined);
    await app.close();
    await storage.close();
    await rm(enabledRoot, { recursive: true, force: true });
  }
}, 60000);

test("#36 the memory tools stay out of the MCP catalog while memory is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-http-off-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: false, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  let client: Client | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    client = new Client({ name: "m03-memory-off", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
        {
          requestInit: {
            headers: {
              host: new URL(config.url).host,
              authorization: `Bearer ${config.token}`,
            },
          },
        },
      ),
    );
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("memory_"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("forge_"))).toHaveLength(5);
  } finally {
    await client?.close().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
