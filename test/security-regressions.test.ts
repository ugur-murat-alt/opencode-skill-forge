import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = mkdtempSync(join(tmpdir(), "skill-forge-security-"));
const registryHome = mkdtempSync(join(tmpdir(), "skill-forge-security-home-"));
const serviceStateHome = mkdtempSync(
  join(tmpdir(), "skill-forge-security-state-"),
);
const instrumentedBundle = join(workspace, "plugin-under-test.mjs");
const previousSkillPowerHome = process.env.OC_SKILL_POWER_HOME;
const previousXdgStateHome = process.env.XDG_STATE_HOME;
let plugin: Record<string, any>;

const skillContent = (name: string, body = "# Workflow\n") => `---
name: ${name}
description: Test skill for security regressions.
metadata:
  oc-skill-power: managed
---
${body}`;

const makeSkill = (root: string, name: string, body?: string) => {
  const dir = join(root, ".opencode", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillContent(name, body));
  return dir;
};

beforeAll(async () => {
  process.env.OC_SKILL_POWER_HOME = registryHome;
  process.env.XDG_STATE_HOME = serviceStateHome;
  const sourcePath = join(import.meta.dir, "..", "dist", "skillforge-core.js");
  const source = readFileSync(sourcePath, "utf8");
  const marker = "export {\n";
  const injected = `export {\n  validateFilePath as __validateFilePath,\n  findSkill as __findSkill,\n  readSupportFile as __readSupportFile,\n  writeSupportFile as __writeSupportFile,\n  removeSupportFile as __removeSupportFile,\n  SkillTransactionStore as __SkillTransactionStore,\n  treeHashOf as __treeHashOf,\n  copyTree as __copyTree,\n  validateSkillTree as __validateSkillTree,\n  LearningState as __LearningState,\n  SkillsSubsystem as __SkillsSubsystem,\n  skillManage as __skillManage,\n  skillView as __skillView,\n  skillFinalize as __skillFinalize,\n  evolutionGates as __evolutionGates,\n  endOfSessionEligible as __endOfSessionEligible,\n  normalizeEvent as __normalizeEvent,\n  classifyEvidence as __classifyEvidence,\n  PRODUCTION_BOOTSTRAP_READY as __PRODUCTION_BOOTSTRAP_READY,\n`;
  expect(source.includes(marker)).toBe(true);
  const instrumentedSource = source
    .replace(marker, injected)
    .replace(
      "  validateFilePath as __validateFilePath,",
      [
        "  runReview as __runReview,",
        "  validateFilePath as __validateFilePath,",
      ].join(String.fromCharCode(10)),
    );
  writeFileSync(instrumentedBundle, instrumentedSource);
  plugin = await import(
    `${pathToFileURL(instrumentedBundle).href}?v=${Date.now()}`
  );
});

afterAll(() => {
  if (previousSkillPowerHome === undefined)
    delete process.env.OC_SKILL_POWER_HOME;
  else process.env.OC_SKILL_POWER_HOME = previousSkillPowerHome;
  if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousXdgStateHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(registryHome, { recursive: true, force: true });
  rmSync(serviceStateHome, { recursive: true, force: true });
});

describe("support path confinement", () => {
  test("rejects traversal, aliases, backslashes, and directory-only paths", () => {
    expect(plugin.__validateFilePath("references/ok.md")).toBeNull();
    for (const path of [
      "../outside",
      "references/../outside",
      "references/./file.md",
      "references//file.md",
      "references\\file.md",
      "references",
    ]) {
      expect(plugin.__validateFilePath(path)).toBeString();
    }
  });

  test("findSkill rejects invalid names instead of traversing", () => {
    const root = join(workspace, "traversal");
    makeSkill(root, "safe-skill");
    expect(() =>
      plugin.__findSkill(root, "../../outside", ["project"]),
    ).toThrow();
  });

  test("rejects a project skills root redirected by symlink", () => {
    const root = join(workspace, "redirected-root");
    const outside = join(workspace, "redirected-skills");
    mkdirSync(join(root, ".opencode"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".opencode", "skills"));
    expect(() => plugin.__findSkill(root, "safe-skill", ["project"])).toThrow(
      /symbolic links/,
    );
  });

  test("rejects a global skills root redirected by symlink", () => {
    const home = join(workspace, "redirected-global-home");
    const outside = join(workspace, "redirected-global-skills");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(home, ".config", "opencode", "skills"));
    const previous = process.env.OC_SKILL_POWER_HOME;
    process.env.OC_SKILL_POWER_HOME = home;
    try {
      expect(() =>
        plugin.__findSkill(workspace, "safe-skill", ["global"]),
      ).toThrow(/symbolic links/);
    } finally {
      if (previous === undefined) delete process.env.OC_SKILL_POWER_HOME;
      else process.env.OC_SKILL_POWER_HOME = previous;
    }
  });

  test("support reads and writes reject symlinked files and directories", async () => {
    const root = join(workspace, "symlink");
    const dir = makeSkill(root, "safe-skill");
    const outside = join(workspace, "outside.txt");
    writeFileSync(outside, "outside");
    mkdirSync(join(dir, "references"));
    symlinkSync(outside, join(dir, "references", "leak.md"));

    expect(() => plugin.__readSupportFile(dir, "references/leak.md")).toThrow(
      /symbolic links/,
    );
    await expect(
      plugin.__writeSupportFile({
        scope: "project",
        root,
        name: "safe-skill",
        filePath: "references/leak.md",
        fileContent: "changed",
        dryRun: false,
      }),
    ).rejects.toThrow(/symbolic links/);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  test("remove detects a concurrent replacement and preserves it", async () => {
    const root = join(workspace, "remove-race");
    const dir = makeSkill(root, "safe-skill");
    const file = join(dir, "references", "note.md");
    mkdirSync(join(dir, "references"));
    writeFileSync(file, "old");

    const removal = plugin.__removeSupportFile({
      scope: "project",
      root,
      name: "safe-skill",
      filePath: "references/note.md",
      dryRun: false,
    });
    writeFileSync(file, "new");

    await expect(removal).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(file, "utf8")).toBe("new");
  });
});

describe("review session registry identity", () => {
  test("pairs source sessions and attempts for concurrent reviews", async () => {
    const root = join(workspace, "concurrent-review-registry");
    mkdirSync(root, { recursive: true });
    const state = new plugin.__LearningState();
    const reviewOutcomes: Array<Record<string, any>> = [];
    const waiters = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    const releases = new Map<string, () => void>();
    const promptIDs: string[] = [];
    let resolvePrompts!: () => void;
    const promptsReady = new Promise<void>((resolve) => {
      resolvePrompts = resolve;
    });
    let createCount = 0;
    const journal = {
      appendReview(entry: Record<string, any>) {
        reviewOutcomes.push(entry);
      },
      entriesForSession: () => [],
    };
    const host = {
      flushPendingCleanups() {},
      journalFor: async () => journal,
      resolveRoot: async () => root,
      markReviewed() {},
      reloadSkills: async () => {},
      trackWaiter(
        reviewID: string,
        waiter: { resolve: () => void; reject: (error: Error) => void },
      ) {
        waiters.set(reviewID, waiter);
      },
      settleWaiter(
        reviewID: string,
        outcome: "resolve" | "reject",
        error?: Error,
      ) {
        const waiter = waiters.get(reviewID);
        if (!waiter) return;
        waiters.delete(reviewID);
        if (outcome === "resolve") waiter.resolve();
        else waiter.reject(error ?? new Error("review execution failed"));
      },
      rejectWaiter(reviewID: string, error: Error) {
        this.settleWaiter(reviewID, "reject", error);
      },
      untrackWaiter(reviewID: string) {
        waiters.delete(reviewID);
      },
      enqueuePendingCleanup() {},
      async notify() {},
      log() {},
    };
    const app = {
      ctx: {
        session: {
          create: async () => ({ id: `review-${++createCount}` }),
          prompt: async ({ sessionID }: { sessionID: string }) => {
            promptIDs.push(sessionID);
            await new Promise<void>((resolve) => {
              releases.set(sessionID, resolve);
              if (releases.size === 2) resolvePrompts();
            });
          },
          interrupt: async () => {},
        },
      },
      state,
      cfg: {
        maxTranscriptChars: 4_000,
        reviewModel: null,
        reviewTimeoutMs: 30_000,
        dryRun: false,
      },
      host,
    };
    const evidence = (sourceSessionID: string) => ({
      messages: [
        {
          role: "user",
          parts: [{ kind: "text", summary: `source ${sourceSessionID}` }],
        },
        {
          role: "assistant",
          parts: [{ kind: "text", summary: "A verified assistant result" }],
          completedAt: 1,
        },
      ],
      coverage: {
        finalAssistantIncluded: true,
        completedToolResults: 0,
        failedToolResults: 0,
        omittedItems: 0,
        omissionReasons: [],
        sourceKind: "test",
      },
      through: {
        lastMessageID: `through-${sourceSessionID}`,
        lastCompletedAt: 1,
        assistantMessageID: `assistant-${sourceSessionID}`,
        ordinal: 1,
      },
    });

    const reviews = [
      plugin.__runReview(app, "source-a", evidence("source-a"), undefined),
      plugin.__runReview(app, "source-b", evidence("source-b"), undefined),
    ];
    await promptsReady;
    expect(promptIDs).toHaveLength(2);
    for (const reviewID of [...promptIDs].reverse()) {
      releases.get(reviewID)?.();
      host.settleWaiter(reviewID, "resolve");
    }
    await Promise.all(reviews);

    const registryFile = join(
      registryHome,
      ".opencode",
      ".skill-power",
      "active-skill-forge-sessions.jsonl",
    );
    const registryEntries = readFileSync(registryFile, "utf8")
      .trim()
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as Record<string, any>);
    const transactionsDir = join(
      root,
      ".opencode",
      ".skill-power",
      "transactions",
    );
    const manifests = readdirSync(transactionsDir)
      .filter((name) => name.endsWith(".manifest.json"))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(transactionsDir, name), "utf8"),
          ) as Record<string, any>,
      );
    const sourceByReview = new Map(
      reviewOutcomes.map((outcome) => [outcome.reviewID, outcome.sessionID]),
    );
    const attemptBySource = new Map(
      manifests.map((manifest) => [manifest.candidateID, manifest.attemptID]),
    );

    expect(reviewOutcomes).toHaveLength(2);
    expect(
      registryEntries.map((entry) => entry.sourceSessionID).sort(),
    ).toEqual(["source-a", "source-b"]);
    expect(new Set(registryEntries.map((entry) => entry.attemptID)).size).toBe(
      2,
    );
    for (const entry of registryEntries) {
      const sourceSessionID = sourceByReview.get(entry.sessionID);
      expect(sourceSessionID).toBeString();
      expect(entry.sourceSessionID).toBe(sourceSessionID);
      expect(entry.attemptID).toBe(attemptBySource.get(sourceSessionID));
    }
  });
});

describe("transaction isolation", () => {
  test("rollback restores only the target skill", () => {
    const root = join(workspace, "rollback");
    const target = makeSkill(root, "target-skill");
    const sibling = makeSkill(root, "sibling-skill");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    const backup = join(tx.stagingDirFor("attempt-1"), "backup");
    plugin.__copyTree(target, backup);
    tx.begin({
      attemptID: "attempt-1",
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID: "review",
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
      backupPath: backup,
      backupHash: plugin.__treeHashOf(backup),
    });

    writeFileSync(
      join(target, "SKILL.md"),
      skillContent("target-skill", "# Changed\n"),
    );
    tx.recordMutation({
      attemptID: "attempt-1",
      action: "edit",
      relativePath: "SKILL.md",
      inputText: "edit",
      stagedTreeHash: plugin.__treeHashOf(target),
    });
    writeFileSync(
      join(sibling, "SKILL.md"),
      skillContent("sibling-skill", "# User change\n"),
    );

    expect(tx.rollback("attempt-1").phase).toBe("reverted");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain(
      "# Workflow",
    );
    expect(readFileSync(join(sibling, "SKILL.md"), "utf8")).toContain(
      "# User change",
    );
  });

  test("commit rechecks the target after verification", () => {
    const root = join(workspace, "commit-race");
    const target = makeSkill(root, "target-skill");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    tx.begin({
      attemptID: "attempt-2",
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID: "review",
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
    });
    tx.verify("attempt-2");
    writeFileSync(
      join(target, "SKILL.md"),
      skillContent("target-skill", "# Concurrent\n"),
    );

    expect(() => tx.commit("attempt-2")).toThrow(/concurrent edit/);
    expect(tx.read("attempt-2").phase).toBe("blocked");
  });

  test("schema v1 create rollback keeps sibling skills", () => {
    const root = join(workspace, "legacy-rollback");
    const scopeRoot = join(root, ".opencode", "skills");
    const sibling = makeSkill(root, "sibling-skill");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    tx.begin({
      attemptID: "attempt-v1",
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID: "review",
      targetStateRoot: scopeRoot,
      targetSkill: "created-skill",
      targetScope: "project",
      beforeExists: false,
      beforeTreeHash: plugin.__treeHashOf(scopeRoot),
    });
    const legacy = tx.read("attempt-v1");
    legacy.schemaVersion = 1;
    tx.persist(legacy);
    makeSkill(root, "created-skill");
    tx.recordMutation({
      attemptID: "attempt-v1",
      action: "create",
      relativePath: "created-skill/SKILL.md",
      inputText: "create",
      stagedTreeHash: plugin.__treeHashOf(scopeRoot),
    });

    expect(tx.rollback("attempt-v1").phase).toBe("reverted");
    expect(readFileSync(join(sibling, "SKILL.md"), "utf8")).toContain(
      "sibling-skill",
    );
    expect(() =>
      readFileSync(join(scopeRoot, "created-skill", "SKILL.md"), "utf8"),
    ).toThrow();
  });
});

describe("finalization consistency", () => {
  test("no-change rejects an unrecorded disk mutation", async () => {
    const root = join(workspace, "finalize-no-change");
    const target = makeSkill(root, "target-skill");
    const attemptID = "attempt-finalize-empty";
    const reviewID = "review-finalize-empty";
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    tx.begin({
      attemptID,
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID,
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
    });
    writeFileSync(
      join(target, "SKILL.md"),
      skillContent("target-skill", "# Unrecorded\n"),
    );
    const state = new plugin.__LearningState();
    state.trackReview(reviewID, "owner");
    state.setReviewAttempt(reviewID, attemptID);
    const app = {
      state,
      host: {
        isReview: () => true,
        journalFor: async () => ({ entriesForSession: () => [] }),
        resolveRoot: async () => root,
      },
    };

    await expect(
      plugin
        .__skillFinalize(app)
        .execute({ decision: "no-change" }, { sessionID: reviewID }),
    ).rejects.toThrow(/target skill changed/);
  });

  test("mutation-complete rejects journal and transaction path mismatch", async () => {
    const root = join(workspace, "finalize-mismatch");
    const target = makeSkill(root, "target-skill", "Use references/a.md.\n");
    mkdirSync(join(target, "references"));
    writeFileSync(join(target, "references", "a.md"), "a");
    const attemptID = "attempt-finalize-mismatch";
    const reviewID = "review-finalize-mismatch";
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    tx.begin({
      attemptID,
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID,
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
    });
    writeFileSync(join(target, "references", "a.md"), "changed");
    tx.recordMutation({
      attemptID,
      action: "write_file",
      relativePath: "references/a.md",
      inputText: "write",
      stagedTreeHash: plugin.__treeHashOf(target),
    });
    const state = new plugin.__LearningState();
    state.trackReview(reviewID, "owner");
    state.setReviewAttempt(reviewID, attemptID);
    const app = {
      state,
      host: {
        isReview: () => true,
        journalFor: async () => ({
          entriesForSession: () => [
            {
              role: "background",
              action: "write_file",
              skill: "target-skill",
              file: "references/b.md",
              afterHash: "different",
            },
          ],
        }),
        resolveRoot: async () => root,
      },
    };

    await expect(
      plugin
        .__skillFinalize(app)
        .execute(
          { decision: "mutation-complete", targetSkill: "target-skill" },
          { sessionID: reviewID },
        ),
    ).rejects.toThrow(/entries do not match/);
  });
});

describe("graduation integrity", () => {
  test("rejects orphan, missing, and symlinked resources", () => {
    const root = join(workspace, "integrity");
    const dir = makeSkill(root, "safe-skill");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "orphan.md"), "orphan");
    expect(plugin.__validateSkillTree(dir)).toBe("orphan-support-file");

    writeFileSync(
      join(dir, "SKILL.md"),
      skillContent("safe-skill", "Use references/missing.md.\n"),
    );
    rmSync(join(dir, "references", "orphan.md"));
    expect(plugin.__validateSkillTree(dir)).toBe("missing-support-file");

    writeFileSync(join(dir, "SKILL.md"), skillContent("safe-skill"));
    symlinkSync(
      join(workspace, "outside.txt"),
      join(dir, "references", "linked.md"),
    );
    expect(plugin.__validateSkillTree(dir)).toBe("symlink-detected");
  });

  test("validates managed frontmatter for support-only changes", () => {
    const root = join(workspace, "frontmatter-integrity");
    const dir = makeSkill(root, "safe-skill");
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: safe-skill\ndescription: Broken ownership.\n---\n# Workflow\n`,
    );
    expect(plugin.__validateSkillTree(dir, "safe-skill")).toBe("not-managed");
  });
});

describe("background reviewer policy", () => {
  const makeApp = (root: string, reviewID: string) => {
    const state = new plugin.__LearningState();
    state.trackReview(reviewID, "owner");
    state.markReviewListedSkills(reviewID);
    const journal = {
      append() {},
      mutationCountSince() {
        return 0;
      },
    };
    return {
      state,
      cfg: {
        protectedSkills: [],
        churn: { maxMutations: 0, windowHours: 24 },
        skillsScope: "auto",
        dryRun: false,
        writeApproval: false,
      },
      host: {
        isReview: (id: string) => id === reviewID,
        journalFor: async () => journal,
        resolveRoot: async () => root,
        reloadSkills: async () => {},
      },
    };
  };

  test("requires reading an existing support file before overwrite", async () => {
    const root = join(workspace, "read-before-write");
    const dir = makeSkill(root, "safe-skill");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "note.md"), "old");
    const reviewID = "review-read";
    const app = makeApp(root, reviewID);
    await plugin
      .__skillView(app)
      .execute({ name: "safe-skill" }, { sessionID: reviewID });
    const tool = plugin.__skillManage(app);

    const blocked = await tool.execute(
      {
        action: "write_file",
        name: "safe-skill",
        file_path: "references/note.md",
        file_content: "new",
      },
      { sessionID: reviewID },
    );
    expect(blocked.content).toContain("must call omni.skill_view");
    expect(readFileSync(join(dir, "references", "note.md"), "utf8")).toBe(
      "old",
    );
  });

  test("forbids background script mutations", async () => {
    const root = join(workspace, "script-policy");
    makeSkill(root, "safe-skill");
    const reviewID = "review-script";
    const app = makeApp(root, reviewID);
    await plugin
      .__skillView(app)
      .execute({ name: "safe-skill" }, { sessionID: reviewID });
    const tool = plugin.__skillManage(app);
    const blocked = await tool.execute(
      {
        action: "write_file",
        name: "safe-skill",
        file_path: "scripts/run.sh",
        file_content: "#!/bin/sh\ntrue\n",
      },
      { sessionID: reviewID },
    );
    expect(blocked.content).toContain(
      "may not create, modify, or remove executable scripts",
    );
  });

  test("rejects a support file changed after it was viewed", async () => {
    const root = join(workspace, "stale-support-view");
    const dir = makeSkill(root, "safe-skill");
    mkdirSync(join(dir, "references"));
    const file = join(dir, "references", "note.md");
    writeFileSync(file, "old");
    const reviewID = "review-stale-support";
    const app = makeApp(root, reviewID);
    const view = plugin.__skillView(app);
    await view.execute({ name: "safe-skill" }, { sessionID: reviewID });
    await view.execute(
      { name: "safe-skill", path: "references/note.md" },
      { sessionID: reviewID },
    );
    writeFileSync(file, "user change");

    const blocked = await plugin.__skillManage(app).execute(
      {
        action: "write_file",
        name: "safe-skill",
        file_path: "references/note.md",
        file_content: "review change",
      },
      { sessionID: reviewID },
    );
    expect(blocked.content).toContain("changed since it was viewed");
    expect(readFileSync(file, "utf8")).toBe("user change");
  });

  test("rejects a skill changed after it was viewed", async () => {
    const root = join(workspace, "stale-skill-view");
    const dir = makeSkill(root, "safe-skill");
    const file = join(dir, "SKILL.md");
    const reviewID = "review-stale-skill";
    const app = makeApp(root, reviewID);
    await plugin
      .__skillView(app)
      .execute({ name: "safe-skill" }, { sessionID: reviewID });
    writeFileSync(file, skillContent("safe-skill", "# User change\n"));

    const blocked = await plugin.__skillManage(app).execute(
      {
        action: "patch",
        name: "safe-skill",
        old_string: "# Workflow",
        new_string: "# Review change",
      },
      { sessionID: reviewID },
    );
    expect(blocked.content).toContain("changed since it was viewed");
    expect(readFileSync(file, "utf8")).toContain("# User change");
  });

  test("rolls back when journal persistence fails after mutation", async () => {
    const root = join(workspace, "journal-failure");
    const dir = makeSkill(root, "safe-skill");
    const file = join(dir, "SKILL.md");
    const reviewID = "review-journal-failure";
    const attemptID = "attempt-journal-failure";
    const app = makeApp(root, reviewID);
    app.state.setReviewAttempt(reviewID, attemptID);
    app.host.journalFor = async () => ({
      append() {
        throw new Error("journal unavailable");
      },
      mutationCountSince() {
        return 0;
      },
    });
    await plugin
      .__skillView(app)
      .execute({ name: "safe-skill" }, { sessionID: reviewID });

    await expect(
      plugin.__skillManage(app).execute(
        {
          action: "patch",
          name: "safe-skill",
          old_string: "# Workflow",
          new_string: "# Mutated",
        },
        { sessionID: reviewID },
      ),
    ).rejects.toThrow(/journal unavailable/);
    expect(readFileSync(file, "utf8")).toContain("# Workflow");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    expect(tx.read(attemptID).phase).toBe("reverted");
  });
});

describe("production launch and recovery", () => {
  test("waits for review execution start and coalesces duplicate success", () => {
    const state = new plugin.__LearningState();
    state.trackReview("review", "owner");

    expect(state.shouldHandleExecutionSuccess("review")).toBe(false);
    state.markExecutionStarted("review");
    expect(state.shouldHandleExecutionSuccess("review")).toBe(true);
    expect(state.shouldHandleExecutionSuccess("review")).toBe(false);

    state.markExecutionStarted("review");
    expect(state.shouldHandleExecutionSuccess("review")).toBe(true);
    expect(state.shouldHandleExecutionSuccess("owner")).toBe(true);
    expect(state.shouldHandleExecutionSuccess("owner")).toBe(false);
  });

  test("gates review terminal events through the execution lifecycle", () => {
    const state = new plugin.__LearningState();
    state.trackReview("review-success", "owner");
    state.trackReview("review-failure", "owner");
    const settled: string[] = [];
    const rejected: string[] = [];
    const observed: string[] = [];
    const fake = {
      state,
      app: {
        host: {
          isReview: (sessionID: string) => state.isReview(sessionID),
          settleWaiter: (sessionID: string) => settled.push(sessionID),
          rejectWaiter: (sessionID: string) => rejected.push(sessionID),
        },
      },
      coordinator: {
        observe: (event: { sessionID: string }) =>
          observed.push(event.sessionID),
      },
    };
    const handle = (type: string, sessionID: string, data = {}) =>
      plugin.__SkillsSubsystem.prototype.handleEvent.call(fake, {
        type,
        sessionID,
        data,
      });

    handle("session.execution.succeeded", "review-success");
    handle("session.execution.interrupted", "review-failure");
    expect(settled).toEqual([]);
    expect(rejected).toEqual([]);

    handle("session.execution.started", "review-success");
    handle("session.execution.succeeded", "review-success");
    handle("session.execution.succeeded", "review-success");
    expect(settled).toEqual(["review-success"]);
    expect(observed).toEqual(["review-success"]);

    handle("session.status", "review-failure", { status: { type: "busy" } });
    handle("session.execution.interrupted", "review-failure");
    handle("session.execution.failed", "review-failure");
    expect(rejected).toEqual(["review-failure"]);
  });

  test("uses quality-preserving review opportunity defaults", () => {
    const { config } = plugin.resolveSkills(undefined);
    expect(config.nudge).toEqual({ toolCalls: 6, turns: 2 });
    expect(config.trigger).toEqual({
      stepThreshold: 100,
      endOfSessionMinSteps: 10,
      explicitImmediate: true,
    });
    expect(config.reviewTimeoutMs).toBe(10 * 60_000);
  });

  test("accepts custom trigger cadence", () => {
    const { config } = plugin.resolveSkills({
      trigger: {
        stepThreshold: 250,
        endOfSessionMinSteps: 20,
        explicitImmediate: false,
      },
    });
    expect(config.trigger).toEqual({
      stepThreshold: 250,
      endOfSessionMinSteps: 20,
      explicitImmediate: false,
    });
  });

  test("end-of-session launch gate requires launchReview + min steps + no blockers", () => {
    const activeCfg = plugin.resolveSkills({ evolutionMode: "active" }).config;
    const baseFlags = {
      isReview: false,
      inFlight: false,
      launching: false,
      shuttingDown: false,
      turns: 10,
      inCooldown: false,
    };
    expect(
      plugin.__endOfSessionEligible(
        activeCfg,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        baseFlags,
      ),
    ).toBe(true);
    expect(
      plugin.__endOfSessionEligible(
        activeCfg,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        {
          ...baseFlags,
          turns: 9,
        },
      ),
    ).toBe(false);
    expect(
      plugin.__endOfSessionEligible(
        activeCfg,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        {
          ...baseFlags,
          inCooldown: true,
        },
      ),
    ).toBe(false);
    expect(
      plugin.__endOfSessionEligible(
        activeCfg,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        {
          ...baseFlags,
          inFlight: true,
        },
      ),
    ).toBe(false);
    expect(
      plugin.__endOfSessionEligible(
        activeCfg,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        {
          ...baseFlags,
          isReview: true,
        },
      ),
    ).toBe(false);
    expect(
      plugin.__endOfSessionEligible(
        plugin.resolveSkills({ evolutionMode: "shadow" }).config,
        plugin.__PRODUCTION_BOOTSTRAP_READY,
        baseFlags,
      ),
    ).toBe(false);
  });

  test("keeps low-evidence and unresolved work out of review", () => {
    const options = { nudge: { toolCalls: 6, turns: 2 }, sessionID: "owner" };
    const noTool = plugin.__classifyEvidence(
      [
        { role: "user", parts: [{ kind: "text", summary: "hello" }] },
        {
          role: "assistant",
          completedAt: 1,
          parts: [{ kind: "text", summary: "answer" }],
        },
      ],
      new Set(),
      options,
    );
    expect(noTool.eligible).toBe(false);
    expect(noTool.excluded).toBe("no-tool-chat");

    for (const [summary, excluded] of [
      ["assertion failed", "unresolved-failure"],
      ["command not found", "env-dependent-failure"],
    ]) {
      const failed = plugin.__classifyEvidence(
        [
          { role: "user", parts: [{ kind: "text", summary: "fix it" }] },
          {
            role: "assistant",
            completedAt: 1,
            parts: [
              {
                kind: "tool-result",
                toolName: "shell",
                toolStatus: "error",
                summary,
              },
            ],
          },
        ],
        new Set(["durable-instruction"]),
        options,
      );
      expect(failed.eligible).toBe(false);
      expect(failed.excluded).toBe(excluded);
    }
  });

  test("admits verified tool-heavy work at the tuned threshold", () => {
    const classification = plugin.__classifyEvidence(
      [
        {
          role: "user",
          parts: [{ kind: "text", summary: "implement the reusable workflow" }],
        },
        {
          role: "assistant",
          completedAt: 1,
          parts: Array.from({ length: 6 }, (_, index) => ({
            kind: "tool-result",
            toolName: `tool-${index}`,
            toolStatus: "completed",
            summary: "verified",
          })),
        },
      ],
      new Set(),
      { nudge: { toolCalls: 6, turns: 2 }, sessionID: "owner" },
    );
    expect(classification.eligible).toBe(true);
    expect(classification.sources).toContain("tool-heavy-success");
    expect(classification.excluded).toBeUndefined();
  });

  test("normalizes idle events into execution success", () => {
    expect(
      plugin.__normalizeEvent({
        id: "evt-status-idle",
        type: "session.status",
        data: { sessionID: "ses-current", status: { type: "idle" } },
      }),
    ).toMatchObject({
      eventID: "evt-status-idle",
      sessionID: "ses-current",
      type: "session.execution.succeeded",
    });
    expect(
      plugin.__normalizeEvent({
        type: "session.idle",
        data: { sessionID: "ses-legacy" },
      }),
    ).toMatchObject({
      sessionID: "ses-legacy",
      type: "session.execution.succeeded",
    });
    expect(
      plugin.__normalizeEvent({
        type: "session.status",
        data: { sessionID: "ses-busy", status: { type: "busy" } },
      }),
    ).toMatchObject({
      sessionID: "ses-busy",
      type: "session.status",
    });
  });

  test("enables only the configured production evolution modes", () => {
    const base = { writeApproval: false };
    expect(
      plugin.__evolutionGates(
        { ...base, evolutionMode: "off" },
        plugin.__PRODUCTION_BOOTSTRAP_READY,
      ),
    ).toEqual({ observe: false, launchReview: false, mutate: false });
    expect(
      plugin.__evolutionGates(
        { ...base, evolutionMode: "dry-run" },
        plugin.__PRODUCTION_BOOTSTRAP_READY,
      ),
    ).toEqual({ observe: true, launchReview: true, mutate: false });
    expect(
      plugin.__evolutionGates(
        { ...base, evolutionMode: "active" },
        plugin.__PRODUCTION_BOOTSTRAP_READY,
      ),
    ).toEqual({ observe: true, launchReview: true, mutate: true });
  });

  test("recovers an incomplete transaction when a workspace is discovered", () => {
    const root = join(workspace, "startup-recovery");
    const target = makeSkill(root, "target-skill");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    const backup = join(tx.stagingDirFor("attempt-recovery"), "backup");
    plugin.__copyTree(target, backup);
    tx.begin({
      attemptID: "attempt-recovery",
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID: "review",
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
      backupPath: backup,
      backupHash: plugin.__treeHashOf(backup),
    });
    writeFileSync(
      join(target, "SKILL.md"),
      skillContent("target-skill", "# Incomplete\n"),
    );
    tx.recordMutation({
      attemptID: "attempt-recovery",
      action: "edit",
      relativePath: "SKILL.md",
      inputText: "edit",
      stagedTreeHash: plugin.__treeHashOf(target),
    });
    const logs: string[] = [];
    const fake = {
      recoveredRoots: new Set<string>(),
      app: {
        host: { log: (_level: string, message: string) => logs.push(message) },
      },
    };

    plugin.__SkillsSubsystem.prototype.recoverTransactions.call(fake, root);

    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain(
      "# Workflow",
    );
    expect(tx.read("attempt-recovery").phase).toBe("reverted");
    expect(
      logs.some((message) => message.includes("rolled back incomplete")),
    ).toBe(true);
  });

  test("recovers a crash after disk write but before mutation ledger", () => {
    const root = join(workspace, "write-ahead-recovery");
    const target = makeSkill(root, "target-skill");
    const tx = new plugin.__SkillTransactionStore({ workspaceRoot: root });
    const backup = join(tx.stagingDirFor("attempt-write-ahead"), "backup");
    plugin.__copyTree(target, backup);
    tx.begin({
      attemptID: "attempt-write-ahead",
      candidateID: "candidate",
      candidateRevision: 1,
      reviewID: "review",
      targetStateRoot: target,
      targetSkill: "target-skill",
      targetScope: "project",
      beforeExists: true,
      beforeTreeHash: plugin.__treeHashOf(target),
      backupPath: backup,
      backupHash: plugin.__treeHashOf(backup),
    });
    const changed = skillContent("target-skill", "# Written before crash\n");
    tx.prepareMutation({
      attemptID: "attempt-write-ahead",
      action: "edit",
      relativePath: "SKILL.md",
      afterTreeHash: plugin.__treeHashOf(target, {
        path: "SKILL.md",
        content: changed,
      }),
    });
    writeFileSync(join(target, "SKILL.md"), changed);
    const fake = {
      recoveredRoots: new Set<string>(),
      app: { host: { log() {} } },
    };

    plugin.__SkillsSubsystem.prototype.recoverTransactions.call(fake, root);

    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain(
      "# Workflow",
    );
    expect(tx.read("attempt-write-ahead").phase).toBe("reverted");
  });
});
