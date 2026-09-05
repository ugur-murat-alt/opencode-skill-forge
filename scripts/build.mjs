import { mkdir, cp, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
for (const [entry, output] of [
  ["src/index.ts", "dist/index.js"],
  ["src/cli/main.ts", "dist/cli.js"],
  ["src/skills/archive-worker.ts", "dist/archive-worker.js"],
]) {
  const result = spawnSync(
    "bun",
    [
      "build",
      entry,
      "--outfile",
      output,
      "--target=node",
      "--format=esm",
      "--packages=external",
    ],
    { stdio: "inherit", cwd: new URL("../", import.meta.url) },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await cp(
  new URL("../prompts/", import.meta.url),
  new URL("../dist/prompts/", import.meta.url),
  { recursive: true },
);
await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);

const web = spawnSync(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "build", "--config", "web/vite.config.ts"],
  { stdio: "inherit", cwd: new URL("../", import.meta.url) },
);
if (web.status !== 0) process.exit(web.status ?? 1);
