import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { VaultWriter, SpaceSerialQueue } from "../src/memory/writer.js";

/**
 * Issue #35 (M02): one filesystem writer per vault root. Same-host liveness is
 * proven with a real child process (live but paused writer blocks takeover;
 * killed writer is recovered), and foreign hosts require explicit recovery.
 */

const tmpRoot = () => mkdtemp(join(tmpdir(), "forge-memory-writer-"));

async function waitForLine(child: ChildProcess, timeoutMs = 8000) {
  let output = "";
  const line = await new Promise<string>((resolveLine, rejectLine) => {
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
  return JSON.parse(line) as { writerId: string; pid: number };
}

async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await ended;
  } finally {
    clearTimeout(timer);
  }
}

test("#35 fresh lock blocks a second writer and exposes retry metadata", async () => {
  const root = await tmpRoot();
  try {
    const writer = new VaultWriter(root);
    const lease = await writer.acquire();
    await expect(writer.acquire()).rejects.toMatchObject({
      code: "memory_writer_busy",
      status: 409,
    });
    expect(await lease.heartbeat()).toBe(true);
    await lease.release();
    const again = await writer.acquire();
    await again.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 a stale same-host lock with a live pid is never taken over, even with force", async () => {
  const root = await tmpRoot();
  try {
    let now = 1_000_000;
    const writer = new VaultWriter(root, {
      leaseMs: 1000,
      now: () => now,
      pid: 111,
      host: "host-a",
      isPidAlive: (pid) => pid === 111,
    });
    const lease = await writer.acquire({ writerId: "live-writer" });
    now += 60_000; // heartbeat is now far beyond the lease
    for (const force of [false, true])
      await expect(writer.acquire({ force })).rejects.toMatchObject({
        code: "memory_writer_busy",
      });
    // The live writer can still heartbeat and release its own lock.
    expect(await lease.heartbeat()).toBe(true);
    await lease.release();
    expect(await writer.acquire()).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 a stale same-host lock with a dead pid is recovered", async () => {
  const root = await tmpRoot();
  try {
    let now = 1_000_000;
    const first = new VaultWriter(root, {
      leaseMs: 1000,
      now: () => now,
      pid: 222,
      host: "host-a",
      isPidAlive: () => true,
    });
    await first.acquire({ writerId: "dead-writer" });
    now += 60_000;
    const second = new VaultWriter(root, {
      leaseMs: 1000,
      now: () => now,
      pid: 333,
      host: "host-a",
      isPidAlive: () => false,
    });
    const lease = await second.acquire();
    expect((await second.inspect())?.pid).toBe(333);
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 a foreign-host lock needs explicit recovery", async () => {
  const root = await tmpRoot();
  try {
    let now = 1_000_000;
    const foreign = new VaultWriter(root, {
      leaseMs: 1000,
      now: () => now,
      pid: 444,
      host: "host-other",
      isPidAlive: () => true,
    });
    await foreign.acquire({ writerId: "foreign-writer" });
    now += 60_000;
    const local = new VaultWriter(root, {
      leaseMs: 1000,
      now: () => now,
      pid: 555,
      host: "host-local",
      isPidAlive: () => false,
    });
    await expect(local.acquire()).rejects.toMatchObject({
      code: "memory_writer_foreign",
      status: 409,
    });
    const recovered = await local.acquire({ force: true });
    expect((await local.inspect())?.pid).toBe(555);
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 release is owner-scoped and heartbeat by a stranger is rejected", async () => {
  const root = await tmpRoot();
  try {
    const writer = new VaultWriter(root);
    const lease = await writer.acquire({ writerId: "owner" });
    expect(await writer.heartbeat("stranger")).toBe(false);
    await writer.release("stranger");
    expect(await writer.inspect()).not.toBeNull();
    await lease.release();
    expect(await writer.inspect()).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#35 a live but paused child writer blocks takeover until it is killed", async () => {
  const root = await tmpRoot();
  let child: ChildProcess | undefined;
  try {
    const scriptPath = join(root, "child-writer.ts");
    await Bun.write(
      scriptPath,
      [
        `import { VaultWriter } from ${JSON.stringify(resolve("src/memory/writer.ts"))};`,
        `const writer = new VaultWriter(process.env.MEMORY_VAULT_ROOT!, { leaseMs: Number(process.env.MEMORY_WRITER_LEASE_MS ?? 15000) });`,
        `const lease = await writer.acquire();`,
        `console.log(JSON.stringify({ writerId: lease.writerId, pid: process.pid }));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        MEMORY_VAULT_ROOT: root,
        MEMORY_WRITER_LEASE_MS: "300",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const info = await waitForLine(child);
    // Let the child's heartbeat go stale while it is still alive.
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    const parent = new VaultWriter(root, { leaseMs: 300 });
    await expect(parent.acquire()).rejects.toMatchObject({
      code: "memory_writer_busy",
      detail: expect.objectContaining({ pid: info.pid }),
    });
    await stop(child, "SIGKILL");
    const recovered = await parent.acquire();
    expect((await parent.inspect())?.pid).toBe(process.pid);
    await recovered.release();
  } finally {
    if (child) await stop(child, "SIGKILL").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("#35 per-space queue serializes commits FIFO and allows parallel spaces", async () => {
  const queue = new SpaceSerialQueue();
  const order: string[] = [];
  const first = queue.run("space-a", async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    order.push("a1");
    return "a1";
  });
  const second = queue.run("space-a", async () => {
    order.push("a2");
    return "a2";
  });
  const other = queue.run("space-b", async () => {
    order.push("b1");
    return "b1";
  });
  expect(await Promise.all([first, second, other])).toEqual(["a1", "a2", "b1"]);
  expect(order[0]).toBe("b1");
  expect(order.slice(1)).toEqual(["a1", "a2"]);
});
