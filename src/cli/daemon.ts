import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  PRODUCT_VERSION,
  type LocalConfig,
} from "./config.js";
import { ForgeError } from "../domain/errors.js";
export async function daemonHealth(config: LocalConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.url}/health`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok)
      throw new ForgeError(
        "daemon_identity_mismatch",
        "Seçilen port başka servise ait veya yerel kimlik eşleşmiyor.",
        409,
      );
    const data = (await response.json()) as {
      service: string;
      version: string;
      protocol: number;
    };
    if (
      data.service !== "skill-forge" ||
      data.protocol !== PROTOCOL_VERSION ||
      data.version !== PRODUCT_VERSION
    )
      throw new ForgeError(
        "daemon_version_mismatch",
        "Çalışan servisin sürümü uyuşmuyor; mevcut işleri koruyarak servisi yeniden başlatın.",
        409,
      );
    return true;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    return false;
  }
}
export async function ensureDaemon(config: LocalConfig, entry: string) {
  if (await daemonHealth(config)) return;
  const log = await open(join(config.dataDir, "daemon.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        entry,
        "serve",
        "--data-dir",
        config.dataDir,
        "--port",
        String(config.port),
      ],
      { detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
    );
    child.on("error", () => {});
    child.unref();
  } finally {
    await log.close();
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await daemonHealth(config)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ForgeError(
    "daemon_start_failed",
    "Servis başlatılamadı; veri dizinindeki daemon.log kaydını inceleyin.",
    503,
  );
}
