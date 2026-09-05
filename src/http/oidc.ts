import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityService } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  audience: string;
  publicUrl: string;
}
export class OidcIdentity {
  private constructor(
    readonly options: OidcOptions,
    readonly config: oidc.Configuration,
    readonly identities: IdentityService,
    readonly jwks: ReturnType<typeof createRemoteJWKSet>,
  ) {}
  static async create(options: OidcOptions, identities: IdentityService) {
    if (
      new URL(options.issuer).protocol !== "https:" ||
      new URL(options.publicUrl).protocol !== "https:"
    )
      throw new ForgeError(
        "oidc_https_required",
        "Sunucu kimliği için HTTPS gerekiyor.",
      );
    const config = await oidc.discovery(
      new URL(options.issuer),
      options.clientId,
      options.clientSecret,
    );
    const jwksUri = config.serverMetadata().jwks_uri;
    if (!jwksUri || new URL(jwksUri).protocol !== "https:")
      throw new ForgeError(
        "oidc_jwks_missing",
        "OIDC güvenli JWKS adresi sağlamadı.",
      );
    return new OidcIdentity(
      options,
      config,
      identities,
      createRemoteJWKSet(new URL(jwksUri)),
    );
  }
  async begin() {
    const verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: `${this.options.publicUrl}/auth/callback`,
      scope: "openid profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return {
      url: url.href,
      verifier,
      state,
      nonce,
      expires: Date.now() + 300_000,
    };
  }
  async callback(
    url: URL,
    pending: {
      verifier: string;
      state: string;
      nonce: string;
      expires: number;
    },
  ) {
    if (pending.expires < Date.now())
      throw new ForgeError(
        "login_expired",
        "Giriş isteğinin süresi doldu.",
        401,
      );
    const tokens = await oidc.authorizationCodeGrant(this.config, url, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub)
      throw new ForgeError(
        "invalid_identity",
        "OIDC kullanıcı kimliği eksik.",
        401,
      );
    return this.knownUser(claims.sub);
  }
  async bearer(token: string) {
    const result = await jwtVerify(token, this.jwks, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      requiredClaims: ["sub", "exp", "iat"],
      algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
    });
    const scopes =
      typeof result.payload.scope === "string"
        ? result.payload.scope.split(" ")
        : [];
    if (!scopes.includes("forge"))
      throw new ForgeError(
        "insufficient_scope",
        "Token forge kapsamını taşımıyor.",
        403,
      );
    return this.knownUser(result.payload.sub!);
  }
  private async knownUser(subject: string) {
    const user = await this.identities.db
      .selectFrom("users")
      .select("id")
      .where("subject", "=", `${this.options.issuer}|${subject}`)
      .executeTakeFirst();
    if (!user)
      throw new ForgeError(
        "membership_required",
        "Hesap yöneticisi kullanıcı üyeliğini tanımlamalıdır.",
        403,
      );
    return user.id;
  }
}
