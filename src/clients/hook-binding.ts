import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ClientName } from "./hook-contract.js";
import {
  resolveWorkspaceBinding,
  type WorkspaceBinding,
} from "./worktree-binding.js";

/**
 * Issue #38 (M05): the persisted project binding written by the installer.
 *
 * The hook command stays exactly as it was (no new argv), so reinstall is
 * idempotent and Codex trust review is not churned. The durable project root
 * lives in a private sidecar next to the installation manifest; the hook maps
 * its `cwd` to a binding only through validated worktree equivalence. Folder
 * names never create or select a project, and an absent/ambiguous binding
 * skips capture instead of guessing.
 */

export interface InstallationBinding {
  version: 1;
  client: ClientName;
  project_ref: string;
  directory: string;
  created_at: number;
}

const BINDING_FILE = "binding.json";
const BINDING_MAX_BYTES = 4096;
const BINDING_MAX_ENTRIES = 200;

/** Same fingerprint recipe as `installationFingerprint` in installer.ts. */
function bindingFingerprint(client: ClientName, projectRoot: string): string {
  return createHash("sha256")
    .update(JSON.stringify([client, resolve(projectRoot)]))
    .digest("hex");
}

export function installationBindingPath(
  dataDir: string,
  client: ClientName,
  projectRoot: string,
): string {
  return join(
    resolve(dataDir),
    "installations",
    bindingFingerprint(client, projectRoot),
    BINDING_FILE,
  );
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.forge-${process.pid}-${Date.now()}`;
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
}

export async function writeInstallationBinding(
  dataDir: string,
  input: { client: ClientName; projectRef: string; projectRoot: string },
): Promise<string> {
  const path = installationBindingPath(
    dataDir,
    input.client,
    input.projectRoot,
  );
  const record: InstallationBinding = {
    version: 1,
    client: input.client,
    project_ref: input.projectRef,
    directory: resolve(input.projectRoot),
    created_at: Date.now(),
  };
  await atomicWrite(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

export async function removeInstallationBinding(
  dataDir: string,
  client: ClientName,
  projectRoot: string,
): Promise<void> {
  await unlink(installationBindingPath(dataDir, client, projectRoot)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

function parseBinding(raw: string): InstallationBinding | null {
  try {
    const value = JSON.parse(raw) as Partial<InstallationBinding>;
    if (
      value.version !== 1 ||
      (value.client !== "codex" && value.client !== "claude") ||
      typeof value.project_ref !== "string" ||
      !value.project_ref ||
      value.project_ref.length > 200 ||
      typeof value.directory !== "string" ||
      !value.directory ||
      value.directory.length > 4000
    )
      return null;
    return {
      version: 1,
      client: value.client,
      project_ref: value.project_ref,
      directory: value.directory,
      created_at: typeof value.created_at === "number" ? value.created_at : 0,
    };
  } catch {
    return null;
  }
}

export async function readInstallationBindings(
  dataDir: string,
): Promise<InstallationBinding[]> {
  const root = join(resolve(dataDir), "installations");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const bindings: InstallationBinding[] = [];
  for (const entry of entries.slice(0, BINDING_MAX_ENTRIES)) {
    const path = join(root, entry, BINDING_FILE);
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > BINDING_MAX_BYTES
      )
        continue;
      const parsed = parseBinding(await readFile(path, "utf8"));
      if (parsed) bindings.push(parsed);
    } catch {
      // Unreadable/partial sidecar files are ignored, not guessed.
    }
  }
  return bindings;
}

export type ProjectBindingResult =
  | {
      status: "bound";
      projectRoot: string;
      worktreeKey: string;
      workspace: WorkspaceBinding;
    }
  | { status: "mismatch"; reason: string }
  | { status: "ambiguous" };

/**
 * Resolves the event `cwd` to exactly one installed binding for this
 * client/project pair. A direct path match wins; exactly one validated linked
 * worktree match is accepted; anything else is a mismatch. The binding root is
 * never created from the folder name.
 */
export async function resolveProjectBinding(
  dataDir: string,
  client: ClientName,
  projectRef: string,
  cwd: string,
): Promise<ProjectBindingResult> {
  const candidates = (await readInstallationBindings(dataDir)).filter(
    (binding) =>
      binding.client === client && binding.project_ref === projectRef,
  );
  const seen = new Set<string>();
  const linked: Array<{
    projectRoot: string;
    worktreeKey: string;
    workspace: WorkspaceBinding;
  }> = [];
  for (const candidate of candidates) {
    const directory = resolve(candidate.directory);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const workspace = await resolveWorkspaceBinding(directory, cwd);
    if (workspace.status === "direct" && workspace.worktreeKey)
      return {
        status: "bound",
        projectRoot: directory,
        worktreeKey: workspace.worktreeKey,
        workspace,
      };
    if (workspace.status === "linked" && workspace.worktreeKey)
      linked.push({
        projectRoot: directory,
        worktreeKey: workspace.worktreeKey,
        workspace,
      });
  }
  if (linked.length === 1) return { status: "bound", ...linked[0]! };
  if (linked.length > 1) return { status: "ambiguous" };
  return { status: "mismatch", reason: "no_valid_binding" };
}
