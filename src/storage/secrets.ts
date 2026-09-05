import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  randomUUID,
} from "node:crypto";
import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "../domain/errors.js";
export class SecretVault {
  private constructor(
    readonly root: string,
    private readonly key: Buffer,
  ) {}
  static async open(dataDir: string) {
    const root = join(dataDir, "secrets");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new ForgeError("insecure_vault", "Secret dizini güvenli değil.");
    const path = join(root, "master.key");
    try {
      const fd = await open(path, "wx", 0o600);
      try {
        await fd.writeFile(randomBytes(32));
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const keyStat = await lstat(path);
    if (
      !keyStat.isFile() ||
      keyStat.isSymbolicLink() ||
      keyStat.nlink !== 1 ||
      (process.platform !== "win32" && keyStat.mode & 0o077)
    )
      throw new ForgeError(
        "insecure_vault_key",
        "Secret anahtar dosyası güvenli değil.",
      );
    let key = Buffer.alloc(0);
    for (let i = 0; i < 50; i++) {
      key = await readFile(path);
      if (key.length === 32) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (key.length !== 32)
      throw new ForgeError("invalid_vault_key", "Secret anahtarı eksik.");
    return new SecretVault(root, key);
  }
  private scope(tenant: string, user: string) {
    return createHash("sha256")
      .update(JSON.stringify([tenant, user]))
      .digest("hex");
  }
  async put(tenant: string, user: string, value: string) {
    if (!value || value.length > 16384)
      throw new ForgeError("invalid_secret", "Secret boyutu geçersiz.");
    const ref = randomUUID(),
      scope = this.scope(tenant, user);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${scope}:${ref}`));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const path = join(this.root, `${scope}-${ref}.json`);
    const fd = await open(path, "wx", 0o600);
    try {
      await fd.writeFile(
        JSON.stringify({
          version: 1,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: encrypted.toString("base64"),
        }),
      );
      await fd.sync();
    } finally {
      await fd.close();
    }
    return ref;
  }
  async get(tenant: string, user: string, ref: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(ref))
      throw new ForgeError(
        "secret_unavailable",
        "Secret referansı geçersiz.",
        404,
      );
    const scope = this.scope(tenant, user),
      path = join(this.root, `${scope}-${ref}.json`);
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 32768
      )
        throw new Error("unsafe secret");
      const value = JSON.parse(await readFile(path, "utf8"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(value.nonce, "base64"),
      );
      decipher.setAAD(Buffer.from(`${scope}:${ref}`));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ForgeError(
        "secret_unavailable",
        "Bu kapsam için secret okunamadı.",
        404,
      );
    }
  }
}
