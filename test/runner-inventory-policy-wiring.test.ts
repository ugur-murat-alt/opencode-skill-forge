import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SettingsService } from "../src/application/settings.js";
import { ForgeService } from "../src/application/forge.js";
import { JobQueue } from "../src/jobs/queue.js";
import { PackageStore } from "../src/skills/store.js";
import { SecretVault } from "../src/storage/secrets.js";
import { productionHandler } from "../src/runner/handler.js";
import type { Settings } from "../src/domain/settings.js";

const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const QUERY = "inventory policy term";
const FILES = (name: string) => ({
  "SKILL.md": Buffer.from(
    `---\nname: ${name}\ndescription: Inventory policy term fixture description.\n---\nBody.\n`,
  ),
});
const SKILL_NAMES = [
  "inventory-policy-a",
  "inventory-policy-b",
  "inventory-policy-c",
];

interface InventoryFixture {
  items: { name: string }[];
  externalItems: { name: string }[];
}

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * Issue #26: composes the REAL production handler (real lease, real
 * EvolutionStaging, real inventory tool, real budget) and replaces only the
 * provider event stream. The captured message is the actual tool result the
 * internal agent saw, not a hand-built store lookup.
 */
async function runInventory(options: {
  policy: Settings;
  tenantPolicy?: Settings;
  afterAccept?: (context: {
    owner: { tenantId: string; userId: string };
    storage: Awaited<ReturnType<typeof openDatabase>>;
    projectId: string;
  }) => Promise<void>;
}): Promise<InventoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-inventory-policy-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Inventory policy");
    await storage.db
      .insertInto("provider_profiles")
      .values({
        tenant_id: owner.tenantId,
        user_id: owner.userId,
        id: randomUUID(),
        role: "skill",
        revision: 1,
        profile_json: JSON.stringify({
          provider: "ollama",
          model: "inventory-fixture",
          allowPaid: false,
          maxOutputTokens: 1024,
          contextWindow: 4096,
        }),
        secret_ref: null,
        created_at: Date.now(),
      })
      .execute();
    const store = new PackageStore(storage, root);
    for (const name of SKILL_NAMES)
      await store.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(name),
      });
    if (options.tenantPolicy)
      await new SettingsService(identities, {}).update(
        owner,
        "policy",
        0,
        options.tenantPolicy,
      );
    const queue = new JobQueue(storage, options.policy);
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "skill_evolve",
      key: randomUUID(),
      payload: { summary: "Inventory policy fixture" },
    });
    if (options.afterAccept)
      await options.afterAccept({ owner, storage, projectId: project.id });
    const run = await queue.claim(
      "inventory-policy-worker",
      30000,
      "skill_evolve",
      { tenantId: owner.tenantId, runId: accepted.run.id },
    );
    if (!run) throw new Error("run_not_claimed");
    const captured: string[] = [];
    const providerStream: StreamFn = (model, context) => {
      const stream = createAssistantMessageEventStream();
      const results = context.messages.filter((m) => m.role === "toolResult");
      const last = results.at(-1);
      if (!last) {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: assistantMessage(model, [
            {
              type: "toolCall",
              id: "inventory-call",
              name: "inventory",
              arguments: { query: QUERY },
            },
          ]),
        });
      } else {
        captured.push(
          last.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        );
        stream.push({
          type: "done",
          reason: "toolUse",
          message: assistantMessage(model, [
            {
              type: "toolCall",
              id: "finalize-call",
              name: "finalize",
              arguments: { decision: "no-op", reason: "inventory fixture" },
            },
          ]),
        });
      }
      return stream;
    };
    const vault = await SecretVault.open(root);
    const handler = productionHandler(storage, root, vault, true, {
      providerStream,
    });
    const result = await handler(run, new AbortController().signal);
    expect(result.state).toBe("no_op");
    expect(captured).toHaveLength(1);
    const inventory = JSON.parse(captured[0]!) as {
      items: { name: string }[];
    };
    const external = await new ForgeService(
      storage,
      root,
      "inventory-policy-key",
      options.policy,
    ).invoke("forge_search", owner, {
      project_ref: project.id,
      query: QUERY,
      limit: 20,
    } as never);
    return {
      items: inventory.items,
      externalItems: (external as { items: { name: string }[] }).items,
    };
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Issue #26: operator cap=1 with a looser tenant policy: the external MCP
 * tool path and the real handler's inventory tool must see the same cap. */
test("P2 #26 operator search cap=1 survives a looser tenant for both external tool and real handler inventory", async () => {
  const result = await runInventory({
    policy: { searchMaxResults: 1, allowedOrigins: [OLLAMA_ORIGIN] },
    tenantPolicy: { searchMaxResults: 20 },
  });
  expect(result.externalItems).toHaveLength(1);
  expect(result.items).toHaveLength(1);
});

/** Issue #26: a minimum-score cap has the same precedence in both paths. */
test("P2 #26 operator searchMinScore=1 filters the external tool and the real handler inventory alike", async () => {
  const result = await runInventory({
    policy: { searchMinScore: 1, allowedOrigins: [OLLAMA_ORIGIN] },
    tenantPolicy: { searchMinScore: 0 },
  });
  expect(result.externalItems).toHaveLength(0);
  expect(result.items).toHaveLength(0);
});

/** Issue #26: the accepted snapshot is the upper bound, and a project layer
 * stored after acceptance may narrow it further for the running job. */
test("P2 #26 project narrowing stored after acceptance constrains the running job inventory", async () => {
  const result = await runInventory({
    policy: { searchMaxResults: 5, allowedOrigins: [OLLAMA_ORIGIN] },
    tenantPolicy: { searchMaxResults: 20 },
    afterAccept: async ({ owner, storage, projectId }) => {
      await new SettingsService(new IdentityService(storage.db), {}).update(
        owner,
        `project:${projectId}`,
        0,
        { searchMaxResults: 1 },
      );
    },
  });
  // Both paths also apply the currently stored project layer (min(5, 20, 1)).
  expect(result.externalItems).toHaveLength(1);
  expect(result.items).toHaveLength(1);
});
