import { EgressNetwork } from "./egress.js";
import { DependencyCache } from "./dependencies.js";
import { NODE_COLLECTOR, PYTHON_COLLECTOR } from "./collectors.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { ForgeError } from "../domain/errors.js";
import { readPackageDirectory, validateInventory } from "../skills/paths.js";
import { validatePackage, type PackageManifest } from "../skills/validate.js";
import type { ScriptValidation } from "../skills/store.js";
export const SANDBOX_IMAGES = {
  node: "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e",
  python:
    "python@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e",
};
interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}
export async function command(
  binary: string,
  argv: string[],
  options: {
    input?: string;
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(binary, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      timedOut = false,
      truncated = false,
      finished = false;
    const stop = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, options.timeoutMs);
    const settle = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolveResult({ code, stdout, stderr, timedOut, truncated });
    };
    for (const [stream, output] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const)
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 65536)) {
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        if (output === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      });
    child.on("error", () => settle(127));
    child.on("close", (code) => settle(code ?? 137));
    child.stdin.on("error", () => {});
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdin.end(options.input ?? "");
  });
}
function schemaValidator(schema: Record<string, unknown>) {
  // Keep untrusted schemas bounded and prohibit remote refs and regex execution.
  if (JSON.stringify(schema).length > 16384)
    throw new ForgeError("schema_limit", "Giriş/çıkış şeması çok büyük.");
  function inspect(value: unknown, depth: number) {
    if (depth > 12)
      throw new ForgeError("schema_limit", "Şema derinliği aşıldı.");
    if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        if (
          [
            "$ref",
            "$dynamicRef",
            "pattern",
            "patternProperties",
            "format",
          ].includes(key)
        )
          throw new ForgeError(
            "unsupported_schema_feature",
            "Script şeması referans/regex/format yürütmesi içeremez.",
          );
        inspect(entry, depth + 1);
      }
  }
  inspect(schema, 0);
  try {
    return new Ajv({
      strict: true,
      allErrors: false,
      ownProperties: true,
    }).compile(schema);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "invalid_script_schema",
      "Script JSON şeması geçersiz.",
    );
  }
}
export interface ExecutionResult {
  execution_id: string;
  status: "completed" | "failed";
  result: unknown;
  stdout: string;
  stderr: string;
  artifacts: { path: string; bytes: number }[];
  artifact_dir: string;
  elapsed_ms: number;
  sandbox: string;
}
export class DockerExecutor {
  constructor(
    readonly dataDir: string,
    readonly policy: {
      trustScope: string;
      allowDependencyInstall: boolean;
      allowedOrigins?: readonly string[];
    } = { trustScope: "local", allowDependencyInstall: false },
  ) {}
  async probe() {
    const info = await command(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 3000 },
    );
    const images = await Promise.all(
      Object.values(SANDBOX_IMAGES).map((image) =>
        command("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
          timeoutMs: 3000,
        }),
      ),
    );
    return {
      available: info.code === 0 && images.every((image) => image.code === 0),
      version: info.code === 0 ? info.stdout.trim() : null,
      images: Object.keys(SANDBOX_IMAGES).map((runtime, i) => ({
        runtime,
        available: images[i]!.code === 0,
      })),
    };
  }
  async execute(
    packagePath: string,
    manifest: PackageManifest,
    entryName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const entry = manifest.execution?.entrypoints[entryName];
    if (!entry)
      throw new ForgeError(
        "entrypoint_unavailable",
        "Kayıtlı script girişi bulunamadı.",
        404,
      );
    if (
      entry.network.some(
        (origin) => !this.policy.allowedOrigins?.includes(origin),
      )
    )
      throw new ForgeError(
        "network_policy_denied",
        "Script hedefi etkin ağ izin listesinde değil.",
        403,
      );
    const validateInput = schemaValidator(entry.inputSchema),
      validateOutput = schemaValidator(entry.outputSchema);
    if (JSON.stringify(args).length > 65536 || !validateInput(args))
      throw new ForgeError(
        "invalid_script_input",
        "Script girdisi şemayla uyuşmuyor.",
      );
    const files = await readPackageDirectory(packagePath),
      checked = validatePackage(manifest.name, files);
    if (checked.hash !== manifest.hash)
      throw new ForgeError(
        "revision_corrupt",
        "Script paketi sürüm hash'i uyuşmuyor.",
        409,
      );
    const runtime = entry.runtime === "python" ? "python" : "node",
      image = SANDBOX_IMAGES[runtime];
    const available = await command(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeoutMs: 3000 },
    );
    if (available.code !== 0)
      throw new ForgeError(
        "sandbox_unavailable",
        "Sabitlenmiş sandbox image'i bulunamadı; doctor ile kontrol edin.",
        503,
      );
    const executionId = randomUUID(),
      name = `forge-${executionId}`;
    const root = resolve(this.dataDir, "execution", executionId),
      snapshot = join(root, "package"),
      artifacts = join(root, "artifacts");
    await mkdir(snapshot, { recursive: true, mode: 0o755 });
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(dirname(join(snapshot, path)), {
        recursive: true,
        mode: 0o755,
      });
      await writeFile(join(snapshot, path), bytes, { mode: 0o644, flag: "wx" });
    }
    await chmod(snapshot, 0o755);
    const dependency = manifest.execution?.dependencies;
    const cache = dependency
      ? await new DependencyCache(
          this.dataDir,
          this.policy.trustScope,
          this.policy.allowDependencyInstall,
        ).prepare(snapshot, dependency, signal)
      : null;
    if (cache && dependency?.runtime === "node")
      await mkdir(join(snapshot, "node_modules"), {
        recursive: true,
        mode: 0o755,
      });
    const egress = entry.network.length
      ? new EgressNetwork(executionId, root)
      : null;
    const networkArgs = egress
      ? await egress.start(
          entry.network,
          this.policy.allowedOrigins ?? [],
          signal,
        )
      : ["--network", "none"];
    const mounts =
      cache && dependency
        ? dependency.runtime === "node"
          ? [
              "--mount",
              `type=bind,src=${join(cache, "node_modules")},dst=/package/node_modules,readonly`,
            ]
          : [
              "--mount",
              `type=bind,src=${join(cache, "python")},dst=/deps,readonly`,
              "--env",
              "PYTHONPATH=/deps",
            ]
        : [];
    const started = performance.now();
    try {
      const launch = await command(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          name,
          "--user",
          "65534:65534",
          "--read-only",
          ...networkArgs,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--cpus",
          "1",
          "--memory",
          `${entry.memoryMb}m`,
          "--memory-swap",
          `${entry.memoryMb}m`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=32m",
          "--tmpfs",
          "/output:rw,nosuid,nodev,size=16m,mode=1777",
          "--mount",
          `type=bind,src=${snapshot},dst=/package,readonly`,
          "--workdir",
          "/output",
          "--env",
          "HOME=/tmp",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          ...mounts,
          image,
          runtime,
          ...(runtime === "node"
            ? ["-e", "setInterval(()=>{},1000)"]
            : ["-c", "import time; time.sleep(3600)"]),
        ],
        { timeoutMs: 15000, signal },
      );
      if (launch.code !== 0)
        throw new ForgeError(
          "sandbox_unavailable",
          "İzole container başlatılamadı.",
          503,
        );
      const run = await command(
        "docker",
        [
          "exec",
          "--interactive",
          name,
          runtime,
          ...(runtime === "node" && egress ? ["--use-env-proxy"] : []),
          `/package/${entry.path}`,
        ],
        {
          input: JSON.stringify(args),
          timeoutMs: entry.timeoutMs,
          maxBytes: entry.maxOutputBytes,
          signal,
        },
      );
      if (run.timedOut)
        throw new ForgeError(
          "script_timeout",
          "Script süre sınırını aştı veya iptal edildi.",
          408,
        );
      if (run.truncated)
        throw new ForgeError(
          "script_output_limit",
          "Script çıktı sınırını aştı.",
          422,
        );
      if (run.code !== 0)
        throw new ForgeError(
          "script_failed",
          `Script başarısız (exit ${run.code}).`,
          422,
        );
      let result: unknown;
      try {
        result = JSON.parse(run.stdout);
      } catch {
        throw new ForgeError(
          "script_output_invalid",
          "Script stdout geçerli JSON olmalıdır.",
          422,
        );
      }
      if (!validateOutput(result))
        throw new ForgeError(
          "script_output_invalid",
          "Script çıktısı şemayla uyuşmuyor.",
          422,
        );
      const collected = await command(
        "docker",
        [
          "exec",
          name,
          runtime,
          runtime === "node" ? "-e" : "-c",
          runtime === "node" ? NODE_COLLECTOR : PYTHON_COLLECTOR,
        ],
        { timeoutMs: 5000, maxBytes: 6 * 1024 * 1024, signal },
      );
      if (collected.code !== 0 || collected.truncated)
        throw new ForgeError(
          "artifact_copy_failed",
          "Script artifact'leri güvenli biçimde alınamadı.",
          422,
        );
      const envelope: unknown = JSON.parse(collected.stdout);
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        throw new ForgeError("artifact_invalid", "Artifact zarfı geçersiz.");
      validateInventory(Object.keys(envelope));
      let outputBytes = 0;
      const outputFiles: Record<string, Buffer> = {};
      for (const [path, content] of Object.entries(envelope)) {
        if (
          typeof content !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
        )
          throw new ForgeError(
            "artifact_invalid",
            "Artifact kodlaması geçersiz.",
          );
        const bytes = Buffer.from(content, "base64");
        outputBytes += bytes.length;
        if (outputBytes > 4 * 1024 * 1024)
          throw new ForgeError(
            "artifact_limit",
            "Artifact boyut sınırı aşıldı.",
          );
        await mkdir(dirname(join(artifacts, path)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(artifacts, path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        outputFiles[path] = bytes;
      }
      return {
        execution_id: executionId,
        status: "completed",
        result,
        stdout: run.stdout,
        stderr: run.stderr,
        artifacts: Object.entries(outputFiles).map(([path, bytes]) => ({
          path,
          bytes: bytes.length,
        })),
        artifact_dir: artifacts,
        elapsed_ms: performance.now() - started,
        sandbox: image,
      };
    } finally {
      await command("docker", ["rm", "--force", name], {
        timeoutMs: 5000,
        maxBytes: 4096,
      });
      await egress?.close();
    }
  }
  async validate(
    packagePath: string,
    manifest: PackageManifest,
  ): Promise<ScriptValidation> {
    const reports = [];
    for (const [name, entry] of Object.entries(
      manifest.execution?.entrypoints ?? {},
    ))
      for (const test of entry.tests) {
        const result = await this.execute(
          packagePath,
          manifest,
          name,
          test.input,
        );
        reports.push({
          entrypoint: name,
          test: test.name,
          passed: isDeepStrictEqual(result.result, test.expected),
          execution_id: result.execution_id,
          elapsed_ms: result.elapsed_ms,
        });
      }
    return {
      hash: manifest.hash,
      passed: reports.length > 0 && reports.every((report) => report.passed),
      sandbox: "docker",
      report: reports,
    };
  }
}
