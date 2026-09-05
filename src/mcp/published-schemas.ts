import { toolSchemas, type ToolName } from "./schemas.js";
import type { z } from "zod";

/** Cache only static schema publication; validation and identity remain per request. */
function publishedSchema(schema: z.ZodType) {
  const standard = schema["~standard"];
  const input = standard.jsonSchema.input({ target: "draft-2020-12" });
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input(options: Parameters<typeof standard.jsonSchema.input>[0]) {
          if (
            options.target === "draft-2020-12" &&
            Object.keys(options).length === 1
          )
            return structuredClone(input);
          return standard.jsonSchema.input(options);
        },
        output(options: Parameters<typeof standard.jsonSchema.output>[0]) {
          return standard.jsonSchema.output(options);
        },
      },
    },
  };
}
export const publishedToolSchemas = Object.fromEntries(
  Object.entries(toolSchemas).map(([name, schema]) => [
    name,
    publishedSchema(schema),
  ]),
) as Record<ToolName, ReturnType<typeof publishedSchema>>;
