import { open, lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sanitizePromptEditorText } from "./context-snapshot.js";
import type { PluginRuntime } from "./types.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_README_CHARS = 3_000;
const MAX_TEXT_CHARS = 500;
const MAX_TOP_LEVEL_ENTRIES = 64;
const MAX_ACTIVE_PLUGINS = 64;
const PLUGIN_LIST_TIMEOUT_MS = 1_000;

const MANIFEST_FILES = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
] as const;
const IGNORED_ENTRIES = new Set([".git", ".cache", "node_modules", "target"]);

export interface PromptEditorProjectManifest {
  file: string;
  name?: string;
  description?: string;
}

export interface PromptEditorWorkspaceContext {
  /** Exact session working directory. */
  directory: string;
  /** Nearest Git or manifest-backed project root. */
  root: string;
  gitRepository: boolean;
  manifest?: PromptEditorProjectManifest;
  topLevelEntries: readonly string[];
  readme?: {
    file: string;
    excerpt: string;
  };
  /** Active plugin IDs; builtins are omitted when source metadata is available. */
  activePlugins: readonly string[];
}

function clean(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizePromptEditorText(value, maxChars);
  const withoutControls = Array.from(sanitized, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readBounded(path: string): Promise<string | undefined> {
  if (!(await regularFile(path))) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_FILE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function findProjectRoot(
  directory: string,
): Promise<{ root: string; gitRepository: boolean }> {
  let current = resolve(directory);
  let manifestRoot: string | undefined;
  while (true) {
    if (await exists(join(current, ".git"))) {
      return { root: current, gitRepository: true };
    }
    if (
      !manifestRoot &&
      (
        await Promise.all(
          MANIFEST_FILES.map((file) => regularFile(join(current, file))),
        )
      ).some(Boolean)
    ) {
      manifestRoot = current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: manifestRoot ?? resolve(directory), gitRepository: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlValue(
  text: string,
  section: string,
  key: string,
): string | undefined {
  const sectionMatch = text.match(
    new RegExp(
      `(?:^|\\n)\\s*\\[${escapeRegExp(section)}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\[|$)`,
    ),
  );
  const valueMatch = sectionMatch?.[1]?.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`),
  );
  return clean(valueMatch?.[1]);
}

async function readManifest(
  root: string,
): Promise<PromptEditorProjectManifest | undefined> {
  const packageText = await readBounded(join(root, "package.json"));
  if (packageText) {
    try {
      const value = JSON.parse(packageText) as Record<string, unknown>;
      const name = clean(value["name"]);
      const description = clean(value["description"]);
      return {
        file: "package.json",
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      };
    } catch {
      // Continue with other manifest formats.
    }
  }

  const cargo = await readBounded(join(root, "Cargo.toml"));
  if (cargo) {
    const name = tomlValue(cargo, "package", "name");
    const description = tomlValue(cargo, "package", "description");
    return {
      file: "Cargo.toml",
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  }

  const python = await readBounded(join(root, "pyproject.toml"));
  if (python) {
    const name = tomlValue(python, "project", "name");
    const description = tomlValue(python, "project", "description");
    return {
      file: "pyproject.toml",
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  }

  const go = await readBounded(join(root, "go.mod"));
  if (go) {
    const name = clean(go.match(/^\s*module\s+(\S+)/m)?.[1]);
    return { file: "go.mod", ...(name ? { name } : {}) };
  }
  return undefined;
}

async function readStructure(root: string): Promise<{
  entries: string[];
  readme?: PromptEditorWorkspaceContext["readme"];
}> {
  try {
    const directoryEntries = await readdir(root, { withFileTypes: true });
    const visible = directoryEntries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") && !IGNORED_ENTRIES.has(entry.name),
      )
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .slice(0, MAX_TOP_LEVEL_ENTRIES);
    const readmeEntry = directoryEntries.find((entry) =>
      /^readme(?:\.[a-z0-9_-]+)?$/i.test(entry.name),
    );
    const readmeText = readmeEntry
      ? await readBounded(join(root, readmeEntry.name))
      : undefined;
    const excerpt = readmeText
      ? sanitizePromptEditorText(readmeText, MAX_README_CHARS).trim()
      : undefined;
    return {
      entries: visible,
      ...(readmeEntry && excerpt
        ? { readme: { file: readmeEntry.name, excerpt } }
        : {}),
    };
  } catch {
    return { entries: [] };
  }
}

async function activePluginIDs(
  ctx: PluginRuntime,
  directory: string,
): Promise<string[]> {
  if (!ctx.plugin?.list) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      ctx.plugin.list({ location: { directory } }),
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout(undefined),
          PLUGIN_LIST_TIMEOUT_MS,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    const plugins = response?.data;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .filter((plugin) => {
        if (!plugin || typeof plugin !== "object") return false;
        const source = (plugin as { source?: unknown }).source;
        return !(
          source &&
          typeof source === "object" &&
          (source as { type?: unknown }).type === "builtin"
        );
      })
      .map((plugin) => clean((plugin as { id?: unknown }).id, 160))
      .filter((id): id is string => Boolean(id))
      .sort()
      .slice(0, MAX_ACTIVE_PLUGINS);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Collects bounded, best-effort project facts without granting editor tools. */
export async function collectWorkspaceContext(
  ctx: PluginRuntime,
  directory: string,
): Promise<PromptEditorWorkspaceContext> {
  const normalizedDirectory = resolve(directory);
  const project = await findProjectRoot(normalizedDirectory);
  const [manifest, structure, activePlugins] = await Promise.all([
    readManifest(project.root),
    readStructure(project.root),
    activePluginIDs(ctx, normalizedDirectory),
  ]);
  return Object.freeze({
    directory: normalizedDirectory,
    root: project.root,
    gitRepository: project.gitRepository,
    ...(manifest ? { manifest: Object.freeze(manifest) } : {}),
    topLevelEntries: Object.freeze(structure.entries),
    ...(structure.readme ? { readme: Object.freeze(structure.readme) } : {}),
    activePlugins: Object.freeze(activePlugins),
  });
}

export function fallbackWorkspaceContext(
  directory: string,
): PromptEditorWorkspaceContext {
  const normalized = resolve(directory);
  return Object.freeze({
    directory: normalized,
    root: normalized,
    gitRepository: false,
    topLevelEntries: Object.freeze([]),
    activePlugins: Object.freeze([]),
  });
}
