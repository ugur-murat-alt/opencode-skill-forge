import { test, expect } from "bun:test";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import {
  setupCurator,
  scriptedStream,
  toolMessage,
  failingStream,
  hangingStream,
  type CuratorFixture,
} from "./curator-fixtures.test.js";

/**
 * Issue #39 policy/budget/replay: mode transitions never delete data, budget
 * and deadline bounds hold, stale candidates cannot overwrite human text and
 * an unknown provider cost is stored as null.
 */

const VALID_PATCH = (fixture: CuratorFixture) => ({
  operation: "create",
  kind: "preference",
  title: "Tercih",
  body: "Kullanıcı tercihi.",
  rationale: "Kaynak beyanı.",
  source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
  claim: { user_declared: true },
});

async function claimedRun(
  fixture: CuratorFixture,
  key: string,
  payload = {},
  deadlineMs = 30000,
) {
  await fixture.accept(
    {
      space_id: fixture.spaceId,
      source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      ...payload,
    },
    key,
    deadlineMs,
  );
  return (await fixture.queue.claim(
    "curator-policy-worker",
    15000,
    "memory_curate",
  ))!;
}

test("curator mode off blocks runs without deleting existing data", async () => {
  const fixture = await setupCurator();
  try {
    const run = await claimedRun(fixture, "mode-off-1");
    const created = await fixture.handler(
      scriptedStream([
        toolMessage([{ name: "propose_patch", args: VALID_PATCH(fixture) }]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "aday" } },
        ]),
      ]),
    )(run, new AbortController().signal);
    expect(created.state).toBe("completed");
    const notesBefore = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notesBefore).toHaveLength(1);

    const off = await claimedRun(fixture, "mode-off-2", { mode: "off" });
    const offOutcome = await fixture.handler(failingStream)(
      off,
      new AbortController().signal,
    );
    expect(offOutcome.state).toBe("no_op");
    expect((offOutcome.result as { status: string }).status).toBe(
      "curator_off",
    );
    const notesAfter = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notesAfter).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("memoryEnabled=false blocks memory jobs but leaves skill development intact", async () => {
  const fixture = await setupCurator({
    policy: {
      memoryEnabled: false,
      evolutionEnabled: true,
      memoryCuratorMode: "auto",
    },
  });
  try {
    await expect(
      fixture.accept(
        {
          space_id: fixture.spaceId,
          source_refs: [{ source_id: fixture.sourceId }],
        },
        "disabled-curate",
      ),
    ).rejects.toThrow();
    const project = await new IdentityService(fixture.storage.db).createProject(
      fixture.owner,
      "Skill projesi",
    );
    const skill = await fixture.queue.accept(fixture.owner, {
      scope: { type: "project", projectId: project.id },
      kind: "skill_evolve",
      key: "skill-still-works",
      payload: { summary: "x" },
    });
    expect(skill.status).toBe("accepted");
  } finally {
    await fixture.close();
  }
});

test("maxCalls caps the model loop and discards unfinalized proposals", async () => {
  const fixture = await setupCurator({
    policy: { curatorMaxCalls: 1 },
  });
  try {
    const run = await claimedRun(fixture, "budget-1");
    const outcome = await fixture.handler(
      scriptedStream([
        toolMessage([{ name: "propose_patch", args: VALID_PATCH(fixture) }]),
      ]),
    )(run, new AbortController().signal);
    expect(outcome.state).toBe("failed");
    expect((outcome.result as { usage: { calls: number } }).usage.calls).toBe(
      1,
    );
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe("rejected");
  } finally {
    await fixture.close();
  }
});

test("the proposal limit is a hard bound", async () => {
  const fixture = await setupCurator({
    policy: { memoryCuratorMode: "manual", curatorMaxProposals: 2 },
  });
  try {
    const run = await claimedRun(fixture, "limit-1");
    const outcome = await fixture.handler(
      scriptedStream([
        toolMessage([
          { name: "propose_patch", args: VALID_PATCH(fixture) },
          {
            name: "propose_patch",
            args: { ...VALID_PATCH(fixture), title: "T2" },
          },
          {
            name: "propose_patch",
            args: { ...VALID_PATCH(fixture), title: "T3" },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "x" } },
        ]),
      ]),
    )(run, new AbortController().signal);
    expect(outcome.state).toBe("completed");
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("a deadline cancels the run with no writes", async () => {
  const fixture = await setupCurator();
  try {
    const run = await claimedRun(fixture, "deadline-1", {}, 500);
    const started = Date.now();
    const outcome = await fixture.handler(hangingStream)(
      run,
      new AbortController().signal,
    );
    expect(Date.now() - started).toBeLessThan(10000);
    expect(["failed", "cancelled"]).toContain(outcome.state);
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notes).toHaveLength(0);
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("shadow mode records candidates but never applies them", async () => {
  const fixture = await setupCurator({
    policy: { memoryCuratorMode: "shadow" },
  });
  try {
    const run = await claimedRun(fixture, "shadow-1");
    const outcome = await fixture.handler(
      scriptedStream([
        toolMessage([{ name: "propose_patch", args: VALID_PATCH(fixture) }]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "x" } },
        ]),
      ]),
    )(run, new AbortController().signal);
    expect(outcome.state).toBe("completed");
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe("shadow");
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a stale candidate cannot overwrite newer human text", async () => {
  const fixture = await setupCurator({
    policy: { memoryCuratorMode: "manual" },
  });
  try {
    const memory = new MemoryService(
      fixture.storage.db,
      undefined,
      vaultRoot(fixture.root),
    );
    const commits = new MemoryCommitService({
      db: fixture.storage.db,
      vaultRoot: vaultRoot(fixture.root),
      service: memory,
    });
    const content = "# İnsan notu\n\nÖzgün metin.";
    const event = await memory.recordEvent(fixture.owner, {
      spaceId: fixture.spaceId,
      sourceEventKey: "human-note-1",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    const receipt = await commits.commit({
      identity: fixture.owner,
      spaceId: fixture.spaceId,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId: "human-note",
      baseRevision: null,
      kind: "note",
    });
    expect(receipt.revision).toBe(1);
    const run = await claimedRun(fixture, "stale-1");
    const outcome = await fixture.handler(
      scriptedStream([
        toolMessage([
          {
            name: "propose_patch",
            args: {
              operation: "update",
              note_id: "human-note",
              base_revision: 0,
              kind: "note",
              title: "İnsan notu",
              body: "Model değişikliği",
              rationale: "bayat taban",
              source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
              claim: { rewrites_human_text: true },
            },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "x" } },
        ]),
      ]),
    )(run, new AbortController().signal);
    expect(outcome.state).toBe("completed");
    const change = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(change.state).toBe("stale");
    expect(change.reason).toBe("base_revision_conflict");
    const note = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", "human-note")
      .executeTakeFirstOrThrow();
    expect(note.current_revision).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("an unknown provider cost is stored as null, not zero", async () => {
  const fixture = await setupCurator();
  try {
    const run = await claimedRun(fixture, "cost-unknown");
    const outcome = await fixture.handler(failingStream)(
      run,
      new AbortController().signal,
    );
    expect(outcome.state).toBe("failed");
    const extraction = await fixture.storage.db
      .selectFrom("memory_curator_extractions")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(extraction.status).toBe("failed");
    const usage = JSON.parse(extraction.usage_json!);
    expect(usage.cost_micros).toBeNull();
    expect(usage.calls).toBeGreaterThanOrEqual(1);
  } finally {
    await fixture.close();
  }
});
