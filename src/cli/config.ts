import { settingsSchema, type Settings } from "../domain/settings.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ForgeError } from "../domain/errors.js";
export const PRODUCT_VERSION = "0.5.6";
export const PROTOCOL_VERSION = 1;
export interface LocalConfig {
  dataDir: string;
  policy?: Settings;
  host: string;
  port: number;
  token: string;
  url: string;
  profile?: "local" | "server";
  postgresUrl?: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    audience: string;
    publicUrl: string;
  };
}
export function defaultDataDir(env = process.env): string {
  if (env.SKILL_FORGE_DATA_DIR) return resolve(env.SKILL_FORGE_DATA_DIR);
  if (process.platform === "win32")
    return join(
      env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "SkillForge",
    );
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "SkillForge");
  return join(
    env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "skill-forge",
  );
}
export async function localConfig(
  dataDir = defaultDataDir(),
  requestedPort?: number,
): Promise<LocalConfig> {
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dataDir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new ForgeError(
      "insecure_data_dir",
      "Veri dizini sahip kullanıcıya ait ve yalnız ona açık (0700) olmalıdır.",
    );
  dataDir = await realpath(dataDir);
  const tokenPath = join(dataDir, "owner-token");
  try {
    const fd = await open(tokenPath, "wx", 0o600);
    try {
      await fd.writeFile(randomBytes(32).toString("hex"));
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const tokenStat = await lstat(tokenPath);
  if (
    !tokenStat.isFile() ||
    tokenStat.isSymbolicLink() ||
    tokenStat.nlink !== 1 ||
    (process.platform !== "win32" &&
      ((tokenStat.mode & 0o077) !== 0 || tokenStat.uid !== process.getuid?.()))
  )
    throw new ForgeError(
      "insecure_credential",
      "Yerel kimlik dosyasının izinleri güvenli değil.",
    );
  // A concurrent first writer can exist briefly before its fsync completes.
  let token = "";
  for (let i = 0; i < 50; i++) {
    token = await readFile(tokenPath, "utf8");
    if (/^[a-f0-9]{64}$/.test(token)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new ForgeError(
      "invalid_credential",
      "Yerel kimlik dosyası geçersiz.",
    );
  let policy: Settings = {};
  try {
    const policyPath = join(dataDir, "policy.json"),
      policyStat = await lstat(policyPath);
    if (
      !policyStat.isFile() ||
      policyStat.isSymbolicLink() ||
      policyStat.nlink !== 1 ||
      policyStat.size > 32768 ||
      (process.platform !== "win32" &&
        ((policyStat.mode & 0o077) !== 0 ||
          policyStat.uid !== process.getuid?.()))
    )
      throw new ForgeError(
        "insecure_policy",
        "Sistem politika dosyası güvenli değil.",
      );
    policy = settingsSchema.parse(
      JSON.parse(await readFile(policyPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const port =
    requestedPort ??
    Number(
      process.env.SKILL_FORGE_PORT ??
        20000 +
          (createHash("sha256").update(dataDir).digest().readUInt16BE(0) %
            30000),
    );
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ForgeError("invalid_port", "Port geçersiz.");
  if (process.env.SKILL_FORGE_PROFILE === "server") {
    const postgresUrl = process.env.SKILL_FORGE_POSTGRES_URL;
    const publicUrl = process.env.SKILL_FORGE_PUBLIC_URL;
    const issuer = process.env.SKILL_FORGE_OIDC_ISSUER;
    const clientId = process.env.SKILL_FORGE_OIDC_CLIENT_ID;
    if (!postgresUrl || !publicUrl || !issuer || !clientId)
      throw new ForgeError(
        "server_config_missing",
        "Sunucu profili PostgreSQL, public URL ve OIDC ayarlarını gerektirir.",
      );
    return {
      dataDir,
      policy,
      token,
      port,
      host: "0.0.0.0",
      url: publicUrl,
      profile: "server",
      postgresUrl,
      oidc: {
        issuer,
        clientId,
        clientSecret: process.env.SKILL_FORGE_OIDC_CLIENT_SECRET,
        audience: publicUrl,
        publicUrl,
      },
    };
  }
  return {
    dataDir,
    policy,
    token,
    port,
    host: "127.0.0.1",
    url: `http://127.0.0.1:${port}`,
    profile: "local",
  };
}
