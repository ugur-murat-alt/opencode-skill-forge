import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { vaultRoot } from "../src/memory/paths.js";
import {
  HOOK_SPOOL_LIMITS,
  acceptHookCapture,
  deliverSpool,
  hookEventId,
  spoolDiagnostics,
  withSpoolDb,
} from "../src/clients/hook-spool.js";
import { startHookFixture } from "./hook-fixtures.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const captureInput = (dataDir: string, content: string) => ({
  dataDir,
  installationId: "a".repeat(64),
  projectRef: "project-ref",
  client: "codex" as const,
  event: "Stop",
  sessionId: "session-1",
  turnRef: "turn-1",
  worktreeKey: "worktree-key",
  sourceKind: "codex-stop-hook",
  kind: "session",
  content,
  observedAt: 1_700_000_000_000,
  now: 1_700_000_000_000,
});

async function tempRoot(name: string) {
  const root = await mkdtemp(join(tmpdir(), name));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return { root, dataDir };
}

test("daemon down: capture is durable, redacted and delivered exactly once", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-offline-");
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
  });
  try {
    const content =
      "# Checkpoint\n\nAuthorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345\n";
    const accepted = await acceptHookCapture(captureInput(dataDir, content));
    expect(accepted.status).toBe("accepted");
    const stored = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe("pending");
    expect(stored[0]!.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

    const first = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(first.delivered).toBe(1);
    expect(fixture.ingestKeys).toHaveLength(1);
    const ingest = fixture.received.find(
      (entry) => entry.url === "/api/memory/ingest",
    )!;
    expect(ingest.body.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(ingest.body.source_event_key).toMatch(/^hook:[a-f0-9]{64}$/);
    expect(ingest.body.kind).toBe("session");

    const after = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(after[0]!.state).toBe("delivered");
    expect(after[0]!.content).toBe("");
    expect(after[0]!.run_id).toBeTruthy();

    const second = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(second.attempted).toBe(0);
    const duplicate = await acceptHookCapture(captureInput(dataDir, content));
    expect(duplicate.status).toBe("duplicate");
    const again = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(again).toHaveLength(1);
    const diagnostics = await spoolDiagnostics(dataDir);
    expect(diagnostics.delivered).toBe(1);
    expect(diagnostics.pending).toBe(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed ingest stays pending with backoff and delivers after recovery", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-retry-");
  let forced = 503;
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
    ingestStatus: () => forced,
  });
  try {
    await acceptHookCapture(captureInput(dataDir, "# Checkpoint\n\nretry me"));
    const first = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(first.retried).toBe(1);
    const pending = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(pending[0]!.state).toBe("pending");
    expect(pending[0]!.attempts).toBe(1);
    expect(pending[0]!.last_error).toBe("http_503");
    expect(pending[0]!.next_attempt_at).toBeGreaterThan(1_700_000_000_000);

    await withSpoolDb(dataDir, (db) =>
      db.updateTable("memory_spool").set({ next_attempt_at: 0 }).execute(),
    );
    forced = 0;
    const second = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(second.delivered).toBe(1);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded queue rejects new capture with a visible counter", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-full-");
  try {
    const now = Date.now();
    await withSpoolDb(dataDir, async (db) => {
      const rows = Array.from(
        { length: HOOK_SPOOL_LIMITS.maxPendingRows },
        (_, index) => ({
          id: `row-${index}`,
          installation_id: "filler",
          project_ref: "project-ref",
          client: "codex",
          event: "Stop",
          session_id: "session-filler",
          turn_ref: null,
          worktree_key: null,
          event_id: `filler-${index}`,
          source_kind: "codex-stop-hook",
          kind: "session",
          content: `# filler ${index}`,
          content_hash: sha256(`filler-${index}`),
          content_bytes: 12,
          state: "pending",
          attempts: 0,
          next_attempt_at: 0,
          run_id: null,
          last_error: null,
          observed_at: now,
          created_at: now,
          updated_at: now,
        }),
      );
      await db.insertInto("memory_spool").values(rows).execute();
    });
    const rejected = await acceptHookCapture(
      captureInput(dataDir, "# Checkpoint\n\noverflow"),
    );
    expect(rejected).toEqual({ status: "rejected", reason: "spool_full" });
    const diagnostics = await spoolDiagnostics(dataDir);
    expect(diagnostics.counters.spool_full).toBe(1);
    expect(diagnostics.pending).toBe(HOOK_SPOOL_LIMITS.maxPendingRows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same event id with a different stored payload is a conflict, never an update", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-conflict-");
  try {
    const content = "# Checkpoint\n\npayload-A";
    const identity = {
      installationId: "a".repeat(64),
      projectRef: "project-ref",
      client: "codex" as const,
      event: "Stop",
      sessionId: "session-1",
      turnRef: "turn-1",
      worktreeKey: "worktree-key",
    };
    const eventId = hookEventId({ ...identity, contentHash: sha256(content) });
    const now = Date.now();
    await withSpoolDb(dataDir, (db) =>
      db
        .insertInto("memory_spool")
        .values({
          id: "existing",
          installation_id: identity.installationId,
          project_ref: identity.projectRef,
          client: identity.client,
          event: identity.event,
          session_id: identity.sessionId,
          turn_ref: identity.turnRef,
          worktree_key: identity.worktreeKey,
          event_id: eventId,
          source_kind: "codex-stop-hook",
          kind: "session",
          content: "# Old payload",
          content_hash: sha256("payload-B"),
          content_bytes: 13,
          state: "pending",
          attempts: 0,
          next_attempt_at: 0,
          run_id: null,
          last_error: null,
          observed_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute(),
    );
    const result = await acceptHookCapture(captureInput(dataDir, content));
    expect(result.status).toBe("conflict");
    const rows = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("# Old payload");
    const diagnostics = await spoolDiagnostics(dataDir);
    expect(diagnostics.counters.event_conflict).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a policy rejection is terminal, visible and does not keep the payload", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-reject-");
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
    ingestStatus: 422,
  });
  try {
    await acceptHookCapture(captureInput(dataDir, "# Checkpoint\n\npolicy"));
    const report = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(report.rejected).toBe(1);
    const rows = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").selectAll().execute(),
    );
    expect(rows[0]!.state).toBe("rejected");
    expect(rows[0]!.content).toBe("");
    expect(rows[0]!.last_error).toBe("ingest_rejected");
    const diagnostics = await spoolDiagnostics(dataDir);
    expect(diagnostics.counters.ingest_rejected).toBe(1);
    const second = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(second.attempted).toBe(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an older retried checkpoint never overwrites the newer one", async () => {
  const { root, dataDir } = await tempRoot("forge-spool-order-");
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
  });
  try {
    const older = await acceptHookCapture(
      captureInput(dataDir, "# Checkpoint\n\nolder"),
    );
    const newer = await acceptHookCapture(
      captureInput(dataDir, "# Checkpoint\n\nnewer"),
    );
    expect(older.status).toBe("accepted");
    expect(newer.status).toBe("accepted");
    await withSpoolDb(dataDir, (db) =>
      db
        .updateTable("memory_spool")
        .set({ next_attempt_at: Date.now() + 3_600_000 })
        .where("content_hash", "=", sha256("# Checkpoint\n\nolder"))
        .execute(),
    );
    const firstPass = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(firstPass.delivered).toBe(1);
    await withSpoolDb(dataDir, (db) =>
      db.updateTable("memory_spool").set({ next_attempt_at: 0 }).execute(),
    );
    const secondPass = await deliverSpool({
      config: fixture.config,
      budgetMs: 3000,
    });
    expect(secondPass.delivered).toBe(1);
    expect(fixture.ingestKeys).toHaveLength(2);
    expect(new Set(fixture.ingestKeys).size).toBe(2);
    const states = await withSpoolDb(dataDir, (db) =>
      db.selectFrom("memory_spool").select(["state"]).execute(),
    );
    expect(states.every((row) => row.state === "delivered")).toBe(true);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two scopes deliver only into their own space", async () => {
  const a = await tempRoot("forge-spool-scope-a-");
  const b = await tempRoot("forge-spool-scope-b-");
  const fixtureA = await startHookFixture(a.dataDir, {
    memory: { spaceId: "space-a", projectRef: "project-a" },
  });
  const fixtureB = await startHookFixture(b.dataDir, {
    memory: { spaceId: "space-b", projectRef: "project-b" },
  });
  try {
    await acceptHookCapture({
      ...captureInput(a.dataDir, "# Checkpoint\n\nA"),
      projectRef: "project-a",
    });
    await acceptHookCapture({
      ...captureInput(b.dataDir, "# Checkpoint\n\nB"),
      projectRef: "project-b",
    });
    await deliverSpool({ config: fixtureA.config, budgetMs: 3000 });
    await deliverSpool({ config: fixtureB.config, budgetMs: 3000 });
    const ingestA = fixtureA.received.find(
      (entry) => entry.url === "/api/memory/ingest",
    )!;
    const ingestB = fixtureB.received.find(
      (entry) => entry.url === "/api/memory/ingest",
    )!;
    expect(ingestA.body.space_id).toBe("space-a");
    expect(ingestB.body.space_id).toBe("space-b");
    expect(fixtureA.ingestKeys).not.toContain(ingestB.body.source_event_key);
    expect(fixtureB.ingestKeys).not.toContain(ingestA.body.source_event_key);
  } finally {
    await fixtureA.close();
    await fixtureB.close();
    await rm(a.root, { recursive: true, force: true });
    await rm(b.root, { recursive: true, force: true });
  }
});

test("end-to-end: spool delivers to the real M02 ingest and the checkpoint commits once", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-spool-e2e-"));
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
    await storage.db
      .insertInto("projects")
      .values({
        tenant_id: owner.tenantId,
        id: "project-1",
        name: "Fixture Project",
        environment_id: null,
        created_at: Date.now(),
      })
      .execute();
    const memory = new MemoryService(storage.db, identities, vaultRoot(root));
    const space = await memory.ensureSpace(owner, {
      type: "project",
      projectId: "project-1",
    });
    await app.listen({ host: "127.0.0.1", port: config.port });
    const base = config.url;
    const headers = {
      host: new URL(base).host,
      authorization: `Bearer ${config.token}`,
    };
    const content = "# Oturum checkpoint'i — codex\n\nGerçek hat teslimi.";
    const identity = {
      installationId: "b".repeat(64),
      projectRef: "project-1",
      client: "codex" as const,
      event: "Stop",
      sessionId: "session-e2e",
      turnRef: "turn-e2e",
      worktreeKey: "worktree-e2e",
    };
    const accepted = await acceptHookCapture({
      ...identity,
      dataDir: root,
      sourceKind: "codex-stop-hook",
      kind: "session",
      content,
      observedAt: Date.now(),
      now: Date.now(),
    });
    expect(accepted.status).toBe("accepted");
    const report = await deliverSpool({
      config: { dataDir: root, url: base, token: config.token },
      budgetMs: 5000,
    });
    expect(report.delivered).toBe(1);
    const eventId = hookEventId({ ...identity, contentHash: sha256(content) });
    const receipt = await until(async () => {
      const response = await fetch(
        `${base}/api/memory/events?space_id=${encodeURIComponent(space.id)}` +
          `&source_event_key=${encodeURIComponent(`hook:${eventId}`)}`,
        { headers },
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        throw new Error(`unexpected receipt status ${response.status}`);
      const payload = (await response.json()) as {
        state: string;
        indexed: boolean;
      };
      return payload.state === "committed" ? payload : null;
    });
    expect(receipt.indexed).toBe(true);
    const notes = await fetch(
      `${base}/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
      { headers },
    );
    expect(notes.status).toBe(200);
    const list = (await notes.json()) as { items: { id: string }[] };
    expect(list.items).toHaveLength(1);

    // A second delivery must not commit a second note.
    const rows = await withSpoolDb(root, (db) =>
      db
        .updateTable("memory_spool")
        .set({ state: "pending", content, content_bytes: content.length })
        .execute(),
    );
    expect(rows).toBeDefined();
    const replay = await deliverSpool({
      config: { dataDir: root, url: base, token: config.token },
      budgetMs: 5000,
    });
    expect(replay.duplicates).toBe(1);
    const notesAfter = await fetch(
      `${base}/api/memory/notes?space_id=${encodeURIComponent(space.id)}`,
      { headers },
    );
    const listAfter = (await notesAfter.json()) as { items: unknown[] };
    expect(listAfter.items).toHaveLength(1);
  } finally {
    await app.close().catch(() => undefined);
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function until<T>(
  check: () => Promise<T | null>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error("beklenen koşul zaman aşımına uğradı");
}
