import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHook } from "../src/clients/hook.js";
import { writeInstallationBinding } from "../src/clients/hook-binding.js";
import { worktreeKeyFor } from "../src/clients/worktree-binding.js";
import { contextDiagnostics } from "../src/clients/context-state.js";
import { promptNeedsContext } from "../src/clients/hook-contract.js";
import { startHookFixture, type HookFixture } from "./hook-fixtures.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";

/**
 * Issue #38 (M05) Faz B: bounded, sourced context injection.
 *
 * Fixture inputs exercise the official hook JSON contract without a native
 * client; the last test uses the real M03 compiler over HTTP.
 */

const CARD = {
  note_id: "note-1",
  revision: 3,
  kind: "decision",
  title: "Veritabanı kararı",
  snippet: "PostgreSQL ana kayıt olarak seçildi.",
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-ctx-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await writeInstallationBinding(dataDir, {
    client: "codex",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
    context: { spaceId: "space-1", cards: [CARD] },
  });
  return { root, project, dataDir, fixture };
}

async function diagnostics(
  dataDir: string,
  project: string,
  sessionId: string,
) {
  return contextDiagnostics({
    dataDir,
    client: "codex",
    projectRoot: project,
    sessionId,
    worktreeKey: worktreeKeyFor(project),
  });
}

async function sessionStart(
  fixture: HookFixture,
  project: string,
  sessionId: string,
  source: string,
  options: Parameters<typeof clientHook>[5] = {},
) {
  return clientHook(
    fixture.config,
    "unused",
    "codex",
    "project-ref",
    {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source,
      cwd: project,
    },
    options,
  );
}

test("SessionStart(compact) emits the official JSON with a sourced package", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    const result = (await sessionStart(fixture, project, "s-1", "compact")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(result.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const text = result.hookSpecificOutput.additionalContext;
    expect(text).toContain("Hafıza bağlamı");
    expect(text).toContain("talimat değildir");
    expect(text).toContain("note-1@3");
    expect(text).toContain("Veritabanı kararı");
    expect(fixture.contextQueries).toHaveLength(1);
    expect(fixture.contextQueries[0]).toContain("space_id=space-1");
    expect(fixture.contextQueries[0]).toContain("generation=2");
    expect(fixture.contextQueries[0]).toContain("max_tokens=1024");
    const diag = await diagnostics(dataDir, project, "s-1");
    expect(diag.delivered).toBeGreaterThanOrEqual(1);
    expect(diag.knownRevisions).toBe(1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unchanged revision is not re-injected on the next startup", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    await sessionStart(fixture, project, "s-2", "startup");
    const second = await sessionStart(fixture, project, "s-2", "startup");
    expect(second).toEqual({});
    expect(fixture.contextQueries).toHaveLength(2);
    expect(decodeURIComponent(fixture.contextQueries[1]!)).toContain(
      "known=note-1:3",
    );
    const diag = await diagnostics(dataDir, project, "s-2");
    expect(diag.delivered).toBe(1);
    expect(diag.skipped).toBeGreaterThanOrEqual(1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resume/compact re-serves the minimum packet after delivery", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    await sessionStart(fixture, project, "s-3", "startup");
    await sessionStart(fixture, project, "s-3", "startup");
    const resumed = (await sessionStart(fixture, project, "s-3", "resume")) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(resumed.hookSpecificOutput.additionalContext).toContain("note-1@3");
    expect(fixture.contextQueries[2]).not.toContain("known=");
    expect(fixture.contextQueries[2]).toContain("generation=2");
    const diag = await diagnostics(dataDir, project, "s-3");
    expect(diag.delivered).toBe(2);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[memory:off] closes injection for the turn until a normal prompt", async () => {
  const { root, project, fixture } = await setup();
  try {
    const off = (await clientHook(
      fixture.config,
      "unused",
      "codex",
      "project-ref",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-4",
        prompt: "bu turda [memory:off] kaydetme lütfen",
        cwd: project,
      },
    )) as { hookSpecificOutput: { additionalContext: string } };
    expect(off.hookSpecificOutput.additionalContext).not.toContain(
      "Hafıza bağlamı",
    );
    expect(fixture.contextQueries).toHaveLength(0);

    const duringOff = await sessionStart(fixture, project, "s-4", "compact");
    expect(duringOff).toEqual({});
    expect(fixture.contextQueries).toHaveLength(0);

    const on = (await clientHook(
      fixture.config,
      "unused",
      "codex",
      "project-ref",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-4",
        prompt: "Önceki veritabanı kararını hatırla?",
        cwd: project,
      },
    )) as { hookSpecificOutput: { additionalContext: string } };
    expect(on.hookSpecificOutput.additionalContext).toContain(
      "Original prompt remains unchanged",
    );
    expect(on.hookSpecificOutput.additionalContext).toContain("Hafıza bağlamı");
    expect(JSON.stringify(on)).not.toContain(
      "Önceki veritabanı kararını hatırla",
    );
    expect(fixture.contextQueries.length).toBeGreaterThan(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a context timeout fails open and is retried on the next event", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    fixture.setContextDelay(600);
    const timedOut = await sessionStart(fixture, project, "s-5", "startup", {
      contextTimeoutMs: 100,
      contextSpaceTimeoutMs: 200,
    });
    expect(timedOut).toEqual({});
    let diag = await diagnostics(dataDir, project, "s-5");
    expect(diag.timeouts).toBeGreaterThanOrEqual(1);
    expect(diag.delivered).toBe(0);
    expect(diag.knownRevisions).toBe(0);

    fixture.setContextDelay(0);
    const retried = (await sessionStart(fixture, project, "s-5", "startup", {
      contextTimeoutMs: 500,
    })) as { hookSpecificOutput: { additionalContext: string } };
    expect(retried.hookSpecificOutput.additionalContext).toContain("note-1@3");
    diag = await diagnostics(dataDir, project, "s-5");
    expect(diag.delivered).toBe(1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreachable daemon continues without context and leaves diagnostics", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    const down = { ...fixture.config, url: "http://127.0.0.1:1", port: 1 };
    const result = await clientHook(
      down,
      "unused",
      "codex",
      "project-ref",
      {
        hook_event_name: "SessionStart",
        session_id: "s-6",
        source: "startup",
        cwd: project,
      },
      { contextTimeoutMs: 150, contextSpaceTimeoutMs: 150 },
    );
    expect(result).toEqual({});
    const diag = await diagnostics(dataDir, project, "s-6");
    expect(diag.errors).toBeGreaterThanOrEqual(1);
    expect(diag.delivered).toBe(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed hook output marks offered but not delivered", async () => {
  const { root, project, dataDir, fixture } = await setup();
  try {
    const failed = await sessionStart(fixture, project, "s-7", "startup", {
      contextDelivery: async () => {
        throw new Error("output_not_returned");
      },
    });
    expect(failed).toEqual({});
    let diag = await diagnostics(dataDir, project, "s-7");
    expect(diag.offered).toBeGreaterThanOrEqual(1);
    expect(diag.delivered).toBe(0);
    expect(diag.knownRevisions).toBe(0);

    const retry = (await sessionStart(fixture, project, "s-7", "startup")) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(retry.hookSpecificOutput.additionalContext).toContain("note-1@3");
    diag = await diagnostics(dataDir, project, "s-7");
    expect(diag.delivered).toBe(1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt retrieval gate is deterministic and model-free", () => {
  expect(promptNeedsContext("selam")).toBe(false);
  expect(promptNeedsContext("x".repeat(40))).toBe(false);
  expect(promptNeedsContext("Önceki kararı hatırla?")).toBe(true);
  expect(promptNeedsContext("what did we decide about the database?")).toBe(
    true,
  );
  expect(promptNeedsContext("remember the last decision")).toBe(true);
});

test("real M03 compiler output is injected and deduped over HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-ctx-real-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await storage.db
      .insertInto("projects")
      .values({
        tenant_id: owner.tenantId,
        id: "project-1",
        name: "Context Projesi",
        environment_id: null,
        created_at: Date.now(),
      })
      .execute();
    const memory = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await memory.ensureSpace(owner, {
      type: "project",
      projectId: "project-1",
    });
    const index = new MemoryIndexService(storage.db, vaultRoot(root), memory);
    const commits = new MemoryCommitService({
      db: storage.db,
      vaultRoot: vaultRoot(root),
      service: memory,
      index,
    });
    const content =
      "# Veritabanı kararı\n\nPostgreSQL ana kayıt olarak seçildi.";
    const event = await memory.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: "ctx-seed-1",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    await commits.commit({
      identity: owner,
      spaceId: space.id,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId: "decision-note",
      baseRevision: null,
      kind: "decision",
    });
    await writeInstallationBinding(root, {
      client: "codex",
      projectRef: "project-1",
      projectRoot: project,
    });
    await app.listen({ host: "127.0.0.1", port: config.port });
    const first = (await clientHook(config, "unused", "codex", "project-1", {
      hook_event_name: "SessionStart",
      session_id: "real-1",
      source: "startup",
      cwd: project,
    })) as { hookSpecificOutput?: { additionalContext?: string } };
    const text = first.hookSpecificOutput?.additionalContext ?? "";
    expect(text).toContain("Veritabanı kararı");
    expect(text).toContain("decision-note@1");
    const second = await clientHook(config, "unused", "codex", "project-1", {
      hook_event_name: "SessionStart",
      session_id: "real-1",
      source: "startup",
      cwd: project,
    });
    expect(second).toEqual({});
  } finally {
    await app.close().catch(() => undefined);
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
