import { randomBytes } from "node:crypto";
import type { IdentityService } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";

export interface GithubOptions {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  /** Overridable for fixture servers in tests. */
  authBase?: string;
  apiBase?: string;
}

interface PendingLogin {
  state: string;
  expires: number;
}

/**
 * GitHub OAuth login for server profile. GitHub issues no OIDC id_token for
 * OAuth Apps, so the code is exchanged for an access token and the account id
 * is read from the user API. Subjects are namespaced as `github|<id>` and
 * must be provisioned first (invite-gated, like OIDC).
 */
export class GithubIdentity {
  constructor(
    readonly options: GithubOptions,
    readonly identities: IdentityService,
  ) {}

  get authBase() {
    return (this.options.authBase ?? "https://github.com").replace(/\/$/, "");
  }

  get apiBase() {
    return (this.options.apiBase ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  begin(): { url: string; state: string; expires: number } {
    const state = randomBytes(32).toString("hex");
    const url =
      `${this.authBase}/login/oauth/authorize` +
      `?client_id=${encodeURIComponent(this.options.clientId)}` +
      `&redirect_uri=${encodeURIComponent(`${this.options.publicUrl}/auth/github/callback`)}` +
      `&scope=${encodeURIComponent("read:user")}` +
      `&state=${state}`;
    return { url, state, expires: Date.now() + 300_000 };
  }

  async callback(code: string, state: string, pending: PendingLogin) {
    if (!code || pending.state !== state || !pending.state)
      throw new ForgeError(
        "invalid_login_state",
        "Giriş durumu geçersiz.",
        401,
      );
    if (pending.expires < Date.now())
      throw new ForgeError(
        "login_expired",
        "Giriş isteğinin süresi doldu.",
        401,
      );
    const tokenResponse = await fetch(
      `${this.authBase}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(10000),
      },
    ).catch(() => {
      throw new ForgeError(
        "login_unavailable",
        "GitHub kimlik yanıtı alınamadı.",
        502,
      );
    });
    if (!tokenResponse.ok)
      throw new ForgeError(
        "invalid_login_response",
        "GitHub giriş yanıtı doğrulanamadı.",
        401,
      );
    const tokenBody = (await tokenResponse.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    if (!tokenBody || typeof tokenBody.access_token !== "string")
      throw new ForgeError(
        "invalid_login_response",
        "GitHub giriş yanıtı doğrulanamadı.",
        401,
      );
    const userResponse = await fetch(`${this.apiBase}/user`, {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw new ForgeError(
        "login_unavailable",
        "GitHub kullanıcı bilgisi alınamadı.",
        502,
      );
    });
    if (!userResponse.ok)
      throw new ForgeError(
        "invalid_identity",
        "GitHub kullanıcı kimliği eksik.",
        401,
      );
    const userBody = (await userResponse.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    if (!userBody || typeof userBody.id !== "number")
      throw new ForgeError(
        "invalid_identity",
        "GitHub kullanıcı kimliği eksik.",
        401,
      );
    return this.identities.userIdForSubject(`github|${userBody.id}`);
  }
}
