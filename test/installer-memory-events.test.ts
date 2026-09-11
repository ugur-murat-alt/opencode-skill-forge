import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClient, uninstallClient } from "../src/clients/installer.js";
import { installableHookEvents } from "../src/clients/hook-contract.js";
import { installationBindingPath } from "../src/clients/hook-binding.js";

for (const client of ["codex", "claude"] as const)
  test(`${client} install registers exactly the capability events with per-event timeouts and a durable binding`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-install-mem-")),
      project = join(root, "project"),
      dataDir = join(root, "private");
    await mkdir(
      client === "codex" ? join(project, ".codex") : join(project, ".claude"),
      {
        recursive: true,
      },
    );
    const hooksPath =
      client === "codex"
        ? join(project, ".codex", "hooks.json")
        : join(project, ".claude", "settings.json");
    try {
      const first = await installClient({
        client,
        projectRoot: project,
        projectRef: "project-id",
        dataDir,
        entry: "/opt/forge/cli.js",
        port: 23456,
      });
      expect(first.status).toBe("installed");
      const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
      expect(Object.keys(hooks.hooks).sort()).toEqual(
        [...installableHookEvents(client)].sort(),
      );
      for (const event of installableHookEvents(client)) {
        const handlers = hooks.hooks[event].flatMap(
          (group: any) => group.hooks,
        );
        expect(handlers.length).toBe(1);
        expect(handlers[0].type).toBe("command");
        expect(handlers[0].command).toContain(`'--client' '${client}'`);
        expect(handlers[0].command).toContain(`'--project-ref' 'project-id'`);
        expect(handlers[0].async).toBeUndefined();
        expect([5, 10, 2]).toContain(handlers[0].timeout);
      }
      expect(JSON.stringify(hooks)).not.toContain("dangerously-bypass");
      expect(hooks.hooks.Interrupt).toBeUndefined();
      expect(hooks.hooks.PreCompact).toBeUndefined();
      expect(hooks.hooks.PostCompact).toBeUndefined();
      const events = first.events as { event: string; installed: boolean }[];
      expect(events.find((e) => e.event === "Interrupt")?.installed).toBe(
        false,
      );
      expect(events.find((e) => e.event === "PreCompact")?.installed).toBe(
        false,
      );

      const bindingPath = installationBindingPath(dataDir, client, project);
      const binding = JSON.parse(await readFile(bindingPath, "utf8"));
      expect(binding).toMatchObject({
        version: 1,
        client,
        project_ref: "project-id",
        directory: project,
      });

      const second = await installClient({
        client,
        projectRoot: project,
        projectRef: "project-id",
        dataDir,
        entry: "/opt/forge/cli.js",
        port: 23456,
      });
      expect(second.status).toBe("unchanged");
      const afterSecond = JSON.parse(await readFile(hooksPath, "utf8"));
      for (const event of installableHookEvents(client))
        expect(afterSecond.hooks[event].length).toBe(1);

      const removed = await uninstallClient(client, project, dataDir);
      expect(removed.status).toBe("uninstalled");
      await expect(stat(bindingPath)).rejects.toThrow();
      expect(await readFile(hooksPath, "utf8")).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("a user-modified hook file keeps the binding on uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-install-mem-")),
    project = join(root, "project"),
    dataDir = join(root, "private");
  await mkdir(join(project, ".claude"), { recursive: true });
  const hooksPath = join(project, ".claude", "settings.json");
  await writeFile(
    hooksPath,
    JSON.stringify(
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        },
      },
      null,
      2,
    ),
  );
  try {
    await installClient({
      client: "claude",
      projectRoot: project,
      projectRef: "project-id",
      dataDir,
      entry: "/opt/forge/cli.js",
      port: 23456,
    });
    // The user corrupts the hook file after install; uninstall must not
    // rewrite or delete it, and the binding must survive.
    await writeFile(
      hooksPath,
      (await readFile(hooksPath, "utf8")) + "\nTHIS IS NOT JSON\n",
    );
    const result = await uninstallClient("claude", project, dataDir);
    expect(result.status).toBe("user_changes_preserved");
    expect(result.conflicts).toContain(hooksPath);
    expect(await readFile(hooksPath, "utf8")).toContain("THIS IS NOT JSON");
    // The binding survives because managed hooks may still be active.
    await readFile(installationBindingPath(dataDir, "claude", project), "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
