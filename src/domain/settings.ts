import { z } from "zod";
import {
  CURATOR_AUTO_WRITE_KINDS,
  CURATOR_HARD_LIMITS,
  MEMORY_CURATOR_MODES,
  narrowCuratorMode,
  type MemoryCuratorMode,
} from "./curator.js";
export const settingsSchema = z
  .object({
    evolutionEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    memoryCuratorMode: z.enum(MEMORY_CURATOR_MODES).optional(),
    curatorMaxCalls: z
      .number()
      .int()
      .min(1)
      .max(CURATOR_HARD_LIMITS.maxCalls)
      .optional(),
    curatorMaxProposals: z
      .number()
      .int()
      .min(1)
      .max(CURATOR_HARD_LIMITS.maxProposals)
      .optional(),
    curatorMaxSourceBytes: z
      .number()
      .int()
      .min(256)
      .max(CURATOR_HARD_LIMITS.maxSourceBytes)
      .optional(),
    curatorAutoWriteKinds: z
      .array(z.enum(CURATOR_AUTO_WRITE_KINDS))
      .max(CURATOR_AUTO_WRITE_KINDS.length)
      .optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    searchMinScore: z.number().min(0).max(1).optional(),
    searchMaxResults: z.number().int().min(1).max(20).optional(),
    maxCalls: z.number().int().min(1).max(100).optional(),
    maxTokens: z.number().int().min(64).max(1_000_000).optional(),
    maxCostMicros: z.number().int().min(0).max(1_000_000_000).optional(),
    concurrency: z.number().int().min(1).max(1000).optional(),
    dependencyInstall: z.boolean().optional(),
    scriptAllowedOrigins: z.array(z.url()).max(20).optional(),
    allowedOrigins: z.array(z.url()).max(30).optional(),
    allowPaid: z.boolean().optional(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
/**
 * Kayıtlı satırlar için toleranslı şema: kaldırılmış eski anahtarlar
 * okumayı bozmaz, sessizce atılır. Yeni yazımlar
 * `settingsSchema` ile strict doğrulanmaya devam eder.
 */
export const storedSettingsSchema = settingsSchema.strip();
export const defaultSettings: Required<Settings> = {
  evolutionEnabled: true,
  memoryEnabled: false,
  memoryCuratorMode: "manual",
  curatorMaxCalls: CURATOR_HARD_LIMITS.maxCalls,
  curatorMaxProposals: CURATOR_HARD_LIMITS.maxProposals,
  curatorMaxSourceBytes: 32768,
  curatorAutoWriteKinds: [],
  retentionDays: 30,
  searchMinScore: 0,
  searchMaxResults: 20,
  maxCalls: 6,
  maxTokens: 16384,
  maxCostMicros: 0,
  concurrency: 2,
  allowedOrigins: [],
  allowPaid: false,
  dependencyInstall: false,
  scriptAllowedOrigins: [],
};
/** Policy is set by administrators; narrower layers can only reduce limits. */
export function resolveSettings(
  policy: Settings,
  layers: { source: string; values: Settings }[],
) {
  const initial = { ...defaultSettings, ...settingsSchema.parse(policy) };
  const result = {
    values: initial,
    sources: Object.fromEntries(
      Object.keys(initial).map((key) => [key, "system_policy"]),
    ),
  };
  for (const layer of layers) {
    const parsed = settingsSchema.parse(layer.values);
    for (const key of Object.keys(parsed) as (keyof Settings)[]) {
      const incoming = parsed[key];
      if (incoming === undefined) continue;
      let next = incoming;
      if (
        [
          "maxCalls",
          "maxTokens",
          "maxCostMicros",
          "concurrency",
          "retentionDays",
          "searchMaxResults",
          "curatorMaxCalls",
          "curatorMaxProposals",
          "curatorMaxSourceBytes",
        ].includes(key)
      )
        next = Math.min(result.values[key] as number, incoming as number);
      if (key === "memoryCuratorMode")
        next = narrowCuratorMode(
          result.values.memoryCuratorMode as MemoryCuratorMode,
          incoming as MemoryCuratorMode,
        );
      if (key === "searchMinScore")
        next = Math.max(result.values[key] as number, incoming as number);
      if (
        key === "allowPaid" ||
        key === "dependencyInstall" ||
        key === "memoryEnabled"
      )
        next = result.values[key] && Boolean(incoming);
      if (key === "curatorAutoWriteKinds")
        next = (result.values.curatorAutoWriteKinds as string[]).filter(
          (kind) => (incoming as string[]).includes(kind),
        );
      if (key === "allowedOrigins" || key === "scriptAllowedOrigins")
        next = result.values[key].filter((origin) =>
          (incoming as string[]).includes(origin),
        );
      if (JSON.stringify(next) !== JSON.stringify(result.values[key])) {
        Object.assign(result.values, { [key]: next });
        result.sources[key] = layer.source;
      }
    }
  }
  return result;
}
