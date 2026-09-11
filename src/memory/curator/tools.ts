import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { ForgeError } from "../../domain/errors.js";
import type { CuratorLookup } from "./lookup.js";
import type { CuratorProposals } from "./proposals.js";
import type { CuratorSourceReader } from "./source-reader.js";

/**
 * Issue #39 (M06): the five narrow internal tools.
 *
 * No host shell, no filesystem path beyond the authorized source reader, no
 * permissions, no delegation, no direct SQL/Markdown write. After `finalize`
 * succeeds, every tool call is refused and the runner terminates.
 */

export interface CuratorToolOutcome {
  outcome: "no_op" | "proposed" | "rejected";
  reason: string;
  applied: unknown;
}

const finalizeSchema = z
  .object({
    outcome: z.enum(["no_op", "proposed", "rejected"]),
    reason: z.string().min(1).max(1000),
  })
  .strict();

export class CuratorTools {
  finalized = false;
  finalizeResult: CuratorToolOutcome | null = null;
  toolResultBytes = 0;

  constructor(
    readonly reader: CuratorSourceReader,
    readonly lookup: CuratorLookup,
    readonly proposals: CuratorProposals,
    readonly onFinalize?: (decision: {
      outcome: "no_op" | "proposed" | "rejected";
      reason: string;
    }) => Promise<unknown>,
  ) {}

  private tool(
    name: string,
    description: string,
    parameters: TSchema,
    action: (args: any) => Promise<unknown>,
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters,
      execute: async (_id, args) => {
        if (this.finalized)
          throw new ForgeError("run_closed", "İş finalize edildi.");
        const result = await action(args);
        const text = JSON.stringify(result);
        this.toolResultBytes += Buffer.byteLength(text);
        return { content: [{ type: "text", text }], details: {} };
      },
    };
  }

  tools(): AgentTool[] {
    return [
      this.tool(
        "source_read",
        "Read one authorized source excerpt (optional relative path/section). Never a host path.",
        Type.Object({
          source_id: Type.String({ maxLength: 200 }),
          path: Type.Optional(Type.String({ maxLength: 4000 })),
          section: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        async (args) => this.reader.readOne(args),
      ),
      this.tool(
        "memory_lookup",
        "Find or open a bounded existing note inside the job's memory space.",
        Type.Object({
          query: Type.Optional(Type.String({ maxLength: 200 })),
          note_id: Type.Optional(Type.String({ maxLength: 200 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
        }),
        async (args) => {
          if (args.note_id) return this.lookup.get(String(args.note_id));
          const query = typeof args.query === "string" ? args.query : "";
          if (!query)
            throw new ForgeError(
              "invalid_input",
              "query veya note_id gerekir.",
              422,
            );
          return this.lookup.search(query, args.limit ?? 8);
        },
      ),
      this.tool(
        "propose_patch",
        "Stage a create/update/supersede candidate with expected base_revision and citations.",
        Type.Object({
          operation: Type.String({
            enum: ["create", "update", "supersede"],
          }),
          note_id: Type.Optional(Type.String({ maxLength: 200 })),
          base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
          kind: Type.String({ maxLength: 40 }),
          title: Type.String({ maxLength: 500 }),
          summary: Type.Optional(Type.String({ maxLength: 8000 })),
          body: Type.String({ maxLength: 49152 }),
          rationale: Type.String({ maxLength: 2000 }),
          source_refs: Type.Array(
            Type.Object({
              source_id: Type.String({ maxLength: 200 }),
              path: Type.Optional(Type.String({ maxLength: 4000 })),
              section: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            { minItems: 1, maxItems: 20 },
          ),
          claim: Type.Object({
            user_declared: Type.Optional(Type.Boolean()),
            externally_verified: Type.Optional(Type.Boolean()),
            rewrites_human_text: Type.Optional(Type.Boolean()),
            contradicts_accepted: Type.Optional(Type.Boolean()),
            describes_plan: Type.Optional(Type.Boolean()),
            claims_completion: Type.Optional(Type.Boolean()),
          }),
        }),
        async (args) => this.proposals.proposePatch(args),
      ),
      this.tool(
        "propose_link",
        "Stage a typed link between two existing notes in the same space.",
        Type.Object({
          note_id: Type.String({ maxLength: 200 }),
          target_note_id: Type.String({ maxLength: 200 }),
          relation: Type.String({ maxLength: 40 }),
          rationale: Type.String({ maxLength: 2000 }),
          source_refs: Type.Array(
            Type.Object({
              source_id: Type.String({ maxLength: 200 }),
              path: Type.Optional(Type.String({ maxLength: 4000 })),
              section: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            { minItems: 1, maxItems: 20 },
          ),
        }),
        async (args) => this.proposals.proposeLink(args),
      ),
      {
        name: "finalize",
        label: "finalize",
        description:
          "Finish the run once: no_op, proposed or rejected. No tool call after this.",
        parameters: Type.Object({
          outcome: Type.String({
            enum: ["no_op", "proposed", "rejected"],
          }),
          reason: Type.String({ maxLength: 1000 }),
        }),
        execute: async (_id, args) => {
          if (this.finalized)
            throw new ForgeError("run_closed", "İş finalize edildi.");
          const decision = finalizeSchema.parse(args);
          const applied = await (this.onFinalize?.(decision) ?? null);
          this.finalized = true;
          this.finalizeResult = { ...decision, applied };
          const text = JSON.stringify({
            status: decision.outcome,
            reason: decision.reason,
            applied,
          });
          this.toolResultBytes += Buffer.byteLength(text);
          return {
            content: [{ type: "text", text }],
            details: {},
            terminate: true,
          };
        },
      },
    ];
  }
}
