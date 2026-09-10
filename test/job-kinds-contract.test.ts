import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ForgeWorker, type JobHandler } from "../src/jobs/worker.js";
import {
  defaultJobKinds,
  type JobKindDefinition,
} from "../src/domain/job-kinds.js";
import { ForgeError } from "../src/domain/errors.js";

/**
 * Issue #32: a statically declared, model-free, non-skill kind must flow
 * through the same real accept -> claim -> handler -> result/audit chain as
 * the skill kind, without a skill provider, PackageStore or SPR tools.
 * `fixture_reconcile` is test-only (declared here, never in production).
 */
const fixtureKind: JobKindDefinition = {
  kind: "fixture_reconcile",
  payload: z
    .object({
      note: z.string().min(1).max(200),
      units: z.number().int().min(0).default(0),
    })
    .strict(),
  skillProfile: false,
};
type TestKind = "skill_evolve" | "fixture_reconcile";
const kinds: Readonly<Record<TestKind, JobKindDefinition>> = {
  ...defaultJobKinds,
  fixture_reconcile: fixtureKind,
};
const fixturePayload = (note: string, units?: number) => ({
  note,
  ...(units === undefined ? {} : { units }),
});

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

async function auditDetails(
  storage: DatabaseHandle,
  tenantId: string,
  kind: string,
) {
  const rows = await storage.db
    .selectFrom("audit_events")
    .select("detail")
    .where("tenant_id", "=", tenantId)
    .where("kind", "=", kind)
    .execute();
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`P2 #32 non-skill kind shares accept/claim/audit guarantees and runs a distinct handler (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-kinds-"));
    // Each backend runs on its own database (the Postgres case creates an
    // ephemeral one) so the real worker can never claim another suite's
    // leftover runs and handler-selection assertions stay exact.
    let postgresUrl: string | undefined;
    let admin: PgClient | undefined;
    const databaseName = `forge_kinds_${crypto.randomUUID().replaceAll("-", "")}`;
    if (backend === "postgres") {
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const storage = await openDatabase({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
    let worker: ForgeWorker<TestKind> | undefined;
    try {
      const identities = new IdentityService(storage.db);
      const owner = await identities.bootstrapLocal();
      const project = await identities.createProject(owner, "Job kinds");
      // Two explicit policies: the skill kind owns the evolution gate, the
      // fixture kind must not care about it.
      const disabledQueue = new JobQueue<TestKind>(
        storage,
        { evolutionEnabled: false },
        kinds,
      );
      const queue = new JobQueue<TestKind>(storage, {}, kinds);

      // 1. Skill kind is rejected by its own gate; the non-skill kind is
      // accepted with no provider profile and no skill package at all.
      const fixtureKey = crypto.randomUUID();
      const providersBefore = await storage.db
        .selectFrom("provider_profiles")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      await expect(
        disabledQueue.accept(owner, {
          projectId: project.id,
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { summary: "gate" },
        }),
      ).rejects.toMatchObject({ code: "evolution_disabled" });
      const fixture = await disabledQueue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: fixtureKey,
        payload: fixturePayload("first", 2),
      });
      expect(fixture.status).toBe("accepted");
      expect(fixture.run.kind).toBe("fixture_reconcile");
      expect(fixture.run.config_json).not.toContain("providerProfile");
      const providersAfter = await storage.db
        .selectFrom("provider_profiles")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(Number(providersAfter.n)).toBe(Number(providersBefore.n));
      expect(
        await storage.db
          .selectFrom("skills")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .where("project_id", "=", project.id)
          .execute(),
      ).toHaveLength(0);
      const skillKey = crypto.randomUUID();
      const skill = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: skillKey,
        payload: { summary: "skill side" },
      });
      expect(skill.status).toBe("accepted");

      // 2. Payload validation is the same common gate for both kinds: the
      // kind definition owns the schema, accept() rejects before insert.
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "fixture_reconcile",
          key: crypto.randomUUID(),
          payload: fixturePayload(""),
        }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "fixture_reconcile",
          key: crypto.randomUUID(),
          payload: { note: "type", units: 1.5 },
        }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "fixture_reconcile",
          key: crypto.randomUUID(),
          payload: { note: "extra", unexpected: true },
        }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      const beforeInvalid = await storage.db
        .selectFrom("runs")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .where("project_id", "=", project.id)
        .executeTakeFirstOrThrow();
      expect(Number(beforeInvalid.n)).toBe(2);

      // 3. Permission is resolved from membership, not from the kind.
      const intruder = {
        tenantId: owner.tenantId,
        userId: crypto.randomUUID(),
      };
      await expect(
        queue.accept(intruder, {
          projectId: project.id,
          kind: "fixture_reconcile",
          key: crypto.randomUUID(),
          payload: fixturePayload("denied"),
        }),
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });
      await expect(
        queue.accept(intruder, {
          projectId: project.id,
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { summary: "denied" },
        }),
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });

      // 4. Idempotency is shared: duplicate returns the original row,
      // changed input conflicts — for both kinds.
      const duplicate = await disabledQueue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: fixtureKey,
        payload: fixturePayload("first", 2),
      });
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.run.id).toBe(fixture.run.id);
      await expect(
        disabledQueue.accept(owner, {
          projectId: project.id,
          kind: "fixture_reconcile",
          key: fixtureKey,
          payload: fixturePayload("changed"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const skillDuplicate = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: skillKey,
        payload: { summary: "skill side" },
      });
      expect(skillDuplicate.status).toBe("duplicate");
      expect(skillDuplicate.run.id).toBe(skill.run.id);
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "skill_evolve",
          key: skillKey,
          payload: { summary: "changed" },
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      // 5. Audit wall receives the common lifecycle event for both kinds.
      const acceptedAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.accepted",
      );
      expect(
        acceptedAudit.filter((detail) => detail.run_id === fixture.run.id),
      ).toHaveLength(1);
      expect(
        acceptedAudit.filter((detail) => detail.run_id === skill.run.id),
      ).toHaveLength(1);
      expect(acceptedAudit.map((detail) => detail.kind).sort()).toEqual(
        expect.arrayContaining(["fixture_reconcile", "skill_evolve"]),
      );

      // 6. Cancellation is shared and audited for both kinds.
      const cancelFixture = await queue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: crypto.randomUUID(),
        payload: fixturePayload("cancel fixture"),
      });
      const cancelSkill = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "cancel skill" },
      });
      await queue.cancel(owner, cancelFixture.run.id);
      await queue.cancel(owner, cancelSkill.run.id);
      expect((await queue.get(owner, cancelFixture.run.id)).state).toBe(
        "cancelled",
      );
      expect((await queue.get(owner, cancelSkill.run.id)).state).toBe(
        "cancelled",
      );
      const cancelledAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.cancelled",
      );
      expect(
        cancelledAudit.filter(
          (detail) => detail.run_id === cancelFixture.run.id,
        ),
      ).toHaveLength(1);
      expect(
        cancelledAudit.filter((detail) => detail.run_id === cancelSkill.run.id),
      ).toHaveLength(1);

      // 7. Deadline expiry is enforced by the shared claim path for both.
      const deadlineFixture = await queue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: crypto.randomUUID(),
        payload: fixturePayload("deadline fixture"),
        deadlineMs: 100,
      });
      const deadlineSkill = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "deadline skill" },
        deadlineMs: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        await queue.claim("deadline-worker", 1000, "fixture_reconcile", {
          tenantId: owner.tenantId,
          runId: deadlineFixture.run.id,
        }),
      ).toBeNull();
      expect(
        await queue.claim("deadline-worker", 1000, "skill_evolve", {
          tenantId: owner.tenantId,
          runId: deadlineSkill.run.id,
        }),
      ).toBeNull();
      for (const expired of [deadlineFixture, deadlineSkill]) {
        const row = await queue.get(owner, expired.run.id);
        expect(row.state).toBe("failed");
        expect(row.error_code).toBe("deadline_or_attempt_limit");
      }
      const finishedAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.finished",
      );
      expect(
        finishedAudit.filter(
          (detail) => detail.run_id === deadlineFixture.run.id,
        )[0],
      ).toMatchObject({
        state: "failed",
        error_code: "deadline_or_attempt_limit",
      });
      expect(
        finishedAudit.filter(
          (detail) => detail.run_id === deadlineSkill.run.id,
        )[0],
      ).toMatchObject({
        state: "failed",
        error_code: "deadline_or_attempt_limit",
      });

      // 8. Real worker execution: the fixture kind is dispatched to its own
      // handler, while the remaining skill_evolve run goes to the positional
      // (default/skill) handler exactly once and fails on its own missing
      // model — proving typed handler selection in both directions.
      const skillCalls: string[] = [];
      const fixtureCalls: string[] = [];
      const skillHandler: JobHandler = async (run) => {
        skillCalls.push(run.id);
        throw new ForgeError("model_missing", "Skill modeli yok.", 422);
      };
      const fixtureHandler: JobHandler = async (run) => {
        fixtureCalls.push(run.id);
        const input = JSON.parse(run.input_json) as {
          note: string;
          units: number;
        };
        if (input.note === "fail")
          throw new ForgeError("fixture_failure", "Fixture hatası.", 422);
        return {
          state: "completed",
          result: { reconciled: input.note, units: input.units },
        };
      };
      worker = new ForgeWorker(queue, skillHandler, {
        ...(postgresUrl ? { postgresUrl } : {}),
        pollMs: 20,
        handlers: { fixture_reconcile: fixtureHandler },
      });
      await worker.start();
      const ok = await queue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: crypto.randomUUID(),
        payload: fixturePayload("execute", 7),
      });
      const bad = await queue.accept(owner, {
        projectId: project.id,
        kind: "fixture_reconcile",
        key: crypto.randomUUID(),
        payload: fixturePayload("fail"),
      });
      const settled = await until(async () => {
        const [a, b, c] = [
          await queue.get(owner, ok.run.id),
          await queue.get(owner, bad.run.id),
          await queue.get(owner, skill.run.id),
        ];
        return (
          a.state === "completed" &&
          b.state === "failed" &&
          c.state === "failed"
        );
      }, 20_000);
      expect(settled).toBe(true);
      expect(
        JSON.parse((await queue.get(owner, ok.run.id)).result_json!),
      ).toMatchObject({ reconciled: "execute", units: 7 });
      expect((await queue.get(owner, bad.run.id)).error_code).toBe(
        "fixture_failure",
      );
      // Exactly one skill dispatch, and it never ran a fixture run.
      expect(skillCalls).toEqual([skill.run.id]);
      expect((await queue.get(owner, skill.run.id)).error_code).toBe(
        "model_missing",
      );
      // The run accepted under evolutionEnabled=false also executed, and no
      // fixture run ever reached the positional skill handler.
      expect(fixtureCalls.sort()).toEqual(
        [fixture.run.id, bad.run.id, ok.run.id].sort(),
      );
      expect((await queue.get(owner, fixture.run.id)).state).toBe("completed");
      const okAttempts = await queue.attempts(owner, ok.run.id);
      expect(okAttempts.items).toHaveLength(1);
      expect(okAttempts.items[0]!.result).toBe("completed");
      const badAttempts = await queue.attempts(owner, bad.run.id);
      expect(badAttempts.items[0]!.result).toBe("failed");
      const finalAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.finished",
      );
      expect(
        finalAudit.filter((detail) => detail.run_id === ok.run.id)[0],
      ).toMatchObject({ state: "completed", kind: "fixture_reconcile" });
      expect(
        finalAudit.filter((detail) => detail.run_id === bad.run.id)[0],
      ).toMatchObject({
        state: "failed",
        error_code: "fixture_failure",
        kind: "fixture_reconcile",
      });
      expect(
        finalAudit.filter((detail) => detail.run_id === skill.run.id)[0],
      ).toMatchObject({
        state: "failed",
        error_code: "model_missing",
        kind: "skill_evolve",
      });
      if (backend === "postgres") {
        // #23 transport: the outbox row is owned/delivered by the sweep, the
        // run was claimed exactly once through pg-boss, and no skill provider
        // was needed for the non-skill kind.
        const outbox = await storage.db
          .selectFrom("outbox")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .where("run_id", "=", ok.run.id)
          .executeTakeFirstOrThrow();
        expect(outbox.delivered).toBe(1);
        expect(Number(outbox.delivery_attempts)).toBeGreaterThanOrEqual(1);
        const attempts = await storage.db
          .selectFrom("run_attempts")
          .select(["worker_id", "result"])
          .where("tenant_id", "=", owner.tenantId)
          .where("run_id", "=", ok.run.id)
          .execute();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]!.worker_id).toBe(worker.id);
      }
    } finally {
      await worker?.stop();
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
