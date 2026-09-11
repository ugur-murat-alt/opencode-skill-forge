import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { CuratorReview } from "../src/memory/curator/review.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import {
  serializeMemoryDocument,
  type MemoryEdge,
  type MemoryRecord,
} from "../src/domain/memory.js";

/**
 * Issue #39 (M06) phase B: manual curator proposal review. These tests use
 * the real M02 commit path; they assert state transitions, CAS/stale marking,
 * idempotent replay, authorization and audit.
 */

async function bootstrap() {
  const root = await mkdtemp(join(tmpdir(), "forge-curator-review-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const memory = new MemoryService(storage.db, identities, vaultRoot(root));
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vaultRoot(root),
    service: memory,
    index: new MemoryIndexService(storage.db, vaultRoot(root), memory),
  });
  const review = new CuratorReview({
    db: storage.db,
    service: memory,
    commits,
  });
  const space = await memory.ensureSpace(owner, { type: "personal" });
  return { root, storage, identities, owner, memory, commits, review, space };
}

function record(input: {
  noteId: string;
  spaceId: string;
  title: string;
  body?: string;
  kind?: string;
  edges?: MemoryEdge[];
}): MemoryRecord {
  const now = Date.now();
  return {
    formatVersion: 1,
    noteId: input.noteId,
    spaceId: input.spaceId,
    kind: (input.kind ?? "note") as MemoryRecord["kind"],
    title: input.title,
    summary: null,
    lifecycle: "active",
    pinned: false,
    taskStatus: null,
    verification: "declared",
    stale: null,
    sources: [],
    edges: input.edges ?? [],
    createdAt: now,
    observedAt: now,
    validFrom: null,
    validUntil: null,
    baseRevision: null,
    revision: null,
    unknown: {},
    body: `${input.body ?? "gövde"}\n`,
  };
}

async function seedNote(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  input: {
    noteId: string;
    spaceId: string;
    title: string;
    body?: string;
    kind?: string;
    edges?: MemoryEdge[];
    baseRevision?: number | null;
    eventKey: string;
  },
) {
  const content = serializeMemoryDocument(record(input));
  const event = await ctx.memory.recordEvent(ctx.owner, {
    spaceId: input.spaceId,
    sourceEventKey: input.eventKey,
    sourceKind: "manual",
    contentHash: sha256Hex(content),
  });
  return ctx.commits.commit({
    identity: ctx.owner,
    spaceId: input.spaceId,
    eventId: event.event.id,
    sourceKind: "manual",
    content,
    noteId: input.noteId,
    baseRevision: input.baseRevision ?? null,
    kind: input.kind,
  });
}

let counter = 0;
function changeRow(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  counter += 1;
  return {
    id: `chg-${counter}`,
    tenant_id: ctx.owner.tenantId,
    space_id: ctx.space.id,
    extraction_id: null,
    run_id: "run-review-test",
    mode: "proposal",
    operation: "create",
    note_id: null,
    base_revision: null,
    kind: "preference",
    title: "Küratör tercihi",
    summary: null,
    body_md: "tercih gövdesi",
    rationale: "kaynak kanıtı",
    source_refs_json: JSON.stringify([
      { source_id: "src-1", path: "a.md", section: null, hash: "a".repeat(64) },
    ]),
    claim_class: "user_declaration",
    relation: null,
    target_note_id: null,
    confidence_micros: null,
    risk: "low",
    state: "proposed",
    applied_revision: null,
    reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function insertChange(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  overrides: Record<string, unknown> = {},
) {
  const row = changeRow(ctx, overrides);
  await ctx.storage.db
    .insertInto("memory_curator_changes")
    .values(row as never)
    .execute();
  return row;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

describe("issue #39 curator proposal review", () => {
  test("approving a create proposal commits a note and marks the row applied", async () => {
    const ctx = await bootstrap();
    try {
      const row = await insertChange(ctx);
      const result = await ctx.review.approve(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(result.state).toBe("applied");
      expect(result.revision).toBe(1);
      const note = await ctx.storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", result.note_id!)
        .executeTakeFirstOrThrow();
      expect(note.title).toBe("Küratör tercihi");
      const revision = await ctx.storage.db
        .selectFrom("memory_note_revisions")
        .select(["kind", "sources_json", "body_md"])
        .where("note_id", "=", result.note_id!)
        .where("revision", "=", 1)
        .executeTakeFirstOrThrow();
      expect(revision.kind).toBe("preference");
      expect(JSON.parse(revision.sources_json)).toHaveLength(1);
      expect(revision.body_md).toContain("tercih gövdesi");
      const stored = await ctx.storage.db
        .selectFrom("memory_curator_changes")
        .select(["state", "applied_revision", "reason"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(stored.state).toBe("applied");
      expect(stored.applied_revision).toBe(1);
      expect(stored.reason).toBeNull();
      const audit = await ctx.storage.db
        .selectFrom("audit_events")
        .select(["kind", "detail"])
        .where("tenant_id", "=", ctx.owner.tenantId)
        .where("kind", "=", "memory.curator.proposal.approved")
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.detail)).toMatchObject({
        change_id: row.id,
        revision: 1,
      });
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("an update proposal advances the note revision and keeps its axes", async () => {
    const ctx = await bootstrap();
    try {
      await seedNote(ctx, {
        noteId: "note-a",
        spaceId: ctx.space.id,
        title: "Eski başlık",
        eventKey: "seed-a",
      });
      const row = await insertChange(ctx, {
        operation: "update",
        note_id: "note-a",
        base_revision: 1,
        kind: "decision",
        title: "Yeni başlık",
        body_md: "yeni gövde",
      });
      const result = await ctx.review.approve(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(result.revision).toBe(2);
      const revision = await ctx.storage.db
        .selectFrom("memory_note_revisions")
        .select(["kind", "title", "body_md", "metadata_json"])
        .where("note_id", "=", "note-a")
        .where("revision", "=", 2)
        .executeTakeFirstOrThrow();
      expect(revision.kind).toBe("decision");
      expect(revision.title).toBe("Yeni başlık");
      expect(revision.body_md).toContain("yeni gövde");
      // The note lifecycle is preserved: approval never retires the note.
      const metadata = JSON.parse(revision.metadata_json) as {
        record: { lifecycle: string };
      };
      expect(metadata.record.lifecycle).toBe("active");
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("a stale base marks the row stale and refuses with 409", async () => {
    const ctx = await bootstrap();
    try {
      await seedNote(ctx, {
        noteId: "note-b",
        spaceId: ctx.space.id,
        title: "Sürüm 1",
        eventKey: "seed-b1",
      });
      await seedNote(ctx, {
        noteId: "note-b",
        spaceId: ctx.space.id,
        title: "Sürüm 2",
        baseRevision: 1,
        eventKey: "seed-b2",
      });
      const row = await insertChange(ctx, {
        operation: "update",
        note_id: "note-b",
        base_revision: 1,
      });
      const error = (await expectCode(
        ctx.review.approve(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: row.id,
        }),
        "memory_revision_conflict",
      )) as { detail?: { current_revision?: number } };
      expect(error.detail?.current_revision).toBe(2);
      const stored = await ctx.storage.db
        .selectFrom("memory_curator_changes")
        .select(["state", "reason"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(stored.state).toBe("stale");
      expect(stored.reason).toBe("base_revision_conflict");
      const revision = await ctx.storage.db
        .selectFrom("memory_notes")
        .select(["current_revision"])
        .where("id", "=", "note-b")
        .executeTakeFirstOrThrow();
      expect(revision.current_revision).toBe(2);
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("a mismatched expected_revision is refused without touching the note", async () => {
    const ctx = await bootstrap();
    try {
      await seedNote(ctx, {
        noteId: "note-c",
        spaceId: ctx.space.id,
        title: "Temel",
        eventKey: "seed-c",
      });
      const row = await insertChange(ctx, {
        operation: "update",
        note_id: "note-c",
        base_revision: 1,
      });
      await expectCode(
        ctx.review.approve(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: row.id,
          expectedRevision: 99,
        }),
        "memory_revision_conflict",
      );
      const stored = await ctx.storage.db
        .selectFrom("memory_curator_changes")
        .select(["state"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(stored.state).toBe("proposed");
      const note = await ctx.storage.db
        .selectFrom("memory_notes")
        .select(["current_revision"])
        .where("id", "=", "note-c")
        .executeTakeFirstOrThrow();
      expect(note.current_revision).toBe(1);
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("a link proposal adds the typed edge to the source note", async () => {
    const ctx = await bootstrap();
    try {
      await seedNote(ctx, {
        noteId: "link-source",
        spaceId: ctx.space.id,
        title: "Kaynak",
        eventKey: "seed-ls",
      });
      await seedNote(ctx, {
        noteId: "link-target",
        spaceId: ctx.space.id,
        title: "Hedef",
        eventKey: "seed-lt",
      });
      const row = await insertChange(ctx, {
        operation: "link",
        note_id: "link-source",
        target_note_id: "link-target",
        relation: "SUPPORTS",
        base_revision: 1,
        kind: null,
        title: null,
        body_md: null,
        claim_class: "link",
        risk: "medium",
      });
      const result = await ctx.review.approve(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(result.revision).toBe(2);
      const revision = await ctx.storage.db
        .selectFrom("memory_note_revisions")
        .select(["metadata_json"])
        .where("note_id", "=", "link-source")
        .where("revision", "=", 2)
        .executeTakeFirstOrThrow();
      const metadata = JSON.parse(revision.metadata_json) as {
        record: { edges: MemoryEdge[] };
      };
      expect(metadata.record.edges).toEqual([
        { relation: "SUPPORTS", target: "link-target" },
      ]);
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("rejection is recorded, idempotent and never touches the note", async () => {
    const ctx = await bootstrap();
    try {
      await seedNote(ctx, {
        noteId: "note-d",
        spaceId: ctx.space.id,
        title: "Korunan",
        eventKey: "seed-d",
      });
      const row = await insertChange(ctx, {
        operation: "update",
        note_id: "note-d",
        base_revision: 1,
      });
      const first = await ctx.review.reject(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
        reason: "kapsam dışı",
      });
      expect(first.state).toBe("rejected");
      expect(first.reason).toBe("kapsam dışı");
      const second = await ctx.review.reject(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(second.state).toBe("rejected");
      const note = await ctx.storage.db
        .selectFrom("memory_notes")
        .select(["current_revision"])
        .where("id", "=", "note-d")
        .executeTakeFirstOrThrow();
      expect(note.current_revision).toBe(1);
      const audit = await ctx.storage.db
        .selectFrom("audit_events")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("kind", "=", "memory.curator.proposal.rejected")
        .executeTakeFirstOrThrow();
      expect(Number(audit.n)).toBe(2);
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("applied and shadow rows are not actionable", async () => {
    const ctx = await bootstrap();
    try {
      const applied = await insertChange(ctx, {
        state: "applied",
        applied_revision: 3,
      });
      await expectCode(
        ctx.review.approve(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: applied.id,
        }),
        "memory_proposal_state",
      );
      await expectCode(
        ctx.review.reject(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: applied.id,
        }),
        "memory_proposal_state",
      );
      const shadow = await insertChange(ctx, {
        state: "shadow",
        mode: "shadow",
      });
      await expectCode(
        ctx.review.approve(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: shadow.id,
        }),
        "memory_proposal_state",
      );
      await expectCode(
        ctx.review.reject(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: shadow.id,
        }),
        "memory_proposal_state",
      );
      const stale = await insertChange(ctx, {
        state: "stale",
        reason: "base_revision_conflict",
      });
      await expectCode(
        ctx.review.approve(ctx.owner, {
          spaceId: ctx.space.id,
          changeId: stale.id,
        }),
        "memory_proposal_stale",
      );
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("another tenant cannot decide the proposal", async () => {
    const ctx = await bootstrap();
    try {
      await ctx.storage.db
        .insertInto("tenants")
        .values({ id: "t-b", name: "B", created_at: Date.now() })
        .execute();
      await ctx.storage.db
        .insertInto("users")
        .values({
          id: "u-b",
          subject: "u-b",
          display_name: "B",
          created_at: Date.now(),
        })
        .execute();
      await ctx.storage.db
        .insertInto("memberships")
        .values({ tenant_id: "t-b", user_id: "u-b", role: "founder" })
        .execute();
      const intruder: Identity = { tenantId: "t-b", userId: "u-b" };
      const row = await insertChange(ctx, {});
      await expectCode(
        ctx.review.approve(intruder, {
          spaceId: ctx.space.id,
          changeId: row.id,
        }),
        "memory_space_unavailable",
      );
      const stored = await ctx.storage.db
        .selectFrom("memory_curator_changes")
        .select(["state"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(stored.state).toBe("proposed");
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);

  test("a completed event replays without creating a second revision", async () => {
    const ctx = await bootstrap();
    try {
      const row = await insertChange(ctx, {});
      const first = await ctx.review.approve(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(first.revision).toBe(1);
      // Simulate a crash between the commit and the row update: the event is
      // committed but the row is still proposed.
      await ctx.storage.db
        .updateTable("memory_curator_changes")
        .set({ state: "proposed", applied_revision: null })
        .where("id", "=", row.id)
        .execute();
      const replay = await ctx.review.approve(ctx.owner, {
        spaceId: ctx.space.id,
        changeId: row.id,
      });
      expect(replay.state).toBe("applied");
      expect(replay.revision).toBe(1);
      const revisions = await ctx.storage.db
        .selectFrom("memory_note_revisions")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", ctx.owner.tenantId)
        .executeTakeFirstOrThrow();
      expect(Number(revisions.n)).toBe(1);
    } finally {
      await ctx.storage.close();
      await rm(ctx.root, { recursive: true, force: true });
    }
  }, 30000);
});
