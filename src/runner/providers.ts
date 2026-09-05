import {
  createModels,
  createProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ForgeError } from "../domain/errors.js";
export type ProviderName = "openai" | "anthropic" | "openrouter" | "ollama";
export interface ProviderProfile {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  allowPaid: boolean;
  maxOutputTokens: number;
  contextWindow?: number;
}
export interface ProviderPolicy {
  allowedOrigins: readonly string[];
  local: boolean;
}
export async function resolveProvider(
  profile: ProviderProfile,
  secret: () => Promise<string | undefined>,
  policy: ProviderPolicy,
) {
  let provider: Provider;
  const factories = {
    openai: openaiProvider,
    anthropic: anthropicProvider,
    openrouter: openrouterProvider,
  };
  if (profile.provider === "ollama") {
    const baseUrl = profile.baseUrl ?? "http://127.0.0.1:11434/v1";
    const model: Model<"openai-completions"> = {
      id: profile.model,
      name: profile.model,
      api: "openai-completions",
      provider: "ollama",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow ?? 32768,
      maxTokens: profile.maxOutputTokens,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    provider = createProvider({
      id: "ollama",
      name: "Ollama",
      baseUrl,
      models: [model],
      auth: { apiKey: { name: "scoped", resolve: async () => ({ auth: {} }) } },
      api: openAICompletionsApi(),
    });
  } else provider = factories[profile.provider]();
  const catalogModel = provider
    .getModels()
    .find((model) => model.id === profile.model);
  if (!catalogModel)
    throw new ForgeError(
      "model_unavailable",
      "Model kilitli sağlayıcı kataloğunda bulunamadı.",
      422,
    );
  const model = {
    ...catalogModel,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    maxTokens: Math.min(catalogModel.maxTokens, profile.maxOutputTokens),
  };
  const endpoint = new URL(model.baseUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    throw new ForgeError(
      "invalid_provider_url",
      "Sağlayıcı URL kimlik veya sorgu içeremez.",
    );
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    !policy.allowedOrigins.includes(endpoint.origin) ||
    (endpoint.protocol !== "https:" &&
      !(policy.local && isLocal && endpoint.protocol === "http:"))
  )
    throw new ForgeError(
      "provider_endpoint_denied",
      "Sağlayıcı adresi yönetici izin listesinde değil.",
      403,
    );
  if (
    !profile.allowPaid &&
    profile.provider !== "ollama" &&
    (profile.provider !== "openrouter" || !profile.model.endsWith(":free"))
  )
    throw new ForgeError(
      "paid_model_disabled",
      "Ücretli model çağrısı bu profilde kapalı.",
      403,
    );
  const key =
    (await secret()) ?? (profile.provider === "ollama" ? "ollama" : undefined);
  if (!key && profile.provider !== "ollama")
    throw new ForgeError(
      "credential_missing",
      "Bu kapsam için sağlayıcı anahtarı tanımlı değil.",
      422,
    );
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  // Never resolve environment/global credentials in a multi-user process.
  models.setProvider({
    ...provider,
    auth: {
      apiKey: {
        name: "scoped",
        resolve: async () => ({
          auth: key ? { apiKey: key } : {},
          source: "scope-secret",
        }),
      },
    },
    getModels: () => [model],
  });
  return { models, model };
}
