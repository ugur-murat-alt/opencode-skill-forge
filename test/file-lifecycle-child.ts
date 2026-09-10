/**
 * Alt süreç yardımcısı (test): gerçek süreç duraklatma/öldürme senaryolarında
 * PackageStore'un reader lease ve publish/reclaim protokolünü kullanır.
 * Modlar: reconcile | hold-read | publish | staging
 */
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import {
  PackageStore,
  type PackageStoreLiveness,
} from "../src/skills/store.js";
import type { PackageManifest } from "../src/skills/validate.js";

const mode = process.argv[2]!;
const root = process.env.FORGE_TEST_ROOT!;
const resultFile = process.env.FORGE_TEST_RESULT!;
const liveness: PackageStoreLiveness = {
  leaseMs: Number(process.env.FORGE_TEST_LEASE_MS ?? 60_000),
  reclaimGraceMs: Number(process.env.FORGE_TEST_GRACE_MS ?? 10 * 60_000),
  reclaimBudget: Number(process.env.FORGE_TEST_RECLAIM_BUDGET ?? 200),
  claimWaitMs: Number(process.env.FORGE_TEST_CLAIM_WAIT_MS ?? 2_000),
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (value: unknown) => writeFile(resultFile, JSON.stringify(value));
async function waitForFile(path: string, attempts = 3_000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`Zaman aşımı: ${path}`);
}
/** İlk yayın transaction'ını askıda bırakır (rename sonrası commit öncesi crash). */
function stallFirstTransaction(
  storage: Awaited<ReturnType<typeof openDatabase>>,
) {
  const real = storage.db;
  let stalled = false;
  const db = new Proxy(real as object, {
    get(target, prop) {
      if (prop === "transaction" && !stalled) {
        stalled = true;
        return () => ({ execute: () => new Promise(() => {}) });
      }
      const value = (target as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...storage, db } as typeof storage;
}

const storage = await openDatabase({ dataDir: root });
const actor = await new IdentityService(storage.db).bootstrapLocal();
try {
  if (mode === "reconcile") {
    const store = new PackageStore(storage, root, undefined, {}, liveness);
    const result = await store.reconcile(actor);
    await report({ ok: true, checked: result.checked });
  } else if (mode === "hold-read") {
    const store = new PackageStore(storage, root, undefined, {}, liveness);
    try {
      const value = await store.withRevision(
        actor,
        process.env.FORGE_TEST_SKILL!,
        process.env.FORGE_TEST_REVISION!,
        async () => {
          await writeFile(process.env.FORGE_TEST_MARKER!, "holding");
          await waitForFile(process.env.FORGE_TEST_RELEASE!, 6_000);
          return { accepted: true };
        },
      );
      await report({ ok: true, value });
    } catch (error) {
      await report({
        ok: false,
        code: (error as { code?: string }).code ?? "internal_error",
        message: (error as Error).message,
      });
    }
  } else if (mode === "publish") {
    const target =
      process.env.FORGE_TEST_STALL_COMMIT === "1"
        ? stallFirstTransaction(storage)
        : storage;
    const store = new PackageStore(target, root, undefined, {}, liveness);
    try {
      const result = await store.publish(actor, {
        name: process.env.FORGE_TEST_NAME!,
        scope: "project",
        projectId: process.env.FORGE_TEST_PROJECT!,
        skillId: process.env.FORGE_TEST_SKILL!,
        baseRevision: process.env.FORGE_TEST_BASE!,
        files: {
          "SKILL.md": Buffer.from(process.env.FORGE_TEST_CONTENT!),
        },
      });
      await report({ ok: true, result });
    } catch (error) {
      await report({
        ok: false,
        code: (error as { code?: string }).code ?? "internal_error",
        message: (error as Error).message,
      });
    }
  } else if (mode === "staging") {
    const name = process.env.FORGE_TEST_NAME!;
    const store = new PackageStore(
      storage,
      root,
      async (_path, manifest: PackageManifest) => {
        await writeFile(process.env.FORGE_TEST_MARKER!, "validating");
        await waitForFile(process.env.FORGE_TEST_GATE!, 6_000);
        return {
          hash: manifest.hash,
          passed: true,
          sandbox: "fixture",
          report: null,
        };
      },
      {},
      liveness,
    );
    try {
      const result = await store.publish(actor, {
        name,
        scope: "project",
        projectId: process.env.FORGE_TEST_PROJECT!,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Uzun staging sahipliği kabul paketi.\n---\nBody.\n`,
          ),
          "scripts/main.js": Buffer.from("console.log('{}');"),
          "forge.json": Buffer.from(
            JSON.stringify({
              version: 1,
              entrypoints: {
                run: {
                  runtime: "node",
                  path: "scripts/main.js",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" },
                  tests: [{ name: "noop", input: {}, expected: {} }],
                },
              },
            }),
          ),
        },
      });
      await report({ ok: true, result });
    } catch (error) {
      await report({
        ok: false,
        code: (error as { code?: string }).code ?? "internal_error",
        message: (error as Error).message,
      });
    }
  } else {
    await report({ ok: false, code: "unknown_mode" });
  }
} finally {
  await storage.close();
}
