import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { ForgeError } from "../domain/errors.js";
import { ensureDir } from "./files.js";
import { writerLockPath } from "./paths.js";

/**
 * Issue #35 (M02): one active filesystem writer per vault root.
 *
 * The lock carries writer id + pid + host + heartbeat. Takeover is cautious:
 * on the same host a live pid always blocks (a paused live writer still owns
 * the vault), a dead pid may be taken over; a foreign/unknown host is never
 * taken over without an explicit operator recovery (`force`). A DB lease
 * expiry alone never authorizes stealing a possibly-live filesystem writer.
 */

export interface WriterLockRecord {
  readonly version: 1;
  readonly writerId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
  heartbeatAt: number;
}

export interface VaultWriterOptions {
  leaseMs?: number;
  now?: () => number;
  pid?: number;
  host?: string;
  isPidAlive?: (pid: number) => boolean;
  maxAcquireAttempts?: number;
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export class VaultWriterLease {
  constructor(
    readonly writer: VaultWriter,
    readonly writerId: string,
  ) {}

  /** Refresh the heartbeat; false when another writer owns the lock now. */
  async heartbeat(): Promise<boolean> {
    return this.writer.heartbeat(this.writerId);
  }

  async release(): Promise<void> {
    await this.writer.release(this.writerId);
  }
}

export class VaultWriter {
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly maxAcquireAttempts: number;

  constructor(
    readonly root: string,
    options: VaultWriterOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 15000;
    this.now = options.now ?? (() => Date.now());
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.maxAcquireAttempts = options.maxAcquireAttempts ?? 5;
  }

  private async readRecord(): Promise<WriterLockRecord | null> {
    try {
      const raw = await readFile(writerLockPath(this.root), "utf8");
      const parsed = JSON.parse(raw) as WriterLockRecord;
      if (
        parsed?.version !== 1 ||
        typeof parsed.writerId !== "string" ||
        typeof parsed.pid !== "number" ||
        typeof parsed.host !== "string" ||
        typeof parsed.heartbeatAt !== "number"
      )
        return null;
      return parsed;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      return null; // unreadable lock: treat as unknown, never auto-steal
    }
  }

  private busy(record: WriterLockRecord | null, reason: string): ForgeError {
    const retryAfter = record
      ? Math.max(
          1,
          Math.ceil((this.leaseMs - (this.now() - record.heartbeatAt)) / 1000),
        )
      : 5;
    return new ForgeError(
      "memory_writer_busy",
      "Vault yazıcısı başka bir süreçte etkin.",
      409,
      retryAfter,
      record
        ? {
            host: record.host,
            pid: record.pid,
            heartbeat_at: record.heartbeatAt,
          }
        : { reason },
    );
  }

  private async steal(record: WriterLockRecord | null): Promise<void> {
    const path = writerLockPath(this.root);
    const trash = `${path}.stale.${randomUUID()}`;
    try {
      await rename(path, trash);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    await rm(trash, { force: true });
    void record;
  }

  async acquire(
    input: { writerId?: string; force?: boolean } = {},
  ): Promise<VaultWriterLease> {
    await ensureDir(this.root);
    const path = writerLockPath(this.root);
    const writerId = input.writerId ?? randomUUID();
    for (let attempt = 0; attempt < this.maxAcquireAttempts; attempt += 1) {
      const record: WriterLockRecord = {
        version: 1,
        writerId,
        pid: this.pid,
        host: this.host,
        startedAt: this.now(),
        heartbeatAt: this.now(),
      };
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new VaultWriterLease(this, writerId);
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
      const current = await this.readRecord();
      if (!current) {
        // Corrupt/unknown lock: never auto-steal without explicit recovery.
        if (!input.force) this.busy(null, "unreadable_lock");
        await this.steal(null);
        continue;
      }
      const fresh = this.now() - current.heartbeatAt < this.leaseMs;
      if (fresh) throw this.busy(current, "heartbeat_fresh");
      if (current.host === this.host) {
        // Same host: a live pid still owns the vault even with force.
        if (this.isPidAlive(current.pid)) throw this.busy(current, "live_pid");
        await this.steal(current);
        continue;
      }
      if (!input.force)
        throw new ForgeError(
          "memory_writer_foreign",
          "Vault kilidi başka makinede; açık kurtarma gerekir.",
          409,
          undefined,
          {
            host: current.host,
            pid: current.pid,
            heartbeat_at: current.heartbeatAt,
          },
        );
      await this.steal(current);
    }
    throw this.busy(null, "acquire_attempts_exhausted");
  }

  async heartbeat(writerId: string): Promise<boolean> {
    const path = writerLockPath(this.root);
    const current = await this.readRecord();
    if (!current || current.writerId !== writerId) return false;
    current.heartbeatAt = this.now();
    try {
      await writeFile(path, JSON.stringify(current), { mode: 0o600 });
    } catch {
      return false;
    }
    return true;
  }

  async release(writerId: string): Promise<void> {
    const path = writerLockPath(this.root);
    const current = await this.readRecord();
    if (!current || current.writerId !== writerId) return;
    await rm(path, { force: true });
  }

  /** Inspect the current lock without acquiring (diagnostics/tests). */
  async inspect(): Promise<WriterLockRecord | null> {
    return this.readRecord();
  }
}

/**
 * Per-space short commit ordering inside one process. The vault writer lock
 * already serializes filesystem writes; this keeps a space's DB CAS/head
 * sequence FIFO for callers sharing a service instance.
 */
export class SpaceSerialQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const guarded = next.catch(() => undefined);
    this.chains.set(key, guarded);
    try {
      return await next;
    } finally {
      if (this.chains.get(key) === guarded) this.chains.delete(key);
    }
  }
}
