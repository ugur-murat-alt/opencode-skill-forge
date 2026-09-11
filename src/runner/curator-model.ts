import type { Identity } from "../application/identity.js";
import { providerProfileSchema } from "../application/providers.js";
import type { MemoryCuratorProfileRepository } from "../memory/curator/profile.js";
import { resolveProvider } from "./providers.js";

/**
 * Issue #39 (M06): resolves the independent memory model binding.
 *
 * It lives in the runner layer because `src/memory/**` must stay free of
 * runner imports (M01 boundary), and it never falls back to the skill role,
 * another provider profile or an environment credential.
 */
export async function resolveCuratorModel(
  repository: MemoryCuratorProfileRepository,
  identity: Identity,
  policy: {
    local: boolean;
    allowedOrigins: readonly string[];
    allowPaid: boolean;
  },
) {
  const current = await repository.latest(identity).catch(() => undefined);
  if (!current) return null;
  let profile;
  try {
    profile = providerProfileSchema.parse(JSON.parse(current.profile_json));
  } catch {
    return null;
  }
  const secret = async () => {
    if (!current.secret_ref) return undefined;
    try {
      return await repository.vault.get(
        identity.tenantId,
        identity.userId,
        current.secret_ref,
      );
    } catch {
      return undefined;
    }
  };
  if (profile.provider !== "ollama" && !current.secret_ref) return null;
  try {
    const resolved = await resolveProvider(
      {
        ...profile,
        allowPaid: profile.allowPaid && policy.allowPaid,
      },
      secret,
      { local: policy.local, allowedOrigins: policy.allowedOrigins },
    );
    return { ...resolved, revision: current.revision, profile };
  } catch {
    return null;
  }
}
