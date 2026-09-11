import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Issue #38 (M05): validated workspace binding for hook capture.
 *
 * A captured checkpoint must belong to the installed project. The install
 * directory and the event `cwd` may be the same checkout, or two linked
 * worktrees of the same repository. Equivalence is accepted only through the
 * validated `.git → gitdir → commondir` chain with a reciprocal `gitdir`
 * backlink; a folder name, a shared branch or a matching basename is never
 * enough. Invalid or unreadable metadata is non-equivalence: capture is
 * skipped with a diagnostic instead of falling back to loose path matching.
 *
 * No git executable is used; only bounded, symlink-rejecting filesystem reads.
 */

export type WorkspaceBindingStatus = "direct" | "linked" | "mismatch";

export interface WorkspaceBinding {
  status: WorkspaceBindingStatus;
  /** Stable per-worktree scope key (16 hex chars). */
  worktreeKey: string | null;
  commonDir: string | null;
  reason: string | null;
}

export const WORKTREE_METADATA_MAX_BYTES = 2048;

interface GitChain {
  commonDir: string;
  worktreeRoot: string;
  kind: "main" | "linked";
}

function isInside(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realDir(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

async function readBoundedTextFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
      return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function resolveGitChain(worktreeRoot: string): Promise<GitChain | null> {
  const dotGit = join(worktreeRoot, ".git");
  let stat;
  try {
    stat = await lstat(dotGit);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  if (stat.isDirectory()) {
    const commonDir = await realpath(dotGit).catch(() => null);
    const root = await realpath(worktreeRoot).catch(() => null);
    if (!commonDir || !root) return null;
    return { commonDir, worktreeRoot: root, kind: "main" };
  }
  if (!stat.isFile() || stat.size > WORKTREE_METADATA_MAX_BYTES) return null;
  const text = await readBoundedTextFile(dotGit, WORKTREE_METADATA_MAX_BYTES);
  if (!text || !text.startsWith("gitdir:")) return null;
  const gitDirRaw = text.slice("gitdir:".length).trim();
  if (!gitDirRaw || gitDirRaw.includes("\0")) return null;
  const adminDirClaimed = isAbsolute(gitDirRaw)
    ? gitDirRaw
    : resolve(dirname(dotGit), gitDirRaw);
  const adminDir = await realDir(adminDirClaimed);
  if (!adminDir) return null;
  // Reciprocal evidence: the admin dir's `gitdir` must point back to this
  // worktree's `.git` file; a one-way claim is not equivalence.
  const backlinkText = await readBoundedTextFile(
    join(adminDir, "gitdir"),
    WORKTREE_METADATA_MAX_BYTES,
  );
  if (backlinkText === null) return null;
  const backlinkRaw = backlinkText.trim();
  if (!backlinkRaw || backlinkRaw.includes("\0")) return null;
  const backlinkClaimed = isAbsolute(backlinkRaw)
    ? backlinkRaw
    : resolve(adminDir, backlinkRaw);
  const backlink = await realpath(backlinkClaimed).catch(() => null);
  const dotGitReal = await realpath(dotGit).catch(() => null);
  if (!backlink || !dotGitReal || backlink !== dotGitReal) return null;
  let commonDir = adminDir;
  const commonText = await readBoundedTextFile(
    join(adminDir, "commondir"),
    WORKTREE_METADATA_MAX_BYTES,
  );
  if (commonText !== null) {
    const commonRaw = commonText.trim();
    if (!commonRaw || commonRaw.includes("\0")) return null;
    const commonClaimed = isAbsolute(commonRaw)
      ? commonRaw
      : resolve(adminDir, commonRaw);
    const common = await realDir(commonClaimed);
    if (!common) return null;
    commonDir = common;
  }
  // The admin directory must be contained by the shared git directory.
  if (!isInside(commonDir, adminDir)) return null;
  const root = await realpath(worktreeRoot).catch(() => null);
  if (!root) return null;
  return { commonDir, worktreeRoot: root, kind: "linked" };
}

export function worktreeKeyFor(worktreeRoot: string): string {
  return createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 16);
}

/**
 * Resolves how the event `cwd` binds to the installed project root. The
 * returned key scopes session checkpoints so two worktrees of the same repo do
 * not overwrite each other's unfinished work.
 */
export async function resolveWorkspaceBinding(
  projectRootInput: string,
  cwdInput: string,
): Promise<WorkspaceBinding> {
  const projectRoot = await realDir(resolve(projectRootInput));
  if (!projectRoot)
    return {
      status: "mismatch",
      worktreeKey: null,
      commonDir: null,
      reason: "project_root_unreadable",
    };
  const cwd = await realDir(resolve(cwdInput));
  if (!cwd)
    return {
      status: "mismatch",
      worktreeKey: null,
      commonDir: null,
      reason: "cwd_unreadable",
    };
  if (cwd === projectRoot || isInside(projectRoot, cwd))
    return {
      status: "direct",
      worktreeKey: worktreeKeyFor(projectRoot),
      commonDir: null,
      reason: null,
    };
  if (isInside(cwd, projectRoot))
    return {
      status: "mismatch",
      worktreeKey: null,
      commonDir: null,
      reason: "cwd_ancestor_of_project",
    };
  const [projectChain, cwdChain] = await Promise.all([
    resolveGitChain(projectRoot),
    resolveGitChain(cwd),
  ]);
  if (!projectChain || !cwdChain)
    return {
      status: "mismatch",
      worktreeKey: null,
      commonDir: null,
      reason: "git_metadata_invalid",
    };
  if (projectChain.commonDir !== cwdChain.commonDir)
    return {
      status: "mismatch",
      worktreeKey: null,
      commonDir: null,
      reason: "different_repository",
    };
  return {
    status: "linked",
    worktreeKey: worktreeKeyFor(cwdChain.worktreeRoot),
    commonDir: cwdChain.commonDir,
    reason: null,
  };
}
