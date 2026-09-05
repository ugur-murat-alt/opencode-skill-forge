import { z } from "zod";
export const settingsSchema = z
  .object({
    promptEnabled: z.boolean().optional(),
    evolutionEnabled: z.boolean().optional(),
    promptMode: z.enum(["when-needed", "always", "off"]).optional(),
    autoApply: z.boolean().optional(),
    learning: z.enum(["off", "reusable-only"]).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
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
export const defaultSettings: Required<Settings> = {
  promptEnabled: true,
  evolutionEnabled: true,
  promptMode: "when-needed",
  autoApply: true,
  learning: "reusable-only",
  retentionDays: 30,
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
        ].includes(key)
      )
        next = Math.min(result.values[key] as number, incoming as number);
      if (key === "allowPaid" || key === "dependencyInstall")
        next = result.values[key] && Boolean(incoming);
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
