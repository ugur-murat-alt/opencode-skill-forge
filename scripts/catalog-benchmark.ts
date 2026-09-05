import { mkdtemp, writeFile, rm, cp, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
const count = Number(process.argv[2] ?? 10000);
if (!Number.isInteger(count) || count < 10 || count > 10000)
  throw Error("Catalog size must be 10–10000");
const soakMinutes = Number(
  process.argv.find((value) => value.startsWith("--soak="))?.split("=")[1] ?? 0,
);
if (!Number.isInteger(soakMinutes) || soakMinutes < 0 || soakMinutes > 60)
  throw Error("Soak minutes must be 0–60");
const output = resolve(
  process.argv[3] ?? "docs/evidence/p07-catalog-benchmark.json",
);
const cpuProfile = process.argv.includes("--cpu-profile");
if (cpuProfile && !output.endsWith(".json"))
  throw Error("CPU profile requires an explicit .json report path");
const profilePath = output.replace(/\.json$/, ".cpuprofile");
const root = await mkdtemp(join(tmpdir(), "forge-catalog-benchmark-"));
let storage: Awaited<ReturnType<typeof openDatabase>> | undefined;
try {
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  await mkdir(join(runtime, "scripts"));
  for (const name of [
    "catalog-probe.mjs",
    "benchmark-runtime.mjs",
    "benchmark-measure.mjs",
    "benchmark-sql.mjs",
  ])
    await cp(resolve("scripts", name), join(runtime, "scripts", name));
  await cp(resolve("dist"), join(runtime, "dist"), { recursive: true });
  await cp(resolve("bun.lock"), join(runtime, "bun.lock"));
  await symlink(resolve("node_modules"), join(runtime, "node_modules"), "dir");
  storage = await openDatabase({ dataDir: root });
  const auth = new IdentityService(storage.db),
    owner = await auth.bootstrapLocal(),
    project = await auth.createProject(owner, "Catalog benchmark fixture");
  const forge = new ForgeService(
    storage,
    root,
    "fixture-benchmark-signing-key",
  );
  const seedHash = createHash("sha256");
  let baselineBytes = 0;
  let sample: { skill_id: string; revision: string } | undefined;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const name = `catalog-fixture-${String(i).padStart(5, "0")}`;
    const content = `---\nname: ${name}\ndescription: Catalog benchmark deterministic fixture category ${i % 100}.\n---\nRead this bounded reference for item ${i}.\n`;
    seedHash.update(content);
    const published = await forge.packages.publish(owner, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: { "SKILL.md": Buffer.from(content) },
    });
    if (i === 0) sample = published;
    if (i === 9)
      baselineBytes = Buffer.byteLength(
        JSON.stringify(
          await forge.invoke("forge_search", owner, {
            project_ref: project.id,
            limit: 5,
          }),
        ),
      );
    if ((i + 1) % 1000 === 0)
      console.log(
        JSON.stringify({
          published: i + 1,
          total: count,
          elapsed_ms: Math.round(performance.now() - start),
        }),
      );
  }
  const input = {
    cpu_profile: cpuProfile
      ? { path: profilePath, interval_us: 1000, acceptance: false }
      : null,
    sql_profile: process.argv.includes("--sql-profile"),
    matrix: process.argv.includes("--matrix"),
    soak_minutes: soakMinutes,
    runtime_entry: pathToFileURL(join(runtime, "dist/index.js")).href,
    runtime_lock: pathToFileURL(join(runtime, "bun.lock")).href,
    dataDir: root,
    project: project.id,
    sample,
    count,
    baseline_bytes: baselineBytes,
    dataset_sha256: seedHash.digest("hex"),
    seed_ms: performance.now() - start,
  };
  await writeFile(join(root, "input.json"), JSON.stringify(input), {
    mode: 0o600,
  });
  await storage.close();
  await new Promise<void>((ok, no) => {
    const child = spawn(
      "node",
      [
        ...(cpuProfile
          ? [
              "--cpu-prof",
              "--cpu-prof-interval=1000",
              `--cpu-prof-dir=${dirname(profilePath)}`,
              `--cpu-prof-name=${basename(profilePath)}`,
            ]
          : []),
        join(runtime, "scripts/catalog-probe.mjs"),
        join(root, "input.json"),
        output,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SKILL_FORGE_PROFILE: "local",
          SKILL_FORGE_DATA_DIR: root,
          OC_SKILL_POWER_HOME: join(root, "legacy-home"),
        },
        stdio: "inherit",
      },
    );
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? ok() : no(Error(`Probe exit ${code}`)),
    );
  });
} finally {
  await storage?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
