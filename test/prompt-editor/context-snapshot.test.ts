import { describe, expect, test } from "bun:test";
import {
  collectContextSnapshot,
  CONTEXT_TRUNCATION_MARKER,
  MAX_ASSISTANT_CONTEXT_CODE_UNITS,
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_PARTS_PER_MESSAGE,
  MAX_SERIALIZED_CONTEXT_CODE_UNITS,
  MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS,
} from "../../src/prompt-editor/context-snapshot.js";
import {
  PROMPT_EDITOR_DEFAULTS,
  resolvePromptEditorOptions,
} from "../../src/prompt-editor/config.js";
import type { ChatMessage } from "../../src/prompt-editor/types.js";

function user(id: string, text = "user"): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function toolResult(
  kind: "text" | "json" | "error" | "content",
  value: unknown,
) {
  return { type: "tool-result", result: { type: kind, value } };
}

function toolParts(name: string, input: unknown, output: string) {
  const id = `call-${name}`;
  return [
    { type: "tool-call", id, name, input },
    {
      type: "tool-result",
      id,
      name,
      result: { type: "text", value: output },
    },
  ];
}

describe("collectContextSnapshot", () => {
  test("returns no snapshot for the first visible user message", () => {
    const messages = [
      {
        id: "system",
        role: "system",
        content: [{ type: "text", text: "rules" }],
      },
      user("first"),
    ] as ChatMessage[];

    expect(collectContextSnapshot(messages, "first", "/repo/exact")).toBeNull();
  });

  test("uses the exact directory and keeps the newest three user and assistant messages", () => {
    const messages = [
      user("u0", "user-0"),
      {
        id: "a0",
        role: "assistant",
        content: [{ type: "text", text: "assistant-0" }],
      },
      user("u1", "user-1"),
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "assistant-1" }],
      },
      user("u2", "user-2"),
      {
        id: "a2",
        role: "assistant",
        content: [{ type: "text", text: "assistant-2" }],
      },
      user("u3", "user-3"),
      {
        id: "a3",
        role: "assistant",
        content: [{ type: "text", text: "assistant-3" }],
      },
      user("current"),
    ] as ChatMessage[];

    expect(
      collectContextSnapshot(messages, messages.at(-1)!, "/repo/a b"),
    ).toEqual({
      directory: "/repo/a b",
      userMessages: ["user-1", "user-2", "user-3"],
      assistantMessages: ["assistant-1", "assistant-2", "assistant-3"],
      toolCalls: [],
    });
    const snapshot = collectContextSnapshot(messages, "current", "/repo/a b");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.userMessages)).toBe(true);
    expect(Object.isFrozen(snapshot?.assistantMessages)).toBe(true);
    expect(Object.isFrozen(snapshot?.toolCalls)).toBe(true);
  });

  test("keeps the newest ten tool calls with sanitized inputs and outputs", () => {
    const messages: ChatMessage[] = [user("first")];
    for (let index = 0; index < 11; index += 1) {
      messages.push({
        role: "assistant",
        content: toolParts(`tool-${index}`, { index }, `output-${index}`),
      });
    }
    messages.push(user("current"));

    const snapshot = collectContextSnapshot(
      messages,
      messages.length - 1,
      "/repo",
    );
    expect(snapshot?.toolCalls.map((call) => call.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `tool-${index + 1}`),
    );
    expect(snapshot?.toolCalls[0]).toEqual({
      name: "tool-1",
      status: "completed",
      input: '{"index":1}',
      output: { kind: "text", text: "output-1" },
    });
    expect(Object.isFrozen(snapshot?.toolCalls[0])).toBe(true);
    expect(Object.isFrozen(snapshot?.toolCalls[0]?.output)).toBe(true);
  });

  test("normalizes JSON, errors, and text content while omitting unsafe parts", () => {
    class UnsafeValue {
      value = "do not serialize";
    }
    const messages = [
      user("first"),
      {
        role: "tool",
        content: [
          toolResult("json", { answer: 42 }),
          toolResult("error", "command failed"),
          toolResult("content", [
            { type: "text", text: "first content" },
            { type: "file", uri: "file:///secret", mime: "text/plain" },
            { type: "text", text: "second content" },
          ]),
          {
            type: "tool-result",
            state: "running",
            result: { type: "text", value: "partial" },
          },
          {
            type: "tool-result",
            result: { type: "json", value: new UnsafeValue() },
          },
          { type: "reasoning", text: "hidden chain" },
          { type: "media", data: "image-bytes" },
          { type: "tool-call", input: { secret: "never include" } },
          {
            type: "tool-result",
            result: {
              type: "content",
              value: [
                { type: "file", uri: "file:///only", mime: "text/plain" },
              ],
            },
          },
          { type: "tool-result" },
        ],
      },
      { role: "assistant", content: [{ type: "reasoning", text: "hidden" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
      },
      user("current"),
    ] as ChatMessage[];

    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    expect(snapshot?.toolCalls.map((call) => call.output)).toEqual([
      { kind: "json", text: '{"answer":42}' },
      { kind: "error", text: "command failed" },
      { kind: "content", text: "first contentsecond content" },
      null,
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("never include");
    expect(JSON.stringify(snapshot)).toContain("[redacted]");
  });

  test("marks per-field truncation deterministically", () => {
    const messages = [
      user("first"),
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "a".repeat(MAX_ASSISTANT_CONTEXT_CODE_UNITS + 1),
          },
        ],
      },
      {
        role: "tool",
        content: [
          toolResult(
            "text",
            "b".repeat(MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS + 1),
          ),
        ],
      },
      user("current"),
    ] as ChatMessage[];

    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    expect(snapshot?.assistantMessages[0]).toHaveLength(
      MAX_ASSISTANT_CONTEXT_CODE_UNITS,
    );
    expect(
      snapshot?.assistantMessages[0]?.endsWith(CONTEXT_TRUNCATION_MARKER),
    ).toBe(true);
    expect(snapshot?.toolCalls[0]?.output?.text.length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS,
    );
    expect(
      snapshot?.toolCalls[0]?.output?.text.endsWith(CONTEXT_TRUNCATION_MARKER),
    ).toBe(true);
  });

  test("marks truncation when a later assistant text part exceeds the exact limit", () => {
    const messages = [
      user("first"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(MAX_ASSISTANT_CONTEXT_CODE_UNITS) },
          { type: "text", text: "later" },
        ],
      },
      user("current"),
    ] as ChatMessage[];
    expect(
      collectContextSnapshot(
        messages,
        "current",
        "/repo",
      )?.assistantMessages[0]?.endsWith(CONTEXT_TRUNCATION_MARKER),
    ).toBe(true);
  });

  test("keeps tool-call counts while truncating text to meet the aggregate cap", () => {
    const messages: ChatMessage[] = [user("first")];
    for (let index = 0; index < 10; index += 1) {
      messages.push({
        role: "tool",
        content: [
          toolResult(
            "text",
            `${index}:${'"'.repeat(MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS - 2)}`,
          ),
        ],
      });
    }
    messages.push(user("current"));

    const snapshot = collectContextSnapshot(messages, "current", "/repo", {
      ...PROMPT_EDITOR_DEFAULTS,
      contextMaxChars: 2_048,
    });
    expect(snapshot).not.toBeNull();
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(2_048);
    expect(snapshot!.toolCalls).toHaveLength(10);
    expect(
      snapshot!.toolCalls.every((call) =>
        call.output?.text.endsWith(CONTEXT_TRUNCATION_MARKER),
      ),
    ).toBe(true);
  });

  test("resolved aggregate minimum preserves 3+3+10 with long tool names", () => {
    const messages: ChatMessage[] = [];
    const escapeHeavy = '\u0000"\\'.repeat(100);
    for (let index = 0; index < 3; index += 1) {
      messages.push(user(`u-${index}`, `user-${index}-${escapeHeavy}`));
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant-${index}-${escapeHeavy}` }],
      });
    }
    for (let index = 0; index < 10; index += 1) {
      messages.push({
        role: "assistant",
        content: toolParts(
          `${index}-${escapeHeavy}`,
          { index, text: `input-${index}-${escapeHeavy}` },
          `output-${index}-${escapeHeavy}`,
        ),
      });
    }
    messages.push(user("current"));
    const config = resolvePromptEditorOptions({
      promptEditor: { contextMaxChars: 1_024 },
    });

    const snapshot = collectContextSnapshot(
      messages,
      "current",
      "/repo",
      config,
    );
    expect(snapshot?.userMessages).toHaveLength(3);
    expect(snapshot?.assistantMessages).toHaveLength(3);
    expect(snapshot?.toolCalls).toHaveLength(10);
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(
      config.contextMaxChars,
    );
  });

  test("bounds deep JSON traversal and redacts common credential material", () => {
    let deep: Record<string, unknown> = { apiKey: "top-secret" };
    for (let index = 0; index < 100; index += 1) deep = { child: deep };
    const messages = [
      user("first"),
      {
        role: "tool",
        content: [
          toolResult("json", {
            password: "hunter2",
            nested: deep,
            values: Array.from({ length: 1_000 }, (_, index) => index),
          }),
          toolResult(
            "text",
            "Authorization: Bearer abc.def.ghi\nSERVICE_TOKEN=secret-value",
          ),
        ],
      },
      user("current"),
    ] as ChatMessage[];

    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain(CONTEXT_TRUNCATION_MARKER);
    expect(serialized.length).toBeLessThanOrEqual(
      MAX_SERIALIZED_CONTEXT_CODE_UNITS,
    );
  });

  test("redacts and bounds JSON property names and serialized output", () => {
    const token = `ghp_${"z".repeat(36)}`;
    const longKey = "k".repeat(600);
    const value = Object.fromEntries([
      [token, "visible"],
      [longKey, "visible"],
      ...Array.from({ length: 62 }, (_, index) => [
        `field_${index}`,
        "value".repeat(30),
      ]),
    ]);
    const messages = [
      user("first"),
      { role: "tool", content: [toolResult("json", value)] },
      user("current"),
    ] as ChatMessage[];
    const output = collectContextSnapshot(messages, "current", "/repo")
      ?.toolCalls[0]?.output?.text;
    expect(output).toBeDefined();
    expect(output!.length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS,
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain(longKey);
    expect(output).toContain(CONTEXT_TRUNCATION_MARKER);
  });

  test("treats an over-budget JSON key as sensitive without scanning its tail", () => {
    const hugeKey = "harmless".repeat(10_000);
    const messages = [
      user("first"),
      {
        role: "tool",
        content: [toolResult("json", { [hugeKey]: "must be redacted" })],
      },
      user("current"),
    ] as ChatMessage[];
    const output = collectContextSnapshot(messages, "current", "/repo")
      ?.toolCalls[0]?.output?.text;
    expect(output).toBeDefined();
    expect(output!.length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS,
    );
    expect(output).not.toContain(hugeKey);
    expect(output).not.toContain("must be redacted");
    expect(output).toContain("[redacted]");
  });

  test("redacts lowercase assignments and private keys before truncation", () => {
    const privateKey = `${"x".repeat(MAX_ASSISTANT_CONTEXT_CODE_UNITS - 20)}-----BEGIN PRIVATE KEY-----${"secret".repeat(500)}`;
    const messages = [
      user("first"),
      { role: "assistant", content: privateKey },
      {
        role: "tool",
        content: [
          toolResult(
            "text",
            "token: lowercase-secret\napi_key=another-secret\npassword: hunter2",
          ),
        ],
      },
      user("current"),
    ] as ChatMessage[];
    const serialized = JSON.stringify(
      collectContextSnapshot(messages, "current", "/repo"),
    );
    expect(serialized).not.toContain("lowercase-secret");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).toContain("[redacted");
  });

  test("redacts complete Basic authorization and cookie header values", () => {
    const messages = [
      user("prior", "Authorization: Basic dXNlcjpwYXNz"),
      {
        role: "assistant",
        content: "Cookie: sid=private; theme=dark\nvisible",
      },
      user("current"),
    ] as ChatMessage[];
    const serialized = JSON.stringify(
      collectContextSnapshot(messages, "current", "/repo"),
    );
    expect(serialized).not.toContain("dXNlcjpwYXNz");
    expect(serialized).not.toContain("sid=private");
    expect(serialized).not.toContain("theme=dark");
    expect(serialized).toContain("[redacted]");
  });

  test("redacts standalone provider tokens in assistant, text, and JSON output", () => {
    const github = `ghp_${"a".repeat(36)}`;
    const openai = `sk-${"b".repeat(32)}`;
    const aws = `AKIA${"C".repeat(16)}`;
    const crossing = `${"x".repeat(MAX_ASSISTANT_CONTEXT_CODE_UNITS - 8)}${github}`;
    const messages = [
      user("first"),
      { role: "assistant", content: crossing },
      {
        role: "tool",
        content: [
          toolResult("text", openai),
          toolResult("json", { value: aws }),
        ],
      },
      user("current"),
    ] as ChatMessage[];
    const serialized = JSON.stringify(
      collectContextSnapshot(messages, "current", "/repo"),
    );
    expect(serialized).not.toContain(github);
    expect(serialized).not.toContain(openai);
    expect(serialized).not.toContain(aws);
    expect(serialized).toContain("[redacted token]");
  });

  test("redacts secrets split across tool content boundaries", () => {
    const github = `ghp_${"a".repeat(36)}`;
    const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const bearer = "abc.def.ghi";
    const messages = [
      user("first"),
      {
        role: "tool",
        content: [
          toolResult("content", [
            { type: "text", text: github.slice(0, 12) },
            { type: "text", text: github.slice(12) },
            { type: "text", text: " AWS_SECRET_ACCESS_KEY=" },
            { type: "text", text: awsSecret },
            { type: "text", text: " Bearer " },
            { type: "text", text: bearer },
            { type: "text", text: " -----BEGIN PRIVATE " },
            { type: "text", text: "KEY-----private-material" },
          ]),
        ],
      },
      user("current"),
    ] as ChatMessage[];
    const serialized = JSON.stringify(
      collectContextSnapshot(messages, "current", "/repo"),
    );
    expect(serialized).not.toContain(github);
    expect(serialized).not.toContain(awsSecret);
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain("private-material");
    expect(serialized).toContain("[redacted");
  });

  test("redacts an unterminated quoted assignment through the scan boundary", () => {
    const secret = "private words ".repeat(500);
    const messages = [
      user("first"),
      { role: "assistant", content: `API_KEY="${secret}"` },
      user("current"),
    ] as ChatMessage[];
    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    expect(snapshot?.assistantMessages[0]).toContain("API_KEY=[redacted]");
    expect(snapshot?.assistantMessages[0]).not.toContain("private words");
  });

  test("selects the exact current message outside the retained history tail", () => {
    const current = user("current");
    const messages = [
      user("prior"),
      { role: "assistant", content: "nearest" },
      current,
      ...Array.from({ length: MAX_CONTEXT_MESSAGES + 20 }, (_, index) =>
        user(`later-${index}`),
      ),
    ] as ChatMessage[];
    expect(
      collectContextSnapshot(messages, current, "/repo")?.assistantMessages[0],
    ).toBe("nearest");
    expect(
      collectContextSnapshot(messages, 2, "/repo")?.assistantMessages[0],
    ).toBe("nearest");
    expect(
      collectContextSnapshot(messages, "current", "/repo")
        ?.assistantMessages[0],
    ).toBe("nearest");
  });

  test("uses both ends of a bounded part window", () => {
    const assistantParts = [
      ...Array.from({ length: MAX_CONTEXT_PARTS_PER_MESSAGE + 10 }, () => ({
        type: "image",
      })),
      { type: "text", text: "assistant tail" },
    ];
    const toolParts = [
      toolResult("text", "tool head"),
      ...Array.from({ length: MAX_CONTEXT_PARTS_PER_MESSAGE + 10 }, () => ({
        type: "image",
      })),
    ];
    const messages = [
      user("prior"),
      { role: "tool", content: toolParts },
      { role: "assistant", content: assistantParts },
      user("current"),
    ] as ChatMessage[];
    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    expect(snapshot?.assistantMessages[0]).toContain("assistant tail");
    expect(snapshot?.toolCalls.map((call) => call.output?.text)).toEqual([
      "tool head",
    ]);
  });

  test("intentionally omits the unbounded middle of a large part list", () => {
    const parts = Array.from(
      { length: MAX_CONTEXT_PARTS_PER_MESSAGE + 1 },
      () => ({ type: "image" }),
    );
    parts[Math.floor(parts.length / 2)] = toolResult("text", "middle tool");
    const messages = [
      user("prior"),
      { role: "tool", content: parts },
      { role: "assistant", content: "nearest" },
      user("current"),
    ] as ChatMessage[];
    expect(
      collectContextSnapshot(messages, "current", "/repo")?.toolCalls,
    ).toEqual([]);
  });

  test("malformed in-window context fails open to no snapshot", () => {
    const malformed = new Proxy(
      {},
      {
        get() {
          throw new Error("malformed context");
        },
      },
    ) as ChatMessage;
    expect(
      collectContextSnapshot([user("prior"), malformed], 1, "/repo"),
    ).toBeNull();
  });

  test("bounds message and part traversal before normalization", () => {
    const inaccessible = new Proxy(
      { role: "tool", content: [] },
      {
        get() {
          throw new Error("out-of-window message was traversed");
        },
      },
    ) as unknown as ChatMessage;
    const skippedPart = new Proxy(
      { type: "tool-result" },
      {
        get() {
          throw new Error("out-of-window part was traversed");
        },
      },
    );
    const boundedParts = [
      skippedPart,
      ...Array.from({ length: MAX_CONTEXT_PARTS_PER_MESSAGE }, (_, index) =>
        toolResult("text", `recent-${index}`),
      ),
    ];
    const messages = [
      inaccessible,
      ...Array.from(
        { length: MAX_CONTEXT_MESSAGES + 4 },
        () => ({ role: "system", content: [] }) as ChatMessage,
      ),
      user("prior"),
      { role: "tool", content: boundedParts },
      { role: "assistant", content: "nearest" },
      user("current"),
    ];
    const snapshot = collectContextSnapshot(messages, "current", "/repo");
    expect(snapshot?.assistantMessages[0]).toBe("nearest");
    expect(snapshot?.toolCalls).toHaveLength(10);
    expect(snapshot?.toolCalls.at(-1)?.output?.text).toBe(
      `recent-${MAX_CONTEXT_PARTS_PER_MESSAGE - 1}`,
    );
  });
});
