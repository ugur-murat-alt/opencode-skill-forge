import { z } from "zod";
import { ForgeError } from "../domain/errors.js";
const record = z.object({
  line: z.number().optional(),
  index: z.number().optional(),
  status: z.string().max(50),
  entry_id: z.string().max(100).optional(),
  reason: z.string().max(100).optional(),
  revision: z.number().optional(),
});
const resultSchema = z.object({
  receipt_id: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["applied", "rolled_back"]),
  replayed: z.boolean(),
  skill_id: z.string().max(100).optional(),
  revision: z.string().max(100).optional(),
  decision: z.string().max(30).optional(),
  review_required: z.number().int().nonnegative().optional(),
  malformed: z.number().int().nonnegative().optional(),
  unselected: z.number().int().nonnegative().optional(),
  records: z.array(record).max(10000).optional(),
});
export type RemoteMigrationResult = z.infer<typeof resultSchema>;
export function remoteMigrationUpload(
  rawUrl: string,
  tenant: string,
  token: string,
) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ForgeError("invalid_server_url", "Geçerli sunucu URL gerekiyor.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new ForgeError(
      "invalid_server_url",
      "HTTPS sunucu origin'i veya yerel loopback HTTP gerekiyor; URL kimlik bilgisi içeremez.",
    );
  if (
    !tenant ||
    tenant.length > 200 ||
    /[\r\n]/.test(tenant) ||
    !token ||
    token.length > 16384 ||
    /[\r\n]/.test(token)
  )
    throw new ForgeError(
      "remote_identity_required",
      "Tenant ve SKILL_FORGE_REMOTE_TOKEN gerekiyor.",
    );
  return async (body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetch(new URL("/api/migrations/import", url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-forge-tenant": tenant,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new ForgeError(
        "remote_unavailable",
        "Sunucu aktarımı tamamlanamadı; aynı manifest/eşleme güvenle tekrar gönderilebilir.",
        503,
      );
    }
    if (!response.body)
      throw new ForgeError(
        "remote_response_invalid",
        "Sunucu yanıtı eksik.",
        502,
      );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new ForgeError(
            "remote_response_limit",
            "Sunucu yanıt sınırı aşıldı.",
            502,
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ForgeError(
        "remote_response_invalid",
        "Sunucu JSON yanıtı geçersiz.",
        502,
      );
    }
    if (!response.ok) {
      const code = z
        .object({
          error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }),
        })
        .safeParse(value);
      throw new ForgeError(
        code.success ? code.data.error.code : "remote_rejected",
        "Sunucu aktarımı reddetti; yetki, eşleme ve kaynak kontrolü gerekiyor.",
        response.status,
      );
    }
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success)
      throw new ForgeError(
        "remote_response_invalid",
        "Sunucu aktarım sonucu sözleşmeye uymuyor.",
        502,
      );
    return parsed.data;
  };
}
