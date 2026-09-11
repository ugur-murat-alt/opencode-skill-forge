import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspaceBinding,
  worktreeKeyFor,
} from "../src/clients/worktree-binding.js";
import {
  resolveProjectBinding,
  writeInstallationBinding,
} from "../src/clients/hook-binding.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "forge-test",
  GIT_AUTHOR_EMAIL: "forge@example.com",
  GIT_COMMITTER_NAME: "forge-test",
  GIT_COMMITTER_EMAIL: "forge@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function initRepo(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  return await realpath(root);
}

test("direct checkout, subdirectory and linked worktree bind with distinct keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-wt-"));
  try {
    const main = await initRepo(join(root, "repo"));
    await mkdir(join(main, "src"));
    const direct = await resolveWorkspaceBinding(main, main);
    expect(direct.status).toBe("direct");
    expect(direct.worktreeKey).toBe(worktreeKeyFor(main));
    const sub = await resolveWorkspaceBinding(main, join(main, "src"));
    expect(sub.status).toBe("direct");

    const linkedPath = join(root, "repo-feature");
    git(main, ["worktree", "add", linkedPath, "-b", "feature"]);
    const linkedReal = await realpath(linkedPath);
    const linked = await resolveWorkspaceBinding(main, linkedReal);
    expect(linked.status).toBe("linked");
    expect(linked.commonDir).toBe(await realpath(join(main, ".git")));
    expect(linked.worktreeKey).not.toBe(direct.worktreeKey!);
    expect(linked.worktreeKey).toBe(worktreeKeyFor(linkedReal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrelated repository and malformed metadata are non-equivalence", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-wt-"));
  try {
    const main = await initRepo(join(root, "repo"));
    const other = await initRepo(join(root, "other"));
    const unrelated = await resolveWorkspaceBinding(main, other);
    expect(unrelated.status).toBe("mismatch");
    expect(unrelated.reason).toBe("different_repository");

    const malformed = join(root, "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, ".git"), "gitdir: /does/not/exist\n");
    const malformedResult = await resolveWorkspaceBinding(main, malformed);
    expect(malformedResult.status).toBe("mismatch");
    expect(malformedResult.reason).toBe("git_metadata_invalid");

    const noMetadata = join(root, "plain");
    await mkdir(noMetadata, { recursive: true });
    expect((await resolveWorkspaceBinding(main, noMetadata)).status).toBe(
      "mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a one-way gitdir claim or a symlinked .git file is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-wt-"));
  try {
    const main = await initRepo(join(root, "repo"));
    const admin = join(main, ".git", "worktrees", "spoof");
    await mkdir(admin, { recursive: true });
    // The fabricated worktree claims the admin dir...
    const spoofRoot = join(root, "spoof-worktree");
    await mkdir(spoofRoot, { recursive: true });
    await writeFile(join(spoofRoot, ".git"), `gitdir: ${admin}\n`);
    // ...but the admin dir's backlink points at an unrelated file.
    await writeFile(join(admin, "gitdir"), `${spoofRoot}-other/.git\n`);
    await writeFile(join(admin, "commondir"), "../..\n");
    const spoof = await resolveWorkspaceBinding(main, spoofRoot);
    expect(spoof.status).toBe("mismatch");

    const symlinked = join(root, "symlinked");
    await mkdir(symlinked, { recursive: true });
    const target = join(root, "target-git-file");
    await writeFile(target, `gitdir: ${admin}\n`);
    await symlink(target, join(symlinked, ".git"));
    expect((await resolveWorkspaceBinding(main, symlinked)).status).toBe(
      "mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the persisted binding resolves the linked worktree and rejects wrong scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-wt-"));
  try {
    const main = await initRepo(join(root, "repo"));
    const linkedPath = join(root, "repo-feature");
    git(main, ["worktree", "add", linkedPath, "-b", "feature"]);
    const linkedReal = await realpath(linkedPath);
    const dataDir = join(root, "data");
    await writeInstallationBinding(dataDir, {
      client: "codex",
      projectRef: "project-1",
      projectRoot: main,
    });
    const bound = await resolveProjectBinding(
      dataDir,
      "codex",
      "project-1",
      linkedReal,
    );
    expect(bound.status).toBe("bound");
    if (bound.status === "bound") {
      expect(bound.projectRoot).toBe(main);
      expect(bound.worktreeKey).toBe(worktreeKeyFor(linkedReal));
    }
    const wrongProject = await resolveProjectBinding(
      dataDir,
      "codex",
      "project-2",
      linkedReal,
    );
    expect(wrongProject.status).toBe("mismatch");
    const wrongClient = await resolveProjectBinding(
      dataDir,
      "claude",
      "project-1",
      linkedReal,
    );
    expect(wrongClient.status).toBe("mismatch");
    const other = await initRepo(join(root, "other"));
    const wrongRoot = await resolveProjectBinding(
      dataDir,
      "codex",
      "project-1",
      other,
    );
    expect(wrongRoot.status).toBe("mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
