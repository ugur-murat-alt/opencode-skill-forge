import { test, expect } from "bun:test";
import { toolSchemas, type ToolName } from "../src/mcp/schemas.js";
import { publishedToolSchemas } from "../src/mcp/published-schemas.js";

test("MCP publication preserves every schema and never shares mutable JSON", () => {
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const source = toolSchemas[name]["~standard"],
      published = publishedToolSchemas[name]["~standard"];
    for (const target of ["draft-2020-12", "draft-07"] as const) {
      const actual = published.jsonSchema.input({ target });
      expect(actual).toEqual(source.jsonSchema.input({ target }));
      delete actual.properties;
      expect(published.jsonSchema.input({ target })).toEqual(
        source.jsonSchema.input({ target }),
      );
    }
    expect(published.validate).toBe(source.validate);
    expect(published.jsonSchema.output({ target: "draft-2020-12" })).toEqual(
      source.jsonSchema.output({ target: "draft-2020-12" }),
    );
  }
});

test("MCP publication keeps strict validation and Zod defaults", async () => {
  const schema = publishedToolSchemas.forge_load["~standard"];
  const input = {
    project_ref: "project",
    skill_id: "skill",
    revision: "a".repeat(64),
  };
  expect(await schema.validate(input)).toMatchObject({
    value: { ...input, path: "SKILL.md", inventory: false },
  });
  expect(
    (await schema.validate({ ...input, tenant_id: "other" })).issues?.length,
  ).toBeGreaterThan(0);
  expect(
    (await schema.validate({ ...input, revision: "invalid" })).issues?.length,
  ).toBeGreaterThan(0);
});
