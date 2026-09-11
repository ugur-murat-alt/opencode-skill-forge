import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
  type Usage,
} from "@earendil-works/pi-ai";
export interface RunnerInput {
  profile: "skill_evolve" | "memory_curate";
  sessionId: string;
  model: Model<Api>;
  systemPrompt: string;
  input: string;
  tools: AgentTool[];
  stream: StreamFn;
  deadlineMs: number;
  maxCalls: number;
  maxTokens: number;
  maxCostMicros: number;
  signal?: AbortSignal;
}
export interface RunnerResult {
  finalized: boolean;
  calls: number;
  usage: Usage | null;
  elapsedMs: number;
  error: string | null;
  messages: AssistantMessage[];
}
function failedStream(model: Model<Api>, reason: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: reason,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}
/** One isolated Pi Agent per run. No host agent state or cross-user conversation. */
export class ForgeRunner {
  async run(input: RunnerInput): Promise<RunnerResult> {
    const start = performance.now();
    const deadline = AbortSignal.timeout(
      Math.max(1, Math.floor(input.deadlineMs)),
    );
    const signal = input.signal
      ? AbortSignal.any([deadline, input.signal])
      : deadline;
    let finalized = false,
      calls = 0,
      error: string | null = null;
    const messages: AssistantMessage[] = [];
    let usage: Usage | null = null;
    const agent = new Agent({
      initialState: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        thinkingLevel: "off",
      },
      sessionId: input.sessionId,
      toolExecution: "sequential",
      streamFn: async (model, context, options) => {
        if (
          signal.aborted ||
          finalized ||
          calls >= input.maxCalls ||
          (usage?.totalTokens ?? 0) >= input.maxTokens ||
          ((model.cost.input > 0 || model.cost.output > 0) &&
            Math.ceil((usage?.cost.total ?? 0) * 1_000_000) >=
              input.maxCostMicros)
        ) {
          error = signal.aborted ? "deadline_or_cancelled" : "budget_exhausted";
          return failedStream(model, error);
        }
        calls++;
        try {
          return await input.stream(model, context, {
            ...options,
            signal,
            maxTokens: Math.min(
              model.maxTokens,
              input.maxTokens - (usage?.totalTokens ?? 0),
            ),
          });
        } catch {
          error = "provider_error";
          return failedStream(model, error);
        }
      },
      beforeToolCall: async () =>
        finalized || signal.aborted
          ? { block: true, reason: "run_closed", terminate: true }
          : undefined,
      afterToolCall: async ({ toolCall, isError }) => {
        if (toolCall.name === "finalize" && !isError) finalized = true;
        return finalized ? { terminate: true } : undefined;
      },
      shouldStopAfterTurn: () =>
        finalized || signal.aborted || calls >= input.maxCalls,
    });
    agent.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant")
        return;
      const message = event.message as AssistantMessage;
      messages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted")
        error = message.errorMessage ? "provider_error" : message.stopReason;
      // Pi usage is per assistant message; reasoning is a subset of output.
      if (
        message.usage.totalTokens > 0 ||
        message.stopReason === "stop" ||
        message.stopReason === "toolUse"
      ) {
        const u = message.usage;
        usage ??= {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        for (const key of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "totalTokens",
        ] as const)
          usage[key] += u[key];
        if (u.reasoning !== undefined)
          usage.reasoning = (usage.reasoning ?? 0) + u.reasoning;
        for (const key of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "total",
        ] as const)
          usage.cost[key] += u.cost[key];
      }
    });
    const cancel = () => agent.abort();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!signal.aborted) await agent.prompt(input.input);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (signal.aborted) error = "deadline_or_cancelled";
    else if (!finalized && calls >= input.maxCalls)
      error ??= "call_budget_exhausted";
    return {
      finalized,
      calls,
      usage,
      elapsedMs: performance.now() - start,
      error,
      messages,
    };
  }
}
