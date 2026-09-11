import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHook } from "../src/clients/hook.js";
import { writeInstallationBinding } from "../src/clients/hook-binding.js";
import { withSpoolDb } from "../src/clients/hook-spool.js";
import { startHookFixture } from "./hook-fixtures.js";

async function pendingRows(dataDir: string) {
  return withSpoolDb(dataDir, (db) =>
    db.selectFrom("memory_spool").selectAll().execute(),
  );
}

test("memory-off covers the whole turn, survives to Stop and is consumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-off-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await writeInstallationBinding(dataDir, {
    client: "claude",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir, {
    memory: { spaceId: "space-1", projectRef: "project-ref" },
  });
  try {
    const submit = await clientHook(
      fixture.config,
      "unused-entry",
      "claude",
      "project-ref",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt: "sil [memory:off] bu işi yap",
        cwd: project,
      },
      { deliver: false },
    );
    expect((submit as any).hookSpecificOutput.additionalContext).toContain(
      "Original prompt remains unchanged",
    );
    expect(JSON.stringify(submit)).not.toContain("bu işi yap");

    await clientHook(
      fixture.config,
      "unused-entry",
      "claude",
      "project-ref",
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        last_assistant_message: "Do not capture this turn.",
        cwd: project,
      },
      { deliver: false },
    );
    expect(await pendingRows(dataDir)).toHaveLength(0);

    // The flag was consumed: the next normal turn captures again.
    await clientHook(
      fixture.config,
      "unused-entry",
      "claude",
      "project-ref",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt: "normal tur",
        cwd: project,
      },
      { deliver: false },
    );
    await clientHook(
      fixture.config,
      "unused-entry",
      "claude",
      "project-ref",
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        last_assistant_message: "Captured checkpoint.",
        cwd: project,
      },
      { deliver: false },
    );
    const rows = await pendingRows(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent, stop-hook continuation and unregistered tool events never capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-guards-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await writeInstallationBinding(dataDir, {
    client: "codex",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir);
  try {
    const base = {
      session_id: "session-1",
      last_assistant_message: "must not be captured",
      cwd: project,
    };
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      { ...base, hook_event_name: "Stop", agent_id: "sub-1" },
      { deliver: false },
    );
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      { ...base, hook_event_name: "Stop", stop_hook_active: true },
      { deliver: false },
    );
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      { ...base, hook_event_name: "PostToolUse" },
      { deliver: false },
    );
    expect(await pendingRows(dataDir)).toHaveLength(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lifecycle events heartbeat without capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-session-event-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await writeInstallationBinding(dataDir, {
    client: "codex",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir);
  try {
    const result = await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      {
        hook_event_name: "SessionStart",
        session_id: "session-1",
        source: "startup",
        cwd: project,
      },
      { deliver: false },
    );
    expect(result).toEqual({});
    expect(await pendingRows(dataDir)).toHaveLength(0);
    const heartbeat = fixture.received.find(
      (entry) => entry.url === "/api/installations",
    );
    expect(heartbeat?.body.event).toBe("SessionStart");
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing session identity skips capture instead of an 'unknown' pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-memory-session-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await writeInstallationBinding(dataDir, {
    client: "codex",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir);
  try {
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      {
        hook_event_name: "Stop",
        session_id: "unknown",
        last_assistant_message: "must not be captured",
        cwd: project,
      },
      { deliver: false },
    );
    expect(await pendingRows(dataDir)).toHaveLength(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
