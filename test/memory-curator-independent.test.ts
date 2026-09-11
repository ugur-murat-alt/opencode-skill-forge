import { test, expect } from "bun:test";
import { ForgeWorker } from "../src/jobs/worker.js";
import { CuratorTools } from "../src/memory/curator/tools.js";
import {
  setupCurator,
  scriptedStream,
  toolMessage,
  until,
} from "./curator-fixtures.test.js";

/**
 * Bağımsız M06 doğrulaması (8f21d47, b2b4bca, dce2aa8): tek curated profil,
 * dar araç yüzeyi, finalize kapısı, mod merdiveni ve bütçe sınırları.
 *
 * Sahte stream kullanılır; canlı model yok. Çekirdek senaryolarını kopyalamaz:
 * finalize sonrası araç reddi, `off` modunun hiç çağırmaması, sert çağrı
 * bütçesi ve araç yüzeyinin dar listesi burada bağımsız kurulur.
 */

async function runCurator(
  fixture: Awaited<ReturnType<typeof setupCurator>>,
  script: ReturnType<typeof toolMessage>[],
  calls = { calls: 0 },
) {
  const accepted = await fixture.accept(
    {
      space_id: fixture.spaceId,
      source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
    },
    `m06-independent-${crypto.randomUUID()}`,
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
    const changes = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .where("run_id", "=", accepted.run.id)
      .execute();
    return { run, changes, calls };
  } finally {
    await worker.stop();
  }
}

test("finalize sonrası araç çağrılmaz ve ikinci aday yazılmaz", async () => {
  const fixture = await setupCurator();
  try {
    const propose = (title: string) =>
      toolMessage([
        {
          name: "propose_patch",
          args: {
            operation: "create",
            kind: "preference",
            title,
            body: `${title} gövdesi`,
            rationale: "Kullanıcı beyanı.",
            source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
            claim: { user_declared: true },
          },
        },
      ]);
    const script = [
      toolMessage([
        {
          name: "source_read",
          args: { source_id: fixture.sourceId, path: "prefs.md" },
        },
      ]),
      propose("İlk aday"),
      toolMessage([
        {
          name: "finalize",
          args: { outcome: "proposed", reason: "Tek aday yeterli." },
        },
      ]),
      propose("Finalize sonrası aday"),
    ];
    const { run, changes, calls } = await runCurator(fixture, script);
    expect(run.state).toBe("completed");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe("applied");
    expect(calls.calls).toBe(3);
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .select(["title"])
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("İlk aday");
  } finally {
    await fixture.close();
  }
}, 60000);

test("mod off: sağlayıcı hiç çağrılmaz, aday ve not üretilmez", async () => {
  const fixture = await setupCurator({ policy: { memoryCuratorMode: "off" } });
  try {
    const calls = { calls: 0 };
    const accepted = await fixture.accept(
      {
        space_id: fixture.spaceId,
        source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      },
      "m06-off",
    );
    const worker = new ForgeWorker(
      fixture.queue,
      fixture.handler(
        scriptedStream(
          [
            toolMessage([
              {
                name: "propose_patch",
                args: {
                  operation: "create",
                  kind: "preference",
                  title: "Olmamalı",
                  body: "gövde",
                  rationale: "deneme",
                  source_refs: [
                    { source_id: fixture.sourceId, path: "prefs.md" },
                  ],
                  claim: { user_declared: true },
                },
              },
            ]),
          ],
          calls,
        ),
      ),
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
      expect(["no_op", "rejected"]).toContain(run.state);
      expect(calls.calls).toBe(0);
      const changes = await fixture.storage.db
        .selectFrom("memory_curator_changes")
        .selectAll()
        .execute();
      expect(changes).toHaveLength(0);
      expect(
        await fixture.storage.db
          .selectFrom("memory_notes")
          .select(["id"])
          .execute(),
      ).toHaveLength(0);
    } finally {
      await worker.stop();
    }
  } finally {
    await fixture.close();
  }
}, 60000);

test("sert çağrı bütçesi: sınır aşılmaz, kısmi aday uygulanmaz", async () => {
  const fixture = await setupCurator({ policy: { curatorMaxCalls: 1 } });
  try {
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
            title: "Bütçe dışı aday",
            body: "gövde",
            rationale: "İkinci tur gerekir.",
            source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
            claim: { user_declared: true },
          },
        },
      ]),
      toolMessage([
        {
          name: "finalize",
          args: { outcome: "proposed", reason: "bitir" },
        },
      ]),
    ];
    const { run, changes, calls } = await runCurator(fixture, script);
    expect(calls.calls).toBeLessThanOrEqual(1);
    expect(["failed", "no_op", "rejected", "completed"]).toContain(run.state);
    // Tek çağrıda finalize edilmediyse hiçbir aday kalıcı yazılmamış olmalı.
    if (run.state !== "completed")
      expect(
        changes.filter((change) => change.state === "applied"),
      ).toHaveLength(0);
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .select(["id"])
      .execute();
    expect(notes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
}, 60000);

test("auto modda yalnız izinli tür otomatik yazılır; sınır dışı aday öneride kalır", async () => {
  const fixture = await setupCurator();
  try {
    const propose = (kind: string, title: string) =>
      toolMessage([
        {
          name: "propose_patch",
          args: {
            operation: "create",
            kind,
            title,
            body: `${title} gövdesi`,
            rationale: "Kullanıcı beyanı.",
            source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
            claim: { user_declared: true },
          },
        },
      ]);
    const script = [
      propose("note", "Sınır dışı not"),
      propose("preference", "İzinli tercih"),
      toolMessage([
        {
          name: "finalize",
          args: { outcome: "proposed", reason: "İki aday." },
        },
      ]),
    ];
    const { run, changes } = await runCurator(fixture, script);
    expect(run.state).toBe("completed");
    expect(changes).toHaveLength(2);
    const outside = changes.find((change) => change.kind === "note")!;
    const allowed = changes.find((change) => change.kind === "preference")!;
    expect(outside.state).toBe("proposed");
    expect(outside.applied_revision).toBeNull();
    expect(allowed.state).toBe("applied");
    expect(allowed.applied_revision).toBe(1);
    const notes = await fixture.storage.db
      .selectFrom("memory_notes")
      .select(["id", "title"])
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("İzinli tercih");
  } finally {
    await fixture.close();
  }
}, 60000);

test("araç yüzeyi dar: beş ad, finalize sonrası run_closed", async () => {
  const tools = new CuratorTools({} as never, {} as never, {} as never);
  const names = tools.tools().map((tool) => tool.name);
  expect(names.sort()).toEqual(
    [
      "finalize",
      "memory_lookup",
      "propose_link",
      "propose_patch",
      "source_read",
    ].sort(),
  );
  // Host shell/filesystem/SQL aracı yok.
  for (const forbidden of ["shell", "exec", "write", "sql", "read_file"])
    expect(names).not.toContain(forbidden);
  const finalize = tools.tools().find((tool) => tool.name === "finalize")!;
  await finalize.execute("x", { outcome: "no_op", reason: "bitti" });
  expect(tools.finalized).toBe(true);
  const sourceRead = tools.tools().find((tool) => tool.name === "source_read")!;
  let closed: unknown;
  try {
    await sourceRead.execute("y", { source_id: "s" });
  } catch (error) {
    closed = error;
  }
  expect((closed as { code?: string })?.code).toBe("run_closed");
});
