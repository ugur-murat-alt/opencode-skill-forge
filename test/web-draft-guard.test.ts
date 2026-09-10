import { describe, expect, test } from "bun:test";
import {
  clearDraftSnapshot,
  draftDirty,
  draftKeyOf,
  draftScopeKey,
  pathOfDraftKey,
  readDraftSnapshot,
  revisionOfDraftKey,
  stagedContentFor,
  unstagedDraftCount,
  unpublishedWork,
  writeDraftSnapshot,
  type DraftSnapshot,
} from "../web/src/PackageDetail.js";
import {
  clearPromptDraft,
  promptScopeKey,
  readPromptDraft,
  writePromptDraft,
} from "../web/src/AgentPrompts.js";

const empty = (): DraftSnapshot => ({
  drafts: {},
  bases: {},
  changes: [],
  rebase: false,
});

describe("issue #31 draft scope keys", () => {
  test("package scope key separates tenant, project and skill", () => {
    const a = draftScopeKey({
      tenant: "tenant-a",
      project: "project-1",
      skillId: "skill-1",
    });
    const otherTenant = draftScopeKey({
      tenant: "tenant-b",
      project: "project-1",
      skillId: "skill-1",
    });
    const otherProject = draftScopeKey({
      tenant: "tenant-a",
      project: "project-2",
      skillId: "skill-1",
    });
    const otherSkill = draftScopeKey({
      tenant: "tenant-a",
      project: "project-1",
      skillId: "skill-2",
    });
    expect(new Set([a, otherTenant, otherProject, otherSkill]).size).toBe(4);
  });

  test("a stored draft is readable only through its own scope (no tenant leak)", () => {
    const keyA = draftScopeKey({
      tenant: "tenant-a",
      project: "project-1",
      skillId: "skill-1",
    });
    const keyB = draftScopeKey({
      tenant: "tenant-b",
      project: "project-1",
      skillId: "skill-1",
    });
    const snapshot = empty();
    snapshot.drafts[draftKeyOf("rev-1", "SKILL.md")] = "gizli taslak";
    snapshot.bases[draftKeyOf("rev-1", "SKILL.md")] = "sunucu metni";
    try {
      writeDraftSnapshot(keyA, snapshot);
      expect(readDraftSnapshot(keyA)?.drafts).toEqual({
        "rev-1:SKILL.md": "gizli taslak",
      });
      expect(readDraftSnapshot(keyB)).toBeNull();
      // The read result is a copy; mutating it cannot corrupt the store.
      const copy = readDraftSnapshot(keyA)!;
      copy.drafts["rev-1:SKILL.md"] = "değiştirildi";
      expect(readDraftSnapshot(keyA)?.drafts["rev-1:SKILL.md"]).toBe(
        "gizli taslak",
      );
    } finally {
      clearDraftSnapshot(keyA);
      clearDraftSnapshot(keyB);
    }
  });

  test("an empty snapshot is not stored", () => {
    const key = draftScopeKey({
      tenant: "t",
      project: "p",
      skillId: "s",
    });
    writeDraftSnapshot(key, empty());
    expect(readDraftSnapshot(key)).toBeNull();
  });

  test("prompt scope key separates tenants for the same scope name", () => {
    const personal = promptScopeKey("tenant-a", "org");
    const org = promptScopeKey("tenant-b", "org");
    expect(personal).not.toBe(org);
    try {
      writePromptDraft(personal, { text: "kişisel taslak", base: 3 });
      expect(readPromptDraft(personal)).toEqual({
        text: "kişisel taslak",
        base: 3,
      });
      expect(readPromptDraft(org)).toBeNull();
    } finally {
      clearPromptDraft(personal);
      clearPromptDraft(org);
    }
    expect(readPromptDraft(personal)).toBeNull();
  });

  test("draft key round-trips revision and path with colons in the path", () => {
    const key = draftKeyOf("revision-1", "references/a:b.md");
    expect(revisionOfDraftKey(key)).toBe("revision-1");
    expect(pathOfDraftKey(key)).toBe("references/a:b.md");
  });
});

describe("issue #31 unpublished work detection", () => {
  test("a staged candidate alone counts as unpublished work after stage", () => {
    const snapshot = empty();
    const key = draftKeyOf("rev-1", "SKILL.md");
    snapshot.drafts[key] = "yeni metin";
    snapshot.bases[key] = "eski metin";
    snapshot.changes = [
      {
        path: "SKILL.md",
        original_hash: "h1",
        content: "yeni metin",
        staged_in: "rev-1",
      },
    ];
    // The editor text equals the staged content: the old dirty heuristic
    // returned false and Kapat discarded the candidate silently.
    expect(draftDirty(snapshot, "rev-1", "SKILL.md")).toBe(false);
    expect(unpublishedWork(snapshot)).toBe(true);
  });

  test("a draft that matches its base is not unpublished work", () => {
    const snapshot = empty();
    const key = draftKeyOf("rev-1", "SKILL.md");
    snapshot.drafts[key] = "eski metin";
    snapshot.bases[key] = "eski metin";
    expect(unpublishedWork(snapshot)).toBe(false);
  });

  test("a draft newer than the staged candidate is unpublished work", () => {
    const snapshot = empty();
    const key = draftKeyOf("rev-1", "SKILL.md");
    snapshot.drafts[key] = "daha yeni metin";
    snapshot.bases[key] = "eski metin";
    snapshot.changes = [
      {
        path: "SKILL.md",
        original_hash: "h1",
        content: "yeni metin",
        staged_in: "rev-1",
      },
    ];
    expect(draftDirty(snapshot, "rev-1", "SKILL.md")).toBe(true);
    expect(unpublishedWork(snapshot)).toBe(true);
    expect(unstagedDraftCount(snapshot, "rev-1")).toBe(1);
  });

  test("a draft on another revision still counts and does not hide behind the open file", () => {
    const snapshot = empty();
    snapshot.drafts[draftKeyOf("rev-1", "SKILL.md")] = "başka revizyon";
    snapshot.bases[draftKeyOf("rev-1", "SKILL.md")] = "eski";
    expect(draftDirty(snapshot, "rev-2", "SKILL.md")).toBe(false);
    expect(draftDirty(snapshot, "rev-1", "SKILL.md")).toBe(true);
    expect(unpublishedWork(snapshot)).toBe(true);
  });

  test("staged content is only reused for the revision it was staged against", () => {
    const snapshot = empty();
    snapshot.changes = [
      {
        path: "SKILL.md",
        original_hash: "h1",
        content: "rev1 metni",
        staged_in: "rev-1",
      },
    ];
    expect(stagedContentFor(snapshot, "rev-1", "SKILL.md")).toBe("rev1 metni");
    expect(stagedContentFor(snapshot, "rev-2", "SKILL.md")).toBeUndefined();
  });

  test("unstaged draft count ignores drafts already represented in candidates", () => {
    const snapshot = empty();
    const key = draftKeyOf("rev-1", "SKILL.md");
    snapshot.drafts[key] = "yeni metin";
    snapshot.bases[key] = "eski metin";
    snapshot.changes = [
      {
        path: "SKILL.md",
        original_hash: "h1",
        content: "yeni metin",
        staged_in: "rev-1",
      },
    ];
    expect(unstagedDraftCount(snapshot, "rev-1")).toBe(0);
    snapshot.drafts[key] = "yeni metin + kuyruk";
    expect(unstagedDraftCount(snapshot, "rev-1")).toBe(1);
    // A draft reverted to the loaded base is not a publish candidate either.
    snapshot.drafts[key] = "eski metin";
    expect(unstagedDraftCount(snapshot, "rev-1")).toBe(0);
  });
});
