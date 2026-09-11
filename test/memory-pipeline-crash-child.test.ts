import { test, expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client as PgClient } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { VaultWriter } from "../src/memory/writer.js";
import { sha256Hex } from "../src/memory/files.js";
import { revisionDir, vaultRoot } from "../src/memory/paths.js";

/**
 * Issue #35 (M02): real child-process kills at the commit interruption
 * points. Point (b): the child is killed after the immutable file was
 * published but before the DB commit; the parent replay must adopt the exact
 * same file. Point (c): the child is killed after the DB commit but before
 * the index marker; replay must complete the marker without a second
 * revision. No in-process hook shortcuts: the child really owns the writer
 * lock and is really SIGKILLed.
 */

async function waitForLine(child: ChildProcess, timeoutMs = 15000) {
  let output = "";
  return new Promise<string>((resolveLine, rejectLine) => {
    const timer = setTimeout(
      () => rejectLine(new Error(`child timeout: ${output}`)),
      timeoutMs,
    );
    child.once("error", rejectLine);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolveLine(output.trim());
      }
    });
  });
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  child.kill("SIGKILL");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await ended;
  } finally {
    clearTimeout(timer);
  }
}

async function openEnv(backend: "sqlite" | "postgres") {
  const root = await mkdtemp(join(tmpdir(), "forge-m02-crash-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  const databaseName = `forge_m02_crash_${crypto.randomUUID().replaceAll("-", "")}`;
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
  return {
    root,
    storage,
    postgresUrl,
    cleanup: async () => {
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#35 a SIGKILLed child at commit points (b)/(c) is replayed safely (${backend})`, async () => {
    const env = await openEnv(backend);
    let child: ChildProcess | undefined;
    try {
      const identities = new IdentityService(env.storage.db);
      const owner = await identities.bootstrapLocal();
      const service = new MemoryService(
        env.storage.db,
        identities,
        vaultRoot(env.root),
      );
      const space = await service.ensureSpace(owner, { type: "personal" });
      const shortLease = () =>
        new VaultWriter(vaultRoot(env.root), { leaseMs: 300 });
      const commits = new MemoryCommitService({
        db: env.storage.db,
        vaultRoot: vaultRoot(env.root),
        service,
        writer: shortLease(),
      });
      const script = join(env.root, "child-commit.ts");
      await writeFile(
        script,
        [
          `import { openDatabase } from ${JSON.stringify(resolve("src/storage/database.ts"))};`,
          `import { MemoryService } from ${JSON.stringify(resolve("src/memory/service.ts"))};`,
          `import { MemoryCommitService } from ${JSON.stringify(resolve("src/memory/commit.ts"))};`,
          `import { VaultWriter } from ${JSON.stringify(resolve("src/memory/writer.ts"))};`,
          `const storage = await openDatabase({ dataDir: process.env.DATA_DIR, postgresUrl: process.env.POSTGRES_URL || undefined });`,
          `const service = new MemoryService(storage.db, undefined, process.env.VAULT);`,
          `const marker = process.env.MARKER;`,
          `const hooks = marker === "PUBLISHED" ? { afterPublish: async () => { console.log("PUBLISHED"); await new Promise(() => {}); } } : { afterCommitBeforeIndex: async () => { console.log("COMMITTED"); await new Promise(() => {}); } };`,
          `const commits = new MemoryCommitService({ db: storage.db, vaultRoot: process.env.VAULT, service, hooks, writer: new VaultWriter(process.env.VAULT, { leaseMs: 300 }) });`,
          `await commits.commit({`,
          `  identity: { tenantId: process.env.TENANT, userId: process.env.USER },`,
          `  spaceId: process.env.SPACE,`,
          `  eventId: process.env.EVENT,`,
          `  sourceKind: "manual",`,
          `  content: Buffer.from(process.env.CONTENT_B64, "base64").toString("utf8"),`,
          `  baseRevision: process.env.BASE_REVISION ? Number(process.env.BASE_REVISION) : null,`,
          `});`,
        ].join("\n"),
      );

      const spawnChild = async (
        eventId: string,
        content: string,
        marker: "PUBLISHED" | "COMMITTED",
        baseRevision?: number,
      ) => {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            DATA_DIR: env.root,
            VAULT: vaultRoot(env.root),
            POSTGRES_URL: env.postgresUrl ?? "",
            TENANT: owner.tenantId,
            USER: owner.userId,
            SPACE: space.id,
            EVENT: eventId,
            CONTENT_B64: Buffer.from(content).toString("base64"),
            MARKER: marker,
            ...(baseRevision !== undefined
              ? { BASE_REVISION: String(baseRevision) }
              : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const line = await waitForLine(child);
        expect(line).toBe(marker);
        await kill(child);
        child = undefined;
        // Kısa lease penceresi geçsin; ölü pid + bayat heartbeat devralınır.
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      };

      const contentFor = (title: string, body: string) =>
        [
          "---",
          "format_version: 1",
          `note_id: ${JSON.stringify("crash-note")}`,
          `memory_space_id: ${JSON.stringify(space.id)}`,
          "kind: note",
          `title: ${JSON.stringify(title)}`,
          "---",
          "",
          body,
          "",
        ].join("\n");

      // (b) dosya yayınlandı, DB öncesi öldürüldü.
      const v1 = contentFor("Sürüm 1", "Kesinti b.");
      const e1 = await service.recordEvent(owner, {
        spaceId: space.id,
        sourceEventKey: "crash-b",
        sourceKind: "manual",
        contentHash: sha256Hex(v1),
      });
      await spawnChild(e1.event.id, v1, "PUBLISHED");
      const pending = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", e1.event.id)
        .executeTakeFirstOrThrow();
      expect(pending.state).toBe("pending");
      const beforeReplay = await readdir(
        revisionDir(vaultRoot(env.root), space.id, "crash-note"),
      );
      expect(beforeReplay).toHaveLength(1);
      const replayed = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e1.event.id,
        sourceKind: "manual",
        content: v1,
      });
      expect(replayed.status).toBe("committed");
      expect(replayed.revision).toBe(1);
      expect(
        (
          await readdir(
            revisionDir(vaultRoot(env.root), space.id, "crash-note"),
          )
        ).sort(),
      ).toEqual(beforeReplay.sort());
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", "crash-note")
          .execute(),
      ).toHaveLength(1);

      // (c) DB commit edildi, indeks işareti öncesi öldürüldü.
      const v2 = contentFor("Sürüm 2", "Kesinti c.");
      const e2 = await service.recordEvent(owner, {
        spaceId: space.id,
        sourceEventKey: "crash-c",
        sourceKind: "manual",
        contentHash: sha256Hex(v2),
      });
      await spawnChild(e2.event.id, v2, "COMMITTED", 1);
      const committed = await env.storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", e2.event.id)
        .executeTakeFirstOrThrow();
      expect(committed.state).toBe("committed");
      expect(committed.indexed_at).toBeNull();
      const replay2 = await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: e2.event.id,
        sourceKind: "manual",
        content: v2,
        baseRevision: 1,
      });
      expect(replay2.status).toBe("duplicate");
      expect(replay2.revision).toBe(2);
      expect(replay2.indexed).toBe(true);
      const event2 = await env.storage.db
        .selectFrom("memory_events")
        .select(["indexed_at"])
        .where("id", "=", e2.event.id)
        .executeTakeFirstOrThrow();
      expect(event2.indexed_at).not.toBeNull();
      expect(
        await env.storage.db
          .selectFrom("memory_note_revisions")
          .select(["revision"])
          .where("note_id", "=", "crash-note")
          .execute(),
      ).toHaveLength(2);
      // Kabul edilen içerik diskte gerçekten duruyor.
      const revisions = await readdir(
        revisionDir(vaultRoot(env.root), space.id, "crash-note"),
      );
      const files = await Promise.all(
        revisions.map((name) =>
          readFile(
            join(
              revisionDir(vaultRoot(env.root), space.id, "crash-note"),
              name,
            ),
            "utf8",
          ),
        ),
      );
      expect(files.some((file) => file.includes("Kesinti c."))).toBe(true);
    } finally {
      if (child) await kill(child).catch(() => undefined);
      await env.cleanup();
    }
  }, 60000);
}
