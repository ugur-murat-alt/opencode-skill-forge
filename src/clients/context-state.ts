import { dirname, join } from "node:path";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import type { ClientName } from "./hook-contract.js";
import { installationBindingPath } from "./hook-binding.js";

/**
 * Issue #38 (M05) Faz B: offered/delivered bookkeeping for context injection.
 *
 * This is a derived delivery log, not primary data. It lives next to the
 * installation binding and stores only note ids/revisions that were handed to
 * the client through a successfully returned hook output. A crash or a failed
 * hook output loses at most the "delivered" mark, which makes the next event
 * re-offer the same revisions (safe direction); wrong tenant data can never be
 * produced from this file because the context itself always comes from the
 * authenticated service.
 */

export interface ContextKnown {
  note_id: string;
  revision: number;
}

interface WorktreeState {
  delivered: Record<string, number>;
  offered: number;
  delivered_count: number;
  skipped: number;
  errors: number;
  timeouts: number;
  last_package_hash: string | null;
  updated_at: number;
}

interface SessionState {
  generation: number;
  updated_at: number;
  worktrees: Record<string, WorktreeState>;
}

interface ContextStateFile {
  version: 1;
  sessions: Record<string, SessionState>;
}

const MAX_SESSIONS = 50;
const MAX_WORKTREES_PER_SESSION = 4;
const MAX_KNOWN_PER_WORKTREE = 48;
const MAX_FILE_BYTES = 256 * 1024;

function statePath(
  dataDir: string,
  client: ClientName,
  projectRoot: string,
): string {
  return join(
    dirname(installationBindingPath(dataDir, client, projectRoot)),
    "context-state.json",
  );
}

function emptyState(): ContextStateFile {
  return { version: 1, sessions: {} };
}

function emptyWorktree(now: number): WorktreeState {
  return {
    delivered: {},
    offered: 0,
    delivered_count: 0,
    skipped: 0,
    errors: 0,
    timeouts: 0,
    last_package_hash: null,
    updated_at: now,
  };
}

async function loadState(path: string): Promise<ContextStateFile> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
      return emptyState();
    const parsed = JSON.parse(await readFile(path, "utf8")) as ContextStateFile;
    if (parsed.version !== 1 || typeof parsed.sessions !== "object")
      return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

async function saveState(path: string, state: ContextStateFile): Promise<void> {
  const sessions = Object.entries(state.sessions)
    .sort(([, a], [, b]) => b.updated_at - a.updated_at)
    .slice(0, MAX_SESSIONS);
  const bounded: ContextStateFile = { version: 1, sessions: {} };
  for (const [key, session] of sessions) {
    const worktrees = Object.entries(session.worktrees)
      .sort(([, a], [, b]) => b.updated_at - a.updated_at)
      .slice(0, MAX_WORKTREES_PER_SESSION);
    const kept: SessionState["worktrees"] = {};
    for (const [worktreeKey, worktree] of worktrees) {
      const delivered = Object.entries(worktree.delivered)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, MAX_KNOWN_PER_WORKTREE);
      kept[worktreeKey] = {
        ...worktree,
        delivered: Object.fromEntries(delivered),
      };
    }
    bounded.sessions[key] = { ...session, worktrees: kept };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.forge-${process.pid}-${Date.now()}`;
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(bounded));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
}

function sessionKeyOf(client: ClientName, sessionId: string): string {
  return `${client}:${sessionId}`.slice(0, 220);
}

function worktreeKeyOf(worktreeKey: string | null): string {
  return (worktreeKey ?? "-").slice(0, 64);
}

async function mutate(
  args: {
    dataDir: string;
    client: ClientName;
    projectRoot: string;
  },
  action: (state: ContextStateFile, now: number) => void,
): Promise<void> {
  const path = statePath(args.dataDir, args.client, args.projectRoot);
  const now = Date.now();
  const state = await loadState(path);
  action(state, now);
  await saveState(path, state);
}

export interface ContextTurn {
  sessionKey: string;
  worktreeKey: string;
  generation: number;
  known: ContextKnown[];
}

/**
 * Opens a context turn for a hook event. `resume`/`compact`/`fork` start a new
 * context generation and clear the delivered revision marks for that worktree,
 * so the minimum packet is re-served; `startup` continues the same generation.
 */
export async function beginContextTurn(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionId: string;
  worktreeKey: string | null;
  source: string | null;
}): Promise<ContextTurn> {
  const sessionKey = sessionKeyOf(args.client, args.sessionId);
  const worktreeKey = worktreeKeyOf(args.worktreeKey);
  let turn: ContextTurn = {
    sessionKey,
    worktreeKey,
    generation: 1,
    known: [],
  };
  await mutate(args, (state, now) => {
    const session = (state.sessions[sessionKey] ??= {
      generation: 1,
      updated_at: now,
      worktrees: {},
    });
    const worktree = (session.worktrees[worktreeKey] ??= emptyWorktree(now));
    const reissue =
      args.source !== null &&
      ["resume", "compact", "fork"].includes(args.source);
    if (reissue) {
      session.generation += 1;
      worktree.delivered = {};
    }
    session.updated_at = now;
    worktree.updated_at = now;
    turn = {
      sessionKey,
      worktreeKey,
      generation: session.generation,
      known: Object.entries(worktree.delivered)
        .map(([note_id, revision]) => ({ note_id, revision }))
        .sort((a, b) => a.note_id.localeCompare(b.note_id)),
    };
  });
  return turn;
}

export async function recordContextOffered(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionKey: string;
  worktreeKey: string;
  count: number;
}): Promise<void> {
  if (args.count <= 0) return;
  await mutate(
    {
      dataDir: args.dataDir,
      client: args.client,
      projectRoot: args.projectRoot,
    },
    (state, now) => {
      const session = state.sessions[args.sessionKey];
      const worktree = session?.worktrees[args.worktreeKey];
      if (!worktree) return;
      worktree.offered += args.count;
      worktree.updated_at = now;
    },
  );
}

export async function recordContextDelivered(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionKey: string;
  worktreeKey: string;
  offered: ContextKnown[];
  packageHash: string | null;
}): Promise<void> {
  await mutate(
    {
      dataDir: args.dataDir,
      client: args.client,
      projectRoot: args.projectRoot,
    },
    (state, now) => {
      const session = state.sessions[args.sessionKey];
      const worktree = session?.worktrees[args.worktreeKey];
      if (!worktree) return;
      for (const item of args.offered)
        worktree.delivered[item.note_id] = Math.max(
          worktree.delivered[item.note_id] ?? 0,
          item.revision,
        );
      worktree.delivered_count += args.offered.length;
      worktree.last_package_hash = args.packageHash;
      worktree.updated_at = now;
    },
  );
}

export async function recordContextEmpty(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionKey: string;
  worktreeKey: string;
}): Promise<void> {
  await mutate(
    {
      dataDir: args.dataDir,
      client: args.client,
      projectRoot: args.projectRoot,
    },
    (state, now) => {
      const worktree =
        state.sessions[args.sessionKey]?.worktrees[args.worktreeKey];
      if (!worktree) return;
      worktree.skipped += 1;
      worktree.updated_at = now;
    },
  );
}

export async function recordContextFailure(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionKey: string;
  worktreeKey: string;
  kind: "timeout" | "error";
}): Promise<void> {
  await mutate(
    {
      dataDir: args.dataDir,
      client: args.client,
      projectRoot: args.projectRoot,
    },
    (state, now) => {
      const worktree =
        state.sessions[args.sessionKey]?.worktrees[args.worktreeKey];
      if (!worktree) return;
      if (args.kind === "timeout") worktree.timeouts += 1;
      else worktree.errors += 1;
      worktree.updated_at = now;
    },
  );
}

export interface ContextDiagnostics {
  sessions: number;
  generation: number | null;
  knownRevisions: number;
  offered: number;
  delivered: number;
  skipped: number;
  errors: number;
  timeouts: number;
  lastPackageHash: string | null;
}

/** Visible, content-free counter surface for tests and diagnostics. */
export async function contextDiagnostics(args: {
  dataDir: string;
  client: ClientName;
  projectRoot: string;
  sessionId?: string;
  worktreeKey?: string | null;
}): Promise<ContextDiagnostics> {
  const path = statePath(args.dataDir, args.client, args.projectRoot);
  const state = await loadState(path);
  const sessionKey = args.sessionId
    ? sessionKeyOf(args.client, args.sessionId)
    : undefined;
  const sessions = Object.keys(state.sessions).length;
  let offered = 0,
    delivered = 0,
    skipped = 0,
    errors = 0,
    timeouts = 0,
    knownRevisions = 0,
    generation: number | null = null,
    lastPackageHash: string | null = null;
  for (const [key, session] of Object.entries(state.sessions)) {
    for (const worktree of Object.values(session.worktrees)) {
      offered += worktree.offered;
      delivered += worktree.delivered_count;
      skipped += worktree.skipped;
      errors += worktree.errors;
      timeouts += worktree.timeouts;
    }
    if (sessionKey && key === sessionKey) {
      generation = session.generation;
      const worktree =
        session.worktrees[worktreeKeyOf(args.worktreeKey ?? null)];
      if (worktree) {
        knownRevisions = Object.keys(worktree.delivered).length;
        lastPackageHash = worktree.last_package_hash;
      }
    }
  }
  return {
    sessions,
    generation,
    knownRevisions,
    offered,
    delivered,
    skipped,
    errors,
    timeouts,
    lastPackageHash,
  };
}
