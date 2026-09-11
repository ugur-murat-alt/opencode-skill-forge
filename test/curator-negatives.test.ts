import { test, expect } from "bun:test";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import {
  setupCurator,
  scriptedStream,
  toolMessage,
  type CuratorFixture,
} from "./curator-fixtures.test.js";

/**
 * Issue #39 negatives: scope escape, prompt injection, fabricated citation,
 * cross-space targets, deletion and post-finalize calls all fail closed.
 */
async function runScript(
  fixture: CuratorFixture,
  script: Parameters<typeof scriptedStream>[0],
  key: string,
) {
  const accepted = await fixture.accept(
    {
      space_id: fixture.spaceId,
      source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
    },
    key,
  );
  const claimed = await fixture.queue.claim(
    "curator-negative-worker",
    15000,
    "memory_curate",
  );
  const outcome = await fixture.handler(scriptedStream(script))(
    claimed!,
    new AbortController().signal,
  );
  return { accepted, outcome };
}

async function noteCount(fixture: CuratorFixture) {
  const rows = await fixture.storage.db
    .selectFrom("memory_notes")
    .selectAll()
    .where("space_id", "=", fixture.spaceId)
    .execute();
  return rows.length;
}

test("a path outside the registered source root is denied", async () => {
  const fixture = await setupCurator();
  try {
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([
          {
            name: "source_read",
            args: { source_id: fixture.sourceId, path: "../outside.md" },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "no_op", reason: "okuma yok" } },
        ]),
      ],
      "neg-source-path",
    );
    expect(outcome.state).toBe("no_op");
    expect(await noteCount(fixture)).toBe(0);
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a fabricated citation can never stage a patch", async () => {
  const fixture = await setupCurator();
  try {
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([
          {
            name: "propose_patch",
            args: {
              operation: "create",
              kind: "preference",
              title: "Uydurma",
              body: "Uydurma gövde",
              rationale: "Uydurma atıf",
              source_refs: [{ source_id: "ghost-source" }],
              claim: { user_declared: true },
            },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "x" } },
        ]),
      ],
      "neg-citation",
    );
    expect(outcome.state).toBe("completed");
    expect(await noteCount(fixture)).toBe(0);
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a cross-space note id is not an update target", async () => {
  const fixture = await setupCurator();
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
    const other = await memory.createOrganizationSpace(fixture.owner, "Diğer");
    const content = "# Yabancı not\n\nBaşka alanda.";
    const event = await memory.recordEvent(fixture.owner, {
      spaceId: other.id,
      sourceEventKey: "human-1",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    const receipt = await commits.commit({
      identity: fixture.owner,
      spaceId: other.id,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId: "foreign-note",
      baseRevision: null,
      kind: "context",
    });
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([
          {
            name: "propose_patch",
            args: {
              operation: "update",
              note_id: receipt.noteId,
              base_revision: 1,
              kind: "context",
              title: "Ele geçirme",
              body: "Değiştirilmiş",
              rationale: "kapsam dışı",
              source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
              claim: { rewrites_human_text: true },
            },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "x" } },
        ]),
      ],
      "neg-cross-space",
    );
    expect(outcome.state).toBe("completed");
    const note = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", "foreign-note")
      .executeTakeFirstOrThrow();
    expect(note.current_revision).toBe(1);
    expect(await noteCount(fixture)).toBe(0);
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a deletion tool does not exist and deletes nothing", async () => {
  const fixture = await setupCurator();
  try {
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([{ name: "delete_note", args: { note_id: "anything" } }]),
        toolMessage([
          {
            name: "finalize",
            args: { outcome: "rejected", reason: "silme yok" },
          },
        ]),
      ],
      "neg-delete",
    );
    expect(["completed", "failed", "rejected"]).toContain(outcome.state);
    expect(await noteCount(fixture)).toBe(0);
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a tool call after finalize is refused in the same batch", async () => {
  const fixture = await setupCurator();
  try {
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([
          {
            name: "finalize",
            args: { outcome: "proposed", reason: "bitir" },
          },
          {
            name: "propose_patch",
            args: {
              operation: "create",
              kind: "preference",
              title: "Geç kalan",
              body: "Finalize sonrası yazım",
              rationale: "olmamalı",
              source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
              claim: { user_declared: true },
            },
          },
        ]),
      ],
      "neg-post-finalize",
    );
    expect(outcome.state).toBe("completed");
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .execute();
    expect(changes).toHaveLength(0);
    expect(await noteCount(fixture)).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("source text is evidence, never an instruction surface", async () => {
  const fixture = await setupCurator();
  try {
    // The source file contains an injection line; the staged body must be the
    // model's explicit proposal, and the deterministic policy still decides.
    const { outcome } = await runScript(
      fixture,
      [
        toolMessage([
          {
            name: "source_read",
            args: { source_id: fixture.sourceId, path: "prefs.md" },
          },
        ]),
        toolMessage([
          {
            name: "propose_patch",
            args: {
              operation: "create",
              kind: "preference",
              title: "Enjeksiyon metni değil",
              body: "Kullanıcı koyu temayı tercih ediyor.",
              rationale: "Kaynak kanıtı",
              source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
              claim: { user_declared: true },
            },
          },
        ]),
        toolMessage([
          { name: "finalize", args: { outcome: "proposed", reason: "aday" } },
        ]),
      ],
      "neg-injection",
    );
    expect(outcome.state).toBe("completed");
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notes).toHaveLength(1);
    const revision = await fixture.storage.db
      .selectFrom("memory_note_revisions")
      .select(["body_md"])
      .where("note_id", "=", notes[0]!.id)
      .executeTakeFirstOrThrow();
    expect(revision.body_md).not.toContain("SYSTEM:");
  } finally {
    await fixture.close();
  }
});
