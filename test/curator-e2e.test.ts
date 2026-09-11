import { test, expect } from "bun:test";
import { ForgeWorker } from "../src/jobs/worker.js";
import {
  setupCurator,
  scriptedStream,
  toolMessage,
  until,
} from "./curator-fixtures.test.js";

/**
 * Issue #39 acceptance: a real `memory_curate` job runs through the queue,
 * the provider adapter (fake stream), the narrow tools, staging, policy and
 * the M02 commit path. A mock decision object alone would not prove this.
 */
test("real memory_curate job: tools -> staging -> auto policy -> commit", async () => {
  const fixture = await setupCurator();
  const calls = { calls: 0 };
  const script = [
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
          title: "Koyu tema tercihi",
          body: "Kullanıcı koyu temayı tercih ediyor.",
          rationale: "Kullanıcı beyanı kaynakta açıkça yazıyor.",
          source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
          claim: { user_declared: true },
        },
      },
    ]),
    toolMessage([
      {
        name: "finalize",
        args: { outcome: "proposed", reason: "Bir düşük riskli tercih adayı." },
      },
    ]),
  ];
  const accepted = await fixture.accept(
    {
      space_id: fixture.spaceId,
      source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
    },
    "curator-e2e-1",
  );
  const worker = new ForgeWorker(
    fixture.queue,
    fixture.handler(scriptedStream(script, calls)),
  );
  await worker.start();
  try {
    const run = await until(async () => {
      const current = await fixture.queue.get(fixture.owner, accepted.run.id);
      return ["completed", "no_op", "rejected", "failed"].includes(
        current.state,
      )
        ? current
        : null;
    });
    expect(run.state).toBe("completed");
    expect(calls.calls).toBe(3);

    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .where("run_id", "=", accepted.run.id)
      .execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe("applied");
    expect(changes[0]!.claim_class).toBe("user_declaration");
    expect(changes[0]!.applied_revision).toBe(1);

    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("space_id", "=", fixture.spaceId)
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Koyu tema tercihi");

    const extraction = await fixture.storage.db
      .selectFrom("memory_curator_extractions")
      .selectAll()
      .where("run_id", "=", accepted.run.id)
      .executeTakeFirstOrThrow();
    expect(extraction.status).toBe("ready");
    const usage = JSON.parse(extraction.usage_json!);
    expect(usage.calls).toBe(3);
    expect(usage.total_tokens).toBe(54);
    expect(usage.tool_result_bytes).toBeGreaterThan(0);
    expect(usage.cost_micros).toBe(0);
    expect(usage.model_revision).toBe(1);
  } finally {
    await worker.stop();
    await fixture.close();
  }
});

test("a missing memory model binding is a visible no-op, never a fallback", async () => {
  const fixture = await setupCurator({ configureProfile: false });
  const calls = { calls: 0 };
  try {
    const accepted = await fixture.accept(
      {
        space_id: fixture.spaceId,
        source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      },
      "curator-not-ready",
    );
    const outcome = await fixture.handler(scriptedStream([], calls))(
      accepted.run,
      new AbortController().signal,
    );
    expect(outcome.state).toBe("no_op");
    expect((outcome.result as { status: string }).status).toBe(
      "model_not_ready",
    );
    expect(calls.calls).toBe(0);
    const extraction = await fixture.storage.db
      .selectFrom("memory_curator_extractions")
      .selectAll()
      .where("run_id", "=", accepted.run.id)
      .executeTakeFirstOrThrow();
    expect(extraction.status).toBe("not_ready");
    expect(extraction.error_code).toBe("model_not_ready");
  } finally {
    await fixture.close();
  }
});

test("an unchanged source replay never calls the model again", async () => {
  const fixture = await setupCurator();
  const calls = { calls: 0 };
  const script = [
    toolMessage([
      {
        name: "propose_patch",
        args: {
          operation: "create",
          kind: "preference",
          title: "Koyu tema tercihi",
          body: "Kullanıcı koyu temayı tercih ediyor.",
          rationale: "Kullanıcı beyanı.",
          source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
          claim: { user_declared: true },
        },
      },
    ]),
    toolMessage([
      { name: "finalize", args: { outcome: "proposed", reason: "aday" } },
    ]),
  ];
  const handler = fixture.handler(scriptedStream(script, calls));
  try {
    const first = await fixture.accept(
      {
        space_id: fixture.spaceId,
        source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      },
      "curator-replay-1",
    );
    const firstClaim = await fixture.queue.claim(
      "curator-test-worker",
      15000,
      "memory_curate",
    );
    expect(firstClaim?.id).toBe(first.run.id);
    const firstOutcome = await handler(
      firstClaim!,
      new AbortController().signal,
    );
    expect(firstOutcome.state).toBe("completed");
    expect(calls.calls).toBe(2);

    const second = await fixture.accept(
      {
        space_id: fixture.spaceId,
        source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      },
      "curator-replay-2",
    );
    expect(second.status).toBe("accepted");
    const secondClaim = await fixture.queue.claim(
      "curator-test-worker",
      15000,
      "memory_curate",
    );
    const secondOutcome = await handler(
      secondClaim!,
      new AbortController().signal,
    );
    expect(secondOutcome.state).toBe("no_op");
    expect((secondOutcome.result as { status: string }).status).toBe("cached");
    expect(calls.calls).toBe(2);

    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("space_id", "=", fixture.spaceId)
      .execute();
    expect(notes).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
