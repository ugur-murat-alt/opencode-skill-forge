import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  readdir,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExecutionManifest } from "../skills/validate.js";
import { ForgeError } from "../domain/errors.js";
import { command, SANDBOX_IMAGES } from "./docker.js";
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new ForgeError(
      "dependency_cancelled",
      "Bağımlılık hazırlama iptal edildi.",
      499,
    );
}
async function treeDigest(root: string, signal?: AbortSignal) {
  const records: string[] = [];
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      checkCancelled(signal);
      const path = join(dir, name),
        stat = await lstat(path),
        rel = relative(root, path);
      if (rel === ".forge-cache.json") continue;
      if (stat.isSymbolicLink()) {
        const actual = await realpath(path);
        if (!actual.startsWith(`${resolve(root)}/`))
          throw new ForgeError(
            "unsafe_dependency",
            "Bağımlılık symlink'i cache dışına çıkıyor.",
          );
        records.push(`${rel}:link:${relative(root, actual)}`);
      } else if (stat.isDirectory()) await walk(path);
      else if (stat.isFile() && stat.nlink === 1)
        records.push(
          `${rel}:${createHash("sha256")
            .update(await readFile(path))
            .digest("hex")}`,
        );
      else
        throw new ForgeError(
          "unsafe_dependency",
          "Bağımlılık özel dosya/link içeriyor.",
        );
      if (records.length > 30000)
        throw new ForgeError(
          "dependency_limit",
          "Bağımlılık dosya sınırı aşıldı.",
        );
    }
  }
  await walk(root);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}
export class DependencyCache {
  constructor(
    readonly dataDir: string,
    readonly trustScope: string,
    readonly allowInstall: boolean,
  ) {}
  async prepare(
    snapshot: string,
    dependency: NonNullable<ExecutionManifest["dependencies"]>,
    signal?: AbortSignal,
  ) {
    checkCancelled(signal);
    const lock = await readFile(join(snapshot, dependency.lockfile));
    if (createHash("sha256").update(lock).digest("hex") !== dependency.sha256)
      throw new ForgeError(
        "dependency_hash_mismatch",
        "Kilitli bağımlılık hash'i değişti.",
      );
    const image = SANDBOX_IMAGES[dependency.runtime];
    if (dependency.runtime === "node") {
      if (dependency.lockfile !== "package-lock.json")
        throw new ForgeError(
          "unsupported_lockfile",
          "Node bağımlılıkları package-lock.json gerektirir.",
        );
      const data = JSON.parse(lock.toString());
      if (data.lockfileVersion !== 3 || !data.packages)
        throw new ForgeError(
          "unsupported_lockfile",
          "npm lockfileVersion 3 gerekiyor.",
        );
      for (const [path, value] of Object.entries(data.packages) as [
        string,
        { resolved?: string; integrity?: string; link?: boolean },
      ][])
        if (path) {
          if (
            value.link ||
            !value.resolved ||
            !value.integrity ||
            !/^sha(256|384|512)-/.test(value.integrity) ||
            new URL(value.resolved).origin !== "https://registry.npmjs.org"
          )
            throw new ForgeError(
              "dependency_source_denied",
              "Bağımlılıklar integrity ile npm resmi registry'ye sabitlenmelidir.",
            );
        }
    } else {
      const lines = lock
        .toString()
        .replace(/\\\r?\n/g, " ")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (
        !lines.length ||
        lines.some(
          (line) =>
            !/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+\s+--hash=sha256:[a-f0-9]{64}(?:\s+--hash=sha256:[a-f0-9]{64})*$/.test(
              line,
            ),
        )
      )
        throw new ForgeError(
          "unsupported_lockfile",
          "Python bağımlılıkları exact sürüm ve SHA-256 hash listesi gerektirir.",
        );
    }
    const key = createHash("sha256")
        .update(
          JSON.stringify([
            this.trustScope,
            dependency.sha256,
            image,
            process.arch,
          ]),
        )
        .digest("hex"),
      destination = resolve(this.dataDir, "dependency-cache", key);
    try {
      const marker = JSON.parse(
        await readFile(join(destination, ".forge-cache.json"), "utf8"),
      );
      if (marker.digest === (await treeDigest(destination, signal))) {
        checkCancelled(signal);
        return destination;
      }
      throw new ForgeError(
        "dependency_cache_corrupt",
        "Bağımlılık cache hash'i değişti.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.allowInstall)
      throw new ForgeError(
        "dependency_network_disabled",
        "Kilitli bağımlılık kurulumu yönetici profilinde kapalı.",
        403,
      );
    const staging = resolve(
      this.dataDir,
      "dependency-cache",
      `.staging-${randomUUID()}`,
    );
    await mkdir(staging, { recursive: true, mode: 0o755 });
    const name = `forge-deps-${randomUUID()}`;
    try {
      const args = [
        "create",
        "--name",
        name,
        "--label",
        `skill-forge.dependency-scope=${createHash("sha256").update(this.trustScope).digest("hex")}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--mount",
        `type=bind,src=${snapshot},dst=/package,readonly`,
        "--mount",
        `type=bind,src=${staging},dst=/deps`,
        "--env",
        "HOME=/tmp",
        "--workdir",
        "/deps",
        image,
      ];
      let installer: string[];
      if (dependency.runtime === "node") {
        await writeFile(
          join(staging, "package.json"),
          await readFile(join(snapshot, "package.json")),
        );
        await writeFile(join(staging, "package-lock.json"), lock);
        installer = [
          "npm",
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
          "--cache=/tmp/npm-cache",
        ];
      } else
        installer = [
          "python",
          "-m",
          "pip",
          "install",
          "--require-hashes",
          "--only-binary=:all:",
          "--no-deps",
          "--no-compile",
          "--index-url=https://pypi.org/simple",
          "--target=/deps/python",
          "-r",
          `/package/${dependency.lockfile}`,
        ];
      // Finish bounded creation before observing cancellation: killing `docker run`
      // during its create request could race cleanup and leave an orphan container.
      checkCancelled(signal);
      const created = await command("docker", [...args, ...installer], {
        timeoutMs: 10000,
        maxBytes: 4096,
      });
      if (created.code !== 0)
        throw new ForgeError(
          "dependency_create_failed",
          "Bağımlılık container'ı oluşturulamadı.",
          503,
        );
      checkCancelled(signal);
      const run = await command("docker", ["start", "--attach", name], {
        timeoutMs: 120000,
        maxBytes: 65536,
        signal,
      });
      checkCancelled(signal);
      if (run.code !== 0)
        throw new ForgeError(
          "dependency_install_failed",
          "Kilitli bağımlılık kurulumu başarısız.",
          422,
        );
      if (dependency.runtime === "node")
        await mkdir(join(staging, "node_modules"), {
          recursive: true,
          mode: 0o755,
        });
      const digest = await treeDigest(staging, signal);
      await writeFile(
        join(staging, ".forge-cache.json"),
        JSON.stringify({
          digest,
          lock: dependency.sha256,
          image,
          created_at: Date.now(),
        }),
        { mode: 0o600 },
      );
      try {
        checkCancelled(signal);
        await rename(staging, destination);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        const marker = JSON.parse(
          await readFile(join(destination, ".forge-cache.json"), "utf8"),
        );
        if (marker.digest !== (await treeDigest(destination, signal)))
          throw new ForgeError(
            "dependency_cache_corrupt",
            "Eşzamanlı cache kurulumu doğrulanamadı.",
          );
      }
      return destination;
    } finally {
      const cleanup = await command("docker", ["rm", "--force", name], {
        timeoutMs: 5000,
        maxBytes: 4096,
      });
      await rm(staging, { recursive: true, force: true });
      if (cleanup.code !== 0 && !/no such container/i.test(cleanup.stderr))
        throw new ForgeError(
          "dependency_cleanup_failed",
          "Bağımlılık container temizliği doğrulanamadı.",
          503,
        );
    }
  }
}
