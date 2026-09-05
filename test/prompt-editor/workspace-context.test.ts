import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWorkspaceContext } from "../legacy-runtime/prompt-editor/workspace-context.js";
import type { PluginRuntime } from "../legacy-runtime/prompt-editor/types.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0))
    rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "pe-workspace-"));
  sandboxes.push(path);
  return path;
}

describe("collectWorkspaceContext", () => {
  test("collects bounded repository facts and active external plugins", async () => {
    const root = sandbox();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "example-app",
        description: "Builds widgets\nfor teams",
      }),
    );
    writeFileSync(
      join(root, "README.md"),
      "# Example\n\nRepository purpose.\nAPI_TOKEN=super-secret-value",
    );
    const ctx = {
      plugin: {
        list: async () => ({
          data: [
            { id: "opencode.agent", source: { type: "builtin" } },
            {
              id: "example-plugin",
              source: { type: "package", package: "example-plugin@1.0.0" },
            },
          ],
        }),
      },
    } as unknown as PluginRuntime;

    const result = await collectWorkspaceContext(
      ctx,
      join(root, "packages", "app"),
    );

    expect(result.root).toBe(root);
    expect(result.gitRepository).toBe(true);
    expect(result.manifest).toEqual({
      file: "package.json",
      name: "example-app",
      description: "Builds widgets for teams",
    });
    expect(result.topLevelEntries).toContain("src/");
    expect(result.topLevelEntries).not.toContain("node_modules/");
    expect(result.readme?.excerpt).toContain("Repository purpose.");
    expect(result.readme?.excerpt).not.toContain("super-secret-value");
    expect(result.readme?.excerpt).toContain("[redacted]");
    expect(result.activePlugins).toEqual(["example-plugin"]);
  });

  test("falls back to a manifest root when no Git repository exists", async () => {
    const root = sandbox();
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "sample-crate"\ndescription = "A sample crate"\n',
    );

    const result = await collectWorkspaceContext(
      {} as PluginRuntime,
      join(root, "src", "nested"),
    );

    expect(result.root).toBe(root);
    expect(result.gitRepository).toBe(false);
    expect(result.manifest).toEqual({
      file: "Cargo.toml",
      name: "sample-crate",
      description: "A sample crate",
    });
    expect(result.activePlugins).toEqual([]);
  });
});
