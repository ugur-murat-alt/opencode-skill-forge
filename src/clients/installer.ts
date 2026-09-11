import { parse as parseToml } from "@iarna/toml";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { readFile, mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ForgeError } from "../domain/errors.js";
import {
  hookCapability,
  hookCapabilityReport,
  installableHookEvents,
  type ClientName,
} from "./hook-contract.js";
import {
  removeInstallationBinding,
  writeInstallationBinding,
} from "./hook-binding.js";
export type { ClientName };
interface Change {
  path: string;
  before: string;
  after: string;
}
interface Manifest {
  version: 1;
  client: ClientName;
  project: string;
  entry: string;
  files: { path: string; before: string; after: string; backup: string }[];
}
const START = "<!-- skill-forge:managed:start -->",
  END = "<!-- skill-forge:managed:end -->";
export const CLIENT_INSTRUCTIONS = `${START}\nSkill Forge: use the configured project_ref from the client hook context. Before the final answer, call forge_handoff once with a concise reusable method and actual verification evidence; retain its run_id. If nothing reusable was learned, do not invent evidence. On server failure continue the user's task. Search metadata first and load only relevant files at a pinned revision. Prepared text is additional context; the user's original instructions remain authoritative. Never send private reasoning or raw conversation history.\n${END}`;
function json(text: string) {
  const errors: ParseError[] = [];
  const value = parse(text || "{}", errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new ForgeError(
      "invalid_client_config",
      "İstemci JSON yapılandırması geçersiz.",
    );
  return value as Record<string, any>;
}
function edit(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(
    text || "{}",
    modify(text || "{}", path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
}
async function read(path: string) {
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 2 * 1024 * 1024
    )
      throw new ForgeError(
        "unsafe_client_config",
        "İstemci yapılandırması normal, sınırlı dosya olmalı.",
      );
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
async function safeParents(path: string, root: string) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel.startsWith("/"))
    throw new ForgeError("unsafe_client_path", "İstemci yolu kapsam dışında.");
  let current = root;
  for (const segment of [
    "",
    ...relative(root, dirname(path)).split("/").filter(Boolean),
  ]) {
    current = segment ? join(current, segment) : current;
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ForgeError(
          "unsafe_client_path",
          "İstemci üst dizini symlink veya özel dosya.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function atomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.forge-${randomUUID()}`;
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
}
function shellArg(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
export function hookCommand(
  entry: string,
  args: string[],
  platform = process.platform,
): string {
  const argv = [process.execPath, entry, ...args];
  if (platform === "win32") {
    const script = `& ${argv.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(" ")}; exit $LASTEXITCODE`;
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return argv.map(shellArg).join(" ");
}
export async function installClient(input: {
  client: ClientName;
  projectRoot: string;
  projectRef: string;
  dataDir: string;
  entry: string;
  port: number;
}) {
  const project = resolve(input.projectRoot),
    clientDir = join(project, input.client === "codex" ? ".codex" : ".claude"),
    privateDir = join(
      input.dataDir,
      "installations",
      installationFingerprint([input.client, project]),
    ),
    manifestPath = join(privateDir, "manifest.json");
  const oldManifestText = await read(manifestPath),
    oldManifest = oldManifestText
      ? (JSON.parse(oldManifestText) as Manifest)
      : null;
  const entry = resolve(input.entry),
    args = ["mcp", "--data-dir", input.dataDir, "--port", String(input.port)];
  const mcpPath =
    input.client === "codex"
      ? join(clientDir, "config.toml")
      : join(project, ".mcp.json");
  const hookPath = join(
    clientDir,
    input.client === "codex" ? "hooks.json" : "settings.json",
  );
  const instructionsPath = join(
    project,
    input.client === "codex" ? "AGENTS.md" : "CLAUDE.md",
  );
  for (const target of [mcpPath, hookPath, instructionsPath])
    await safeParents(target, project);
  const changes: Change[] = [];
  const add = (path: string, before: string, after: string) => {
    if (before !== after) changes.push({ path, before, after });
  };
  const mcpBefore = await read(mcpPath);
  if (input.client === "codex") {
    const document = parseToml(mcpBefore),
      existing = (document.mcp_servers as any)?.skill_forge;
    if (
      existing &&
      (existing.command !== process.execPath ||
        JSON.stringify(existing.args) !== JSON.stringify([entry, ...args]))
    )
      throw new ForgeError(
        "client_entry_conflict",
        "skill_forge MCP kaydı başka yapılandırmaya ait; korunuyor.",
        409,
      );
    if (!existing) {
      const block = `\n[mcp_servers.skill_forge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([entry, ...args])}\nstartup_timeout_sec = 25\ntool_timeout_sec = 150\n`;
      const next = mcpBefore + block;
      parseToml(next);
      add(mcpPath, mcpBefore, next);
    }
  } else {
    const document = json(mcpBefore),
      expected = {
        type: "stdio",
        command: process.execPath,
        args: [entry, ...args],
      };
    if (
      document.mcpServers?.skill_forge &&
      JSON.stringify(document.mcpServers.skill_forge) !==
        JSON.stringify(expected)
    )
      throw new ForgeError(
        "client_entry_conflict",
        "skill_forge MCP kaydı başka yapılandırmaya ait; korunuyor.",
        409,
      );
    if (!document.mcpServers?.skill_forge)
      add(
        mcpPath,
        mcpBefore,
        edit(mcpBefore, ["mcpServers", "skill_forge"], expected),
      );
  }
  const hookBefore = await read(hookPath);
  let hookAfter = hookBefore;
  const hookArgs = [
    "hook",
    "--client",
    input.client,
    "--project-ref",
    input.projectRef,
    "--data-dir",
    input.dataDir,
    "--port",
    String(input.port),
  ];
  const command = hookCommand(entry, hookArgs);
  for (const event of installableHookEvents(input.client)) {
    const doc = json(hookAfter),
      groups = doc.hooks?.[event] ?? [];
    if (!Array.isArray(groups))
      throw new ForgeError("invalid_client_hooks", "Hook listesi geçersiz.");
    if (
      !groups.some((group) =>
        group.hooks?.some((hook: any) => hook.command === command),
      )
    )
      hookAfter = edit(
        hookAfter,
        ["hooks", event],
        [
          ...groups,
          {
            hooks: [
              {
                type: "command",
                command,
                timeout: hookCapability(input.client, event).timeoutSeconds,
              },
            ],
          },
        ],
      );
  }
  add(hookPath, hookBefore, hookAfter);
  const instructionsBefore = await read(instructionsPath);
  if (instructionsBefore.includes(START) !== instructionsBefore.includes(END))
    throw new ForgeError(
      "instruction_conflict",
      "Yönetilen talimat bloğu eksik kapanmış.",
      409,
    );
  if (!instructionsBefore.includes(START))
    add(
      instructionsPath,
      instructionsBefore,
      `${instructionsBefore}${instructionsBefore.endsWith("\n") || !instructionsBefore ? "" : "\n"}\n${CLIENT_INSTRUCTIONS}\n`,
    );
  else if (!instructionsBefore.includes(CLIENT_INSTRUCTIONS))
    throw new ForgeError(
      "instruction_conflict",
      "Yönetilen talimat bloğu değişmiş; korunuyor.",
      409,
    );
  if (!changes.length)
    return {
      status: "unchanged",
      client: input.client,
      project_ref: input.projectRef,
      hook_trust: "client_review_required",
      manifest: manifestPath,
      binding: await writeInstallationBinding(input.dataDir, {
        client: input.client,
        projectRef: input.projectRef,
        projectRoot: project,
      }),
      events: hookCapabilityReport(input.client),
    };
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const lockPath = `${manifestPath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ForgeError(
      "installation_busy",
      "İstemci kurulumu başka işlemde çalışıyor.",
      409,
    );
  }
  const manifest: Manifest = oldManifest ?? {
    version: 1,
    client: input.client,
    project,
    entry,
    files: [],
  };
  try {
    for (const change of changes)
      if ((await read(change.path)) !== change.before)
        throw new ForgeError(
          "client_config_changed",
          "Kurulum sırasında istemci dosyası değişti.",
          409,
        );
    for (const change of changes) {
      const backup = join(
        privateDir,
        "backups",
        `${Date.now()}-${randomUUID()}.txt`,
      );
      await atomic(backup, change.before);
      await atomic(change.path, change.after);
      const saved = manifest.files.find((file) => file.path === change.path);
      if (saved) saved.after = change.after;
      else manifest.files.push({ ...change, backup });
      await atomic(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return {
      status: "installed",
      client: input.client,
      project_ref: input.projectRef,
      files: changes.map((change) => change.path),
      hook_trust: "client_review_required",
      manifest: manifestPath,
      binding: await writeInstallationBinding(input.dataDir, {
        client: input.client,
        projectRef: input.projectRef,
        projectRoot: project,
      }),
      events: hookCapabilityReport(input.client),
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export async function uninstallClient(
  client: ClientName,
  projectRoot: string,
  dataDir: string,
) {
  const project = resolve(projectRoot),
    path = join(
      dataDir,
      "installations",
      installationFingerprint([client, project]),
      "manifest.json",
    ),
    raw = await read(path);
  if (!raw) return { status: "unchanged" };
  const manifest = JSON.parse(raw) as Manifest,
    removed: string[] = [],
    conflicts: string[] = [];
  const allowed = new Set(
    client === "codex"
      ? [
          join(project, ".codex", "config.toml"),
          join(project, ".codex", "hooks.json"),
          join(project, "AGENTS.md"),
        ]
      : [
          join(project, ".mcp.json"),
          join(project, ".claude", "settings.json"),
          join(project, "CLAUDE.md"),
        ],
  );
  for (const file of manifest.files) {
    if (!allowed.has(file.path))
      throw new ForgeError(
        "unsafe_installation_manifest",
        "Kurulum manifesti proje sınırı dışında.",
      );
    await safeParents(file.path, project);
    const current = await read(file.path);
    if (current === file.after) {
      await atomic(file.path, file.before);
      removed.push(file.path);
    } else {
      let next: string | null = null;
      try {
        if (file.path.endsWith("config.toml")) {
          const currentDoc = parseToml(current) as any,
            expected = parseToml(file.after) as any,
            previous = parseToml(file.before) as any;
          const block = file.after.slice(file.before.length);
          if (!currentDoc.mcp_servers?.skill_forge) next = current;
          else if (
            !previous.mcp_servers?.skill_forge &&
            JSON.stringify(currentDoc.mcp_servers.skill_forge) ===
              JSON.stringify(expected.mcp_servers.skill_forge) &&
            current.includes(block)
          ) {
            next = current.replace(block, "");
            parseToml(next);
          }
        } else if (file.path.endsWith(".mcp.json")) {
          const currentDoc = json(current),
            expected = json(file.after),
            previous = json(file.before);
          if (!currentDoc.mcpServers?.skill_forge) next = current;
          else if (
            !previous.mcpServers?.skill_forge &&
            JSON.stringify(currentDoc.mcpServers.skill_forge) ===
              JSON.stringify(expected.mcpServers.skill_forge)
          )
            next = edit(current, ["mcpServers", "skill_forge"], undefined);
        } else if (
          file.path.endsWith("hooks.json") ||
          file.path.endsWith("settings.json")
        ) {
          next = current;
          const previous = json(file.before),
            expected = json(file.after);
          for (const event of installableHookEvents(client)) {
            const oldHandlers = new Set(
              (previous.hooks?.[event] ?? []).flatMap((g: any) =>
                (g.hooks ?? []).map((h: any) => JSON.stringify(h)),
              ),
            );
            const owned = new Set(
              (expected.hooks?.[event] ?? [])
                .flatMap((g: any) =>
                  (g.hooks ?? []).map((h: any) => JSON.stringify(h)),
                )
                .filter((h: any) => !oldHandlers.has(h)),
            );
            const groups = (json(next).hooks?.[event] ?? [])
              .map((g: any) => ({
                ...g,
                hooks: (g.hooks ?? []).filter(
                  (h: any) => !owned.has(JSON.stringify(h)),
                ),
              }))
              .filter((g: any) => g.hooks.length);
            next = edit(next, ["hooks", event], groups);
          }
        } else if (current.includes(CLIENT_INSTRUCTIONS))
          next = current.replace(CLIENT_INSTRUCTIONS, "");
        else if (!current.includes(START)) next = current;
      } catch {
        next = null;
      }
      if (next !== null) {
        await atomic(file.path, next);
        removed.push(file.path);
      } else conflicts.push(file.path);
    }
  }
  if (!conflicts.length) {
    await unlink(path);
    // The durable project binding is removed only on a clean uninstall; a
    // preserved user change leaves the binding intact.
    await removeInstallationBinding(dataDir, client, project);
  } else {
    manifest.files = manifest.files.filter((file) =>
      conflicts.includes(file.path),
    );
    await atomic(path, JSON.stringify(manifest, null, 2));
  }
  return {
    status: conflicts.length ? "user_changes_preserved" : "uninstalled",
    removed,
    conflicts,
    events: hookCapabilityReport(client),
  };
}
export function installationFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
