import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const paths = [];
async function collect(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink())
    throw Error(
      `Evidence source must not be a symlink: ${relative(root, path)}`,
    );
  if (stat.isDirectory()) {
    for (const entry of (await readdir(path)).sort())
      await collect(join(path, entry));
  } else if (stat.isFile()) paths.push(path);
}
for (const path of [
  "src",
  "web/src",
  "prompts",
  "scripts/build.mjs",
  "web/vite.config.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
])
  await collect(join(root, path));
const files = [];
for (const path of paths.sort())
  files.push({
    path: relative(root, path),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
const fingerprint = createHash("sha256")
  .update(JSON.stringify(files))
  .digest("hex");
process.stdout.write(
  JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      fingerprint,
      files,
    },
    null,
    2,
  ) + "\n",
);
