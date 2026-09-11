import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { VaultWriter } from "../src/memory/writer.js";
import { writerLockPath } from "../src/memory/paths.js";

/**
 * Bağımsız M02 (#35) yazıcı kilidi testleri: gerçek süreçler.
 *
 * - Canlı pid (SIGSTOP ile duraklatılmış olsa da) aynı hostta force ile bile
 *   devralınamaz; ölü pid devralınır.
 * - Sahte foreign host yalnız açık `force` ile alınır.
 * - Bozuk/okunamayan kilit force olmadan devralınamaz. Çekirdek düzeltmesi
 *   (`a5b6964`) ile bu uç kapandı; test normal regresyon testidir.
 */

async function tempVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-m02-lock-"));
}

async function rejection(
  action: () => Promise<unknown>,
): Promise<{ code?: string; status?: number; detail?: unknown }> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError)
      throw error;
    return error as { code?: string; status?: number; detail?: unknown };
  }
  throw new Error("kilit reddi beklenirken acquire başarılı oldu");
}

async function spawnLockChild(vault: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "fixtures/memory/writer-lock-child.ts")],
    {
      env: { ...process.env, VAULT: vault, LEASE_MS: "300" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolveLine, rejectLine) => {
    let output = "";
    const timer = setTimeout(
      () => rejectLine(new Error(`child timeout: ${output}`)),
      15000,
    );
    child.once("error", rejectLine);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("LOCKED")) {
        clearTimeout(timer);
        resolveLine();
      }
    });
  });
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  child.kill("SIGKILL");
  await ended;
}

test("#35 bağımsız: canlı (SIGSTOP) yazıcı force ile bile devralınamaz, ölü pid devralınır", async () => {
  const vault = await tempVault();
  let child: ChildProcess | undefined;
  try {
    child = await spawnLockChild(vault);
    // Child lease'i 300 ms; heartbeat bayatlasın.
    await new Promise((wait) => setTimeout(wait, 600));
    child.kill("SIGSTOP");
    await new Promise((wait) => setTimeout(wait, 50));
    const writer = new VaultWriter(vault, { leaseMs: 300 });
    const plain = await rejection(() => writer.acquire());
    expect(plain.code).toBe("memory_writer_busy");
    expect(plain.status).toBe(409);
    const forced = await rejection(() => writer.acquire({ force: true }));
    expect(forced.code).toBe("memory_writer_busy");
    expect((forced.detail as { pid?: number }).pid).toBe(child.pid!);
    // Ölü pid: artık devralınabilir.
    await kill(child);
    child = undefined;
    const lease = await writer.acquire();
    expect(typeof lease.writerId).toBe("string");
    const record = await writer.inspect();
    expect(record?.pid).toBe(process.pid);
    await lease.release();
  } finally {
    if (child) await kill(child);
    await rm(vault, { recursive: true, force: true });
  }
}, 30000);

test("#35 bağımsız: sahte foreign host yalnız açık force ile devralınır", async () => {
  const vault = await tempVault();
  try {
    const path = writerLockPath(vault);
    const stale = Date.now() - 60_000;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        writerId: "foreign-writer",
        pid: 1,
        host: "other-machine.example",
        startedAt: stale,
        heartbeatAt: stale,
      }),
    );
    const writer = new VaultWriter(vault, { leaseMs: 300 });
    const denied = await rejection(() => writer.acquire());
    expect(denied.code).toBe("memory_writer_foreign");
    expect(denied.status).toBe(409);
    const lease = await writer.acquire({ force: true });
    const record = await writer.inspect();
    expect(record?.writerId).toBe(lease.writerId);
    expect(record?.host).not.toBe("other-machine.example");
    await lease.release();
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}, 15000);

test("#35 bağımsız: heartbeat/release sahiplik kontrollü", async () => {
  const vault = await tempVault();
  try {
    const writer = new VaultWriter(vault, { leaseMs: 5000 });
    const lease = await writer.acquire({ writerId: "owner-1" });
    expect(await writer.heartbeat("stranger")).toBe(false);
    expect(await lease.heartbeat()).toBe(true);
    await writer.release("stranger");
    expect(await writer.inspect()).not.toBeNull();
    await lease.release();
    expect(await writer.inspect()).toBeNull();
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}, 15000);

test("#35 bağımsız: bozuk kilit force olmadan devralınamaz", async () => {
  const vault = await tempVault();
  try {
    await writeFile(writerLockPath(vault), "{bozuk json");
    const writer = new VaultWriter(vault, { leaseMs: 300 });
    const denied = await rejection(() => writer.acquire());
    expect(denied.code).toBe("memory_writer_busy");
    expect(denied.status).toBe(409);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}, 15000);

test("#35 bağımsız: bozuk kilit yalnız açık force ile kurtarılır", async () => {
  const vault = await tempVault();
  try {
    await writeFile(writerLockPath(vault), "{bozuk json");
    const writer = new VaultWriter(vault, { leaseMs: 300 });
    const lease = await writer.acquire({ force: true });
    const record = await writer.inspect();
    expect(record?.writerId).toBe(lease.writerId);
    expect(record?.pid).toBe(process.pid);
    await lease.release();
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}, 15000);
