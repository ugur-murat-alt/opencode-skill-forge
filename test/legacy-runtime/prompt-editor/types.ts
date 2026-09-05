// Structural types describing the parts of the OpenCode V2 plugin context
// that the prompt-editor subsystem touches. Kept minimal and dependency-free:
// the plugin is compiled with `bun build`, so we only rely on shape.

export type MessageContentPart = { type: string } & Record<string, unknown>;

export interface ChatMessage {
  id?: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: Array<MessageContentPart> | string;
  [key: string]: unknown;
}

/** Input delivered to a `session.hook("context", ...)` callback. */
export interface ContextHookEvent {
  sessionID: string;
  agent?: string | null;
  model?: unknown;
  /** Mutable system prompt parts. */
  system: Array<{ type: string; text?: string } & Record<string, unknown>>;
  /** Mutable messages that will be sent to the model this request. */
  messages: ChatMessage[];
  /** Mutable tools dict for this request. */
  tools: Record<string, unknown>;
}

export interface SubmitPayload {
  prompt: string;
  learn?: string;
}

export interface JournalEntry {
  ts: number;
  sessionID: string;
  messageID?: string | null;
  model?: string | null;
  outcome: string;
  originalLen?: number;
  rewrittenLen?: number;
  durationMs: number;
  steps?: number;
  error?: string;
}

/** Minimal shape of the plugin runtime context we rely on. */
export interface PluginRuntime {
  options?: Record<string, unknown>;
  session: {
    hook: (
      name: "context",
      cb: (e: ContextHookEvent) => Promise<void> | void,
    ) => Promise<unknown>;
    create: (
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => Promise<{ id?: string | null }>;
    prompt: (
      input: { sessionID: string; text: string },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    /** Wait until the session agent loop is idle (OpenCode V2 session.wait). */
    wait: (
      input: { sessionID: string },
      options?: { signal?: AbortSignal },
    ) => Promise<void>;
    interrupt: (
      input: { sessionID: string },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    get?: <T = unknown>(input: {
      sessionID: string;
    }) => Promise<
      T & {
        location?: {
          directory?: string | null;
          workspaceID?: string | null;
        } | null;
      } & {
        /** Subagent/derived sessions are always parented; primary sessions are not. */
        parentID?: string | null;
        parent_id?: string | null;
      }
    >;
    message?: (input: {
      sessionID: string;
      messageID: string;
    }) => Promise<{ type?: string }>;
  };
  agent: {
    transform: (
      cb: (draft: {
        list: () => Array<{ id?: string; [k: string]: unknown }>;
        get: (id: string) => { id?: string; [k: string]: unknown } | undefined;
        update: (id: string, fn: (a: Record<string, any>) => void) => void;
      }) => void,
    ) => Promise<unknown>;
    list?: (input?: Record<string, unknown>) => Promise<{
      location?: {
        directory?: string | null;
        workspaceID?: string | null;
      } | null;
      data?: Array<{
        id?: string;
        mode?: string;
        hidden?: boolean;
        [k: string]: unknown;
      }>;
    }>;
  };
  plugin?: {
    list?: (input?: {
      location?: { directory?: string; workspace?: string };
    }) => Promise<{
      data?: Array<{
        id?: string;
        source?: { type?: string; [k: string]: unknown };
        [k: string]: unknown;
      }>;
      [k: string]: unknown;
    }>;
  };
  tool: {
    transform: (
      cb: (draft: { add: (tool: Record<string, unknown>) => void }) => void,
    ) => Promise<unknown>;
  };
  event: {
    subscribe: (input?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
}
