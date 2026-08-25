import type { CoreActivation, CoreRuntimeContext } from "./core-runtime.js";

export const SPR_HANDOFF_TOOL = "omni_spr_handoff";
export const SPR_HANDOFF_MAX_CHARS = 4_000;
const SYSTEM_MARKER = "[skillforge-spr-handoff]";
const MAX_COMPLETED_TURNS = 4_096;
const NATIVE_SKILL_TOOLS = ["skill_manage", "skill_list", "skill_view"];

export const SPR_HANDOFF_SYSTEM = `${SYSTEM_MARKER}
Immediately before your final user-facing answer, decide whether the completed work produced a durable, reusable procedure that would help future sessions. If it did, call ${SPR_HANDOFF_TOOL} exactly once with only a concise handoff: the problem class, the verified method, and important constraints. Do not include the conversation transcript, hidden reasoning, raw tool calls or results, secrets, or a copy of your final answer. The tool only queues an independent SPR review in the background: do not wait for it, mention it, or return to it. If there is no reusable procedure, do not call the tool.`;

interface HandoffContextEvent {
  sessionID: string;
  agent?: string | null;
  system: Array<{ type: string; text?: string } & Record<string, unknown>>;
  tools: Record<string, unknown>;
}

interface HandoffRuntime {
  session: {
    hook(
      name: "context",
      callback: (event: HandoffContextEvent) => Promise<void> | void,
    ): Promise<unknown> | unknown;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
  tool: {
    transform(
      callback: (draft: { add(tool: Record<string, unknown>): void }) => void,
    ): Promise<unknown> | unknown;
  };
  command?: {
    transform(
      callback: (draft: {
        update(
          id: string,
          update: (command: Record<string, unknown>) => void,
        ): void;
      }) => void,
    ): Promise<unknown> | unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DisposableRegistration {
  dispose(): Promise<void>;
}

function disposable(value: unknown): DisposableRegistration | undefined {
  return isRecord(value) && typeof value.dispose === "function"
    ? (value as unknown as DisposableRegistration)
    : undefined;
}

async function disposeRegistrations(
  registrations: DisposableRegistration[],
): Promise<void> {
  for (const registration of registrations.reverse()) {
    try {
      await registration.dispose();
    } catch {
      // Plugin-scope disposal is best-effort during teardown and rollback.
    }
  }
}

function rememberCompleted(map: Map<string, undefined>, turnKey: string): void {
  map.delete(turnKey);
  map.set(turnKey, undefined);
  while (map.size > MAX_COMPLETED_TURNS) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== "string") return;
    map.delete(oldest);
  }
}

function sessionLocation(
  value: unknown,
): { directory: string; workspaceID?: string } | undefined {
  const info = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(info) || !isRecord(info.location)) return undefined;
  const directory = info.location.directory;
  if (typeof directory !== "string" || !directory) return undefined;
  const workspaceID = info.location.workspaceID;
  return {
    directory,
    ...(typeof workspaceID === "string" && workspaceID ? { workspaceID } : {}),
  };
}

export async function setupSprHandoff(
  runtime: HandoffRuntime,
  activation: CoreActivation<CoreRuntimeContext>,
  allowedAgentIDs: readonly string[],
): Promise<() => Promise<void>> {
  const allowedAgents = new Set(allowedAgentIDs);
  const completed = new Map<string, undefined>();
  const registrations: DisposableRegistration[] = [];
  let stopped = false;

  try {
    const commandRegistration = await runtime.command?.transform((commands) => {
      commands.update("skill-forge", (command) => {
        command.description =
          "Queue a concise background review of the completed workflow";
        command.template = `[skillforge:curate]
The user explicitly requests a background skill review of the completed workflow. Their optional curation note is: $ARGUMENTS

Immediately before your brief final answer, call ${SPR_HANDOFF_TOOL} once with only the reusable method and verified constraints. Do not copy the transcript, hidden reasoning, raw tool output, secrets, or the final answer. Do not wait for or report the background result.`;
      });
    });
    const commandDisposable = disposable(commandRegistration);
    if (commandDisposable) registrations.push(commandDisposable);

    const toolRegistration = await runtime.tool.transform((tools) => {
      tools.add({
        name: SPR_HANDOFF_TOOL,
        description:
          "Queue a concise, transcript-free handoff for background SPR skill curation. Call once immediately before the final answer only when a durable reusable procedure was verified.",
        input: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              minLength: 1,
              maxLength: SPR_HANDOFF_MAX_CHARS,
              description:
                "Concise problem class, verified reusable method, and key constraints. Never include raw tool output, hidden reasoning, secrets, the transcript, or the full final answer.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
        options: { codemode: false, internal: true },
        execute: async (
          rawArgs: Record<string, unknown>,
          toolContext: {
            sessionID: string;
            agent: string;
            messageID: string;
          },
        ) => {
          if (
            stopped ||
            !allowedAgents.has(toolContext.agent) ||
            !toolContext.messageID
          )
            return { ok: false, error: "SPR handoff is not allowed here" };
          const turnKey = `${toolContext.sessionID}\u0000${toolContext.messageID}`;
          if (completed.has(turnKey))
            return { ok: true, queued: false, reason: "already-queued" };

          const summary =
            typeof rawArgs?.summary === "string" ? rawArgs.summary.trim() : "";
          if (!summary || summary.length > SPR_HANDOFF_MAX_CHARS)
            return { ok: false, error: "summary must be 1..4000 characters" };

          // Reserve before the first await so concurrent calls from one model turn
          // cannot enqueue duplicate reviews. Failures release the reservation.
          rememberCompleted(completed, turnKey);

          let location: ReturnType<typeof sessionLocation>;
          try {
            location = sessionLocation(
              await runtime.session.get?.({ sessionID: toolContext.sessionID }),
            );
          } catch {
            location = undefined;
          }
          if (!location) {
            completed.delete(turnKey);
            return { ok: false, error: "session location is unavailable" };
          }

          let queued = false;
          try {
            queued = await activation.enqueueHandoff({
              agent: toolContext.agent,
              ...location,
              summary,
            });
          } catch {
            // Fail closed without consuming this turn's one allowed attempt.
          }
          if (!queued) {
            completed.delete(turnKey);
            return { ok: false, error: "SPR handoff queue unavailable" };
          }
          return { ok: true, queued: true };
        },
      });
    });
    const toolDisposable = disposable(toolRegistration);
    if (toolDisposable) registrations.push(toolDisposable);

    const contextRegistration = await runtime.session.hook(
      "context",
      (event) => {
        for (const name of NATIVE_SKILL_TOOLS) delete event.tools[name];
        if (stopped || !allowedAgents.has(event.agent ?? "")) {
          delete event.tools[SPR_HANDOFF_TOOL];
          return;
        }
        if (!(SPR_HANDOFF_TOOL in event.tools)) return;
        if (
          event.system.some(
            (part) =>
              typeof part.text === "string" &&
              part.text.includes(SYSTEM_MARKER),
          )
        )
          return;
        event.system.push({ type: "text", text: SPR_HANDOFF_SYSTEM });
      },
    );
    const contextDisposable = disposable(contextRegistration);
    if (contextDisposable) registrations.push(contextDisposable);
  } catch (error) {
    stopped = true;
    completed.clear();
    await disposeRegistrations(registrations);
    throw error;
  }

  return async () => {
    stopped = true;
    completed.clear();
    await disposeRegistrations(registrations);
  };
}
