import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyCache } from "../src/execution/dependencies.js";
import { command, DockerExecutor } from "../src/execution/docker.js";
import { validatePackage } from "../src/skills/validate.js";
test("real locked npm dependency: install scripts disabled, sandbox execution, verified cache reuse and corruption denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-deps-test-")),
    snapshot = join(root, "package");
  await mkdir(join(snapshot, "scripts"), { recursive: true });
  const lock = JSON.stringify({
    name: "locked-test",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "locked-test",
        version: "1.0.0",
        dependencies: { "is-number": "7.0.0" },
      },
      "node_modules/is-number": {
        version: "7.0.0",
        resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
        integrity:
          "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      },
    },
  });
  const dependency = {
    runtime: "node" as const,
    lockfile: "package-lock.json",
    sha256: createHash("sha256").update(lock).digest("hex"),
  };
  const files = {
    "SKILL.md": Buffer.from(
      "---\nname: locked-test\ndescription: Recognize numeric JSON values with a pinned dependency.\n---\nRun the registered numeric entry.\n",
    ),
    "package.json": Buffer.from(
      JSON.stringify({
        name: "locked-test",
        version: "1.0.0",
        dependencies: { "is-number": "7.0.0" },
        scripts: {
          postinstall:
            "node -e \"require('fs').writeFileSync('/deps/forbidden-marker','bad')\"",
        },
      }),
    ),
    "package-lock.json": Buffer.from(lock),
    "scripts/main.js": Buffer.from(
      "console.log(JSON.stringify({numeric:require('is-number')(42)}))",
    ),
    "forge.json": Buffer.from(
      JSON.stringify({
        version: 1,
        dependencies: dependency,
        entrypoints: {
          numeric: {
            runtime: "node",
            path: "scripts/main.js",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { numeric: { type: "boolean" } },
              required: ["numeric"],
            },
            tests: [{ name: "number", input: {}, expected: { numeric: true } }],
          },
        },
      }),
    ),
  };
  try {
    for (const [path, bytes] of Object.entries(files))
      await writeFile(join(snapshot, path), bytes, { mode: 0o644 });
    await expect(
      new DependencyCache(root, "test-scope", false).prepare(
        snapshot,
        dependency,
      ),
    ).rejects.toMatchObject({ code: "dependency_network_disabled" });
    await expect(
      new DependencyCache(root, "cancel-scope", true).prepare(
        snapshot,
        dependency,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "dependency_cancelled" });
    const cancellation = new AbortController();
    const pending = new DependencyCache(root, "cancel-scope", true).prepare(
      snapshot,
      dependency,
      cancellation.signal,
    );
    const timer = setTimeout(() => cancellation.abort(), 50);
    try {
      await expect(pending).rejects.toMatchObject({
        code: "dependency_cancelled",
      });
    } finally {
      clearTimeout(timer);
    }
    const remaining = await command(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=skill-forge.dependency-scope=${createHash("sha256").update("cancel-scope").digest("hex")}`,
        "--format",
        "{{.Names}}",
      ],
      { timeoutMs: 5000 },
    );
    expect(remaining.code).toBe(0);
    expect(remaining.stdout.trim()).toBe("");
    expect(
      (await readdir(join(root, "dependency-cache"))).filter((name) =>
        name.startsWith(".staging-"),
      ),
    ).toHaveLength(0);
    const cache = await new DependencyCache(root, "test-scope", true).prepare(
      snapshot,
      dependency,
    );
    await expect(
      readFile(join(cache, "forbidden-marker")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await new DependencyCache(root, "test-scope", false).prepare(
        snapshot,
        dependency,
      ),
    ).toBe(cache);
    const result = await new DockerExecutor(root, {
      trustScope: "test-scope",
      allowDependencyInstall: false,
    }).execute(snapshot, validatePackage("locked-test", files), "numeric", {});
    expect(result.result).toEqual({ numeric: true });
    await writeFile(join(cache, "node_modules/is-number/index.js"), "modified");
    await expect(
      new DependencyCache(root, "test-scope", false).prepare(
        snapshot,
        dependency,
      ),
    ).rejects.toMatchObject({ code: "dependency_cache_corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 150000);

test("real hashed Python wheel installs, runs offline and rejects modified cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-python-deps-"));
  const snapshot = join(root, "package");
  // Official PyPI packaging 25.0 wheel metadata: https://pypi.org/pypi/packaging/25.0/json
  const lock =
    "packaging==25.0 --hash=sha256:29572ef2b1f17581046b3a2227d5c611fb25ec70ca1ba8554b24b0e69331a484\n";
  const dependency = {
    runtime: "python" as const,
    lockfile: "requirements.txt",
    sha256: createHash("sha256").update(lock).digest("hex"),
  };
  const files = {
    "SKILL.md": Buffer.from(
      "---\nname: python-locked\ndescription: Compare pinned Python package versions.\n---\nRun the registered comparison helper.\n",
    ),
    "requirements.txt": Buffer.from(lock),
    "scripts/main.py": Buffer.from(
      'import json\nfrom packaging.version import Version\nprint(json.dumps({"newer": Version("2.0") > Version("1.9")}))\n',
    ),
    "forge.json": Buffer.from(
      JSON.stringify({
        version: 1,
        dependencies: dependency,
        entrypoints: {
          compare: {
            runtime: "python",
            path: "scripts/main.py",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { newer: { type: "boolean" } },
              required: ["newer"],
            },
            tests: [
              { name: "version order", input: {}, expected: { newer: true } },
            ],
          },
        },
      }),
    ),
  };
  try {
    await mkdir(join(snapshot, "scripts"), { recursive: true });
    for (const [path, bytes] of Object.entries(files))
      await writeFile(join(snapshot, path), bytes, { mode: 0o644 });
    const cache = await new DependencyCache(root, "python-scope", true).prepare(
      snapshot,
      dependency,
    );
    expect(
      await new DependencyCache(root, "python-scope", false).prepare(
        snapshot,
        dependency,
      ),
    ).toBe(cache);
    const result = await new DockerExecutor(root, {
      trustScope: "python-scope",
      allowDependencyInstall: false,
    }).execute(
      snapshot,
      validatePackage("python-locked", files),
      "compare",
      {},
    );
    expect(result.result).toEqual({ newer: true });
    await writeFile(join(cache, "python/packaging/version.py"), "modified");
    await expect(
      new DependencyCache(root, "python-scope", false).prepare(
        snapshot,
        dependency,
      ),
    ).rejects.toMatchObject({ code: "dependency_cache_corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 150000);
