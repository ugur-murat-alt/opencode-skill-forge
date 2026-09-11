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
 * Issue #36 (M03): the four write/context memory tools over a real MCP
 * connection. Updates are revisioned with expected_revision CAS, links edit
 * the source note's versioned metadata, checkpoints never auto-complete a
 * task, and the compiled context reflects the same committed snapshot.
 */

test("#36 real MCP update/link/checkpoint/context share the committed snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-writes-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  let client: Client | undefined;
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const service = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await service.ensureSpace(owner, { type: "personal" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    const base = `http://127.0.0.1:${address.port}`;
    client = new Client({ name: "m03-writes", version: "1" });
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
    const call = async (name: string, args: object) => {
      const response = await client!.callTool({ name, arguments: args });
      return {
        isError: response.isError === true,
        payload: JSON.parse(
          (response.content as { text: string }[])[0]!.text,
        ) as Record<string, unknown>,
      };
    };

    const tools = await client.listTools();
    for (const name of [
      "memory_context",
      "memory_recall",
      "memory_read",
      "memory_update",
      "memory_link",
      "memory_checkpoint",
    ])
      expect(tools.tools.map((tool) => tool.name)).toContain(name);

    // Create (task) → receipt revision 1.
    const created = await call("memory_update", {
      space_id: space.id,
      kind: "task",
      title: "MCP görevi",
      body: "ilk gövde",
      task_status: "doing",
    });
    expect(created.isError).toBe(false);
    expect(created.payload.status).toBe("committed");
    expect(created.payload.revision).toBe(1);
    const noteId = created.payload.note_id as string;

    // Patch under CAS → revision 2.
    const patched = await call("memory_update", {
      space_id: space.id,
      note_id: noteId,
      expected_revision: 1,
      title: "MCP görevi v2",
      body: "güncel gövde",
    });
    expect(patched.isError).toBe(false);
    expect(patched.payload.revision).toBe(2);

    // Stale CAS → explicit conflict, no partial success.
    const stale = await call("memory_update", {
      space_id: space.id,
      note_id: noteId,
      expected_revision: 1,
      title: "eski taban",
    });
    expect(stale.isError).toBe(true);
    expect((stale.payload.error as { code: string }).code).toBe(
      "memory_revision_conflict",
    );

    // İkinci not ve tipli link; graf üzerinden doğrulanır.
    const target = await call("memory_update", {
      space_id: space.id,
      kind: "decision",
      title: "Hedef karar",
      body: "hedef gövde",
    });
    const targetId = target.payload.note_id as string;
    const linked = await call("memory_link", {
      space_id: space.id,
      note_id: noteId,
      relation: "SUPPORTS",
      target_note_id: targetId,
      expected_revision: 2,
    });
    expect(linked.isError).toBe(false);
    expect(linked.payload.revision).toBe(3);
    const graph = await fetch(
      `${base}/api/memory/graph?space_id=${encodeURIComponent(space.id)}&note_id=${encodeURIComponent(noteId)}`,
      {
        headers: {
          host: new URL(config.url).host,
          authorization: `Bearer ${config.token}`,
        },
      },
    );
    const graphPayload = (await graph.json()) as {
      edges: { relation: string; target_note_id: string }[];
    };
    expect(graphPayload.edges).toContainEqual({
      source_note_id: noteId,
      relation: "SUPPORTS",
      target_note_id: targetId,
    });

    // Link kaldırma da kaynak notun CAS'ına bağlıdır.
    const unlinked = await call("memory_link", {
      space_id: space.id,
      note_id: noteId,
      relation: "SUPPORTS",
      target_note_id: targetId,
      remove: true,
      expected_revision: 3,
    });
    expect(unlinked.isError).toBe(false);
    expect(unlinked.payload.edges).toEqual([]);

    // Checkpoint: engel kaydeder, görevi otomatik done yapmaz.
    const checkpoint = await call("memory_checkpoint", {
      space_id: space.id,
      goal: "Kabul kapısı",
      progress: "Faz B yazıldı",
      blocker: "benchmark bekliyor",
    });
    expect(checkpoint.isError).toBe(false);
    expect(checkpoint.payload.task_status).toBe("blocked");
    const checkpointId = checkpoint.payload.note_id as string;
    const context = await call("memory_context", { space_id: space.id });
    expect(context.isError).toBe(false);
    const contextPayload = context.payload as {
      cards: { note_id: string; revision: number; match_reason: string }[];
      sections: { blockers: string[] };
      envelope: { token_estimator: string };
    };
    expect(contextPayload.sections.blockers).toContain(checkpointId);
    const blockerCard = contextPayload.cards.find(
      (card) => card.note_id === checkpointId,
    );
    expect(blockerCard?.revision).toBe(1);
    expect(blockerCard?.match_reason).toBe("blocker:task");
    expect(contextPayload.envelope.token_estimator).toContain("estimate");

    // Audit: her mutasyon açıkça kaydedildi.
    const audit = await storage.db
      .selectFrom("audit_events")
      .select(["kind"])
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "in", [
        "memory.update.applied",
        "memory.link.applied",
        "memory.checkpoint.recorded",
      ])
      .execute();
    const kinds = new Set(audit.map((row) => row.kind));
    expect(kinds).toEqual(
      new Set([
        "memory.update.applied",
        "memory.link.applied",
        "memory.checkpoint.recorded",
      ]),
    );
  } finally {
    await client?.close().catch(() => undefined);
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
