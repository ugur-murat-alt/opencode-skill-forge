import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { PackageStore } from "../src/skills/store.js";
import { EvolutionStaging } from "../src/runner/staging.js";
test("private SPR candidate enforces inventory, read-before-change, exact patch and fenced publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-staging-")), storage = await openDatabase({ dataDir: root });
  try {
    const identity = new IdentityService(storage.db), owner = await identity.bootstrapLocal(), project = await identity.createProject(owner, "Staging test");
    const queue = new JobQueue(storage), store = new PackageStore(storage, root);
    await queue.accept(owner, { projectId: project.id, kind: "skill_evolve", key: "first", payload: { summary: "Verified" } });
    const run = (await queue.claim("test-worker", 30000))!, staging = new EvolutionStaging(store, owner, run);
    const call = async (name: string, args: any) => staging.tools().find(tool => tool.name === name)!.execute("call", args);
    await expect(call("select", { name: "test-method", scope: "project" })).rejects.toMatchObject({ code: "inventory_required" });
    await call("inventory", { query: "test-method" }); await call("select", { name: "test-method", scope: "project" });
    await call("patch", { path: "SKILL.md", old_text: "", new_text: "---\nname: test-method\ndescription: Reusable concrete test method.\n---\nUse exact matching.\n" });
    await expect(call("patch", { path: "SKILL.md", old_text: "matching", new_text: "replacement" })).rejects.toMatchObject({ code: "read_before_change_required" });
    await call("read", { path: "SKILL.md" });
    await expect(call("patch", { path: "SKILL.md", old_text: "absent", new_text: "replacement" })).rejects.toMatchObject({ code: "patch_conflict" });
    await call("finalize", { decision: "create", reason: "Validated package" }); expect(staging.closed).toBe(true);
    await expect(call("patch", { path: "x", old_text: "", new_text: "y" })).rejects.toMatchObject({ code: "run_closed" });
    expect((await store.search(owner, { projectId: project.id })).items).toHaveLength(1);
    await queue.finish(run, "completed", staging.result);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});
