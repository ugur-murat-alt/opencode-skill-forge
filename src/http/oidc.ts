import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
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
    const tokens = await oidc
      .authorizationCodeGrant(this.config, url, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      })
      .catch((error: unknown) => {
        if (
          error instanceof oidc.AuthorizationResponseError ||
          (error instanceof oidc.ClientError &&
            [
              "OAUTH_INVALID_RESPONSE",
              "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
              "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
              "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
            ].includes(error.code ?? ""))
        )
          throw new ForgeError(
            "invalid_login_response",
            "OIDC giriş yanıtı doğrulanamadı.",
            401,
          );
        throw error;
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
    }).catch((error: unknown) => {
      if (
        error instanceof joseErrors.JWTClaimValidationFailed ||
        error instanceof joseErrors.JWTExpired ||
        error instanceof joseErrors.JWTInvalid ||
        error instanceof joseErrors.JWSInvalid ||
        error instanceof joseErrors.JWSSignatureVerificationFailed ||
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JOSEAlgNotAllowed
      )
        throw new ForgeError(
          "invalid_bearer",
          "Bearer kimliği doğrulanamadı.",
          401,
        );
      throw error;
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
    return this.identities.userIdForSubject(
      `${this.options.issuer}|${subject}`,
    );
  }
}
