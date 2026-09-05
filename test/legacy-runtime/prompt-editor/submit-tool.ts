import type { SubmitPayload } from "./types.js";
import type { PromptEditorConfig } from "./config.js";
import { SUBMIT_TOOL_NAME } from "./constants.js";

export interface SubmitSink {
  submit: (sessionID: string, payload: SubmitPayload) => boolean;
}

/**
 * Registers the single terminal tool the editor agent must call with its
 * rewritten prompt. Only meaningful inside an editor session; the context
 * hook strips it from every other session.
 */
export function registerSubmitTool(
  ctx: {
    tool: {
      transform: (
        cb: (draft: { add: (tool: Record<string, unknown>) => void }) => void,
      ) => Promise<unknown>;
    };
  },
  sink: SubmitSink,
  config: Pick<
    PromptEditorConfig,
    "learnEntryMaxChars" | "learningMode" | "rewriteMode"
  >,
) {
  return ctx.tool.transform((tools) => {
    tools.add({
      name: SUBMIT_TOOL_NAME,
      description:
        "Finish the prompt-editing task by submitting the rewritten user message. If an unchanged submission is rejected, revise it and submit again.",
      input: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              config.rewriteMode === "always"
                ? "The improved user message. It must differ from the original while preserving intent."
                : "The improved user message, preserving intent.",
          },
          learn: {
            type: "string",
            maxLength: config.learnEntryMaxChars,
            description: `Durable lesson (<=${config.learnEntryMaxChars} chars) about a reusable writing pattern, correction, terminology, or preference. Never include secrets or one-off task content.`,
          },
        },
        required:
          config.learningMode === "always" ? ["prompt", "learn"] : ["prompt"],
        additionalProperties: false,
      },
      options: { codemode: false, internal: true },
      execute: async (
        rawArgs: Record<string, unknown>,
        toolCtx: { sessionID: string },
      ) => {
        const args = rawArgs ?? {};
        const prompt =
          typeof args["prompt"] === "string"
            ? (args["prompt"] as string).trim()
            : "";
        if (!prompt) return { ok: false, error: "missing prompt" };
        const learn =
          typeof args["learn"] === "string"
            ? (args["learn"] as string).trim()
            : undefined;
        if (config.learningMode === "always" && !learn)
          return { ok: false, accepted: false, error: "missing learn lesson" };
        if (learn && Array.from(learn).length > config.learnEntryMaxChars)
          return {
            ok: false,
            accepted: false,
            error: `learn lesson exceeds ${config.learnEntryMaxChars} characters`,
          };
        const handled = sink.submit(toolCtx.sessionID, {
          prompt,
          ...(learn ? { learn } : {}),
        });
        return {
          ok: handled,
          accepted: handled,
          ...(handled
            ? {}
            : {
                error: "submission rejected; revise the prompt and try again",
              }),
        };
      },
    });
  });
}
