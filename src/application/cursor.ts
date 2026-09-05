import { createHmac, timingSafeEqual } from "node:crypto";
import { ForgeError } from "../domain/errors.js";
export class CursorCodec {
  constructor(readonly key: string) {}
  encode(binding: unknown, value: unknown) {
    const body = Buffer.from(
      JSON.stringify({ binding, value, expires: Date.now() + 3600000 }),
    ).toString("base64url");
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  decode<T>(token: string, binding: unknown): T {
    try {
      const [body, signature, extra] = token.split(".");
      if (!body || !signature || extra) throw new Error();
      const expected = createHmac("sha256", this.key).update(body).digest(),
        actual = Buffer.from(signature, "base64url");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
      if (
        decoded.expires < Date.now() ||
        JSON.stringify(decoded.binding) !== JSON.stringify(binding)
      )
        throw new Error();
      return decoded.value as T;
    } catch {
      throw new ForgeError(
        "invalid_cursor",
        "Sayfa anahtarı geçersiz, süresi dolmuş veya başka kapsama ait.",
      );
    }
  }
}
