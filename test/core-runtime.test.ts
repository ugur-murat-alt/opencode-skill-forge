import { afterEach, describe, expect, test } from "bun:test";
import {
  CORE_RUNTIME_STATE,
  registerCoreActivation,
  type CoreContextEvent,
  type CoreRuntimeContext,
  type EditorSessionLookup,
} from "./legacy-runtime/core-runtime.js";

interface MockRuntime extends CoreRuntimeContext {
  events: unknown[];
  contextHooks: Array<(event: CoreContextEvent) => Promise<void> | void>;
  toolHooks: Array<(event: Record<string, unknown>) => Promise<void> | void>;
  created: string[];
  sessions: Map<string, Record<string, unknown>>;
}

function noEditorSessions(): EditorSessionLookup {
  return { isEditorSession: () => false };
}

function makeRuntime(
  name: string,
  editorRegistry: EditorSessionLookup = noEditorSessions(),
  directory = "/workspace",
  workspaceID?: string,
): {
  runtime: MockRuntime;
  editorRegistry: EditorSessionLookup;
} {
  const contextHooks: MockRuntime["contextHooks"] = [];
  const toolHooks: MockRuntime["toolHooks"] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const location = { directory, ...(workspaceID ? { workspaceID } : {}) };
  let nextReview = 1;
  const runtime: MockRuntime = {
    options: { name },
    events: [],
    contextHooks,
    toolHooks,
    created: [],
    sessions,
    session: {
      create: async (input) => {
        const id = `review-${name}-${nextReview++}`;
        sessions.set(id, { id, ...input });
        runtime.created.push(id);
        return { id };
      },
      hook: async (hookName, callback) => {
        if (hookName === "context") contextHooks.push(callback);
      },
      get: async ({ sessionID }) =>
        sessions.get(sessionID) ?? {
          id: sessionID,
          agent: "build",
          location,
        },
    },
    event: {
      subscribe: () =>
        (async function* () {
          yield* runtime.events;
        })(),
    },
    agent: {
      list: async () => ({
        location,
        data: [
          { id: "build", mode: "primary", hidden: false },
          { id: "hidden", mode: "primary", hidden: true },
          { id: "subagent", mode: "subagent", hidden: false },
        ],
      }),
    },
    tool: {
      hook: async (_name, callback) => {
        toolHooks.push(callback);
      },
    },
  };
  return { runtime, editorRegistry };
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function dispatchContext(
  runtime: MockRuntime,
  event: CoreContextEvent,
): Promise<void> {
  for (const hook of runtime.contextHooks) await hook(event);
}

async function dispatchTool(
  runtime: MockRuntime,
  event: Record<string, unknown>,
): Promise<void> {
  for (const hook of runtime.toolHooks) await hook(event);
}

afterEach(() => {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const state = host[CORE_RUNTIME_STATE] as
    | {
        activations?: Map<unknown, unknown>;
        sessionRoutes?: Map<unknown, unknown>;
        reviewOwners?: Map<unknown, unknown>;
        blockedSessionIDs?: Map<unknown, unknown>;
        deletedSessionIDs?: Map<unknown, unknown>;
        eventClaims?: Map<unknown, unknown>;
        deliveredEventIDs?: Map<unknown, unknown>;
        handoffSources?: Map<unknown, unknown>;
      }
    | undefined;
  state?.activations?.clear();
  state?.sessionRoutes?.clear();
  state?.reviewOwners?.clear();
  state?.blockedSessionIDs?.clear();
  state?.deletedSessionIDs?.clear();
  state?.eventClaims?.clear();
  state?.deliveredEventIDs?.clear();
  state?.handoffSources?.clear();
});

describe("core runtime router", () => {
  test("routes shared raw events to exactly one activation", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    a.runtime.events = [
      {
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
    ];
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    b.runtime.events = a.runtime.events;
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents.length + secondEvents.length).toBe(1);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("routes a session only to the activation matching its directory", async () => {
    const a = makeRuntime("a", noEditorSessions(), "/workspace/a");
    const b = makeRuntime("b", noEditorSessions(), "/workspace/b");
    const event = {
      id: "event-project-b",
      type: "session.execution.started",
      location: { directory: "/workspace/b" },
      data: { sessionID: "owner-b", agent: "build" },
    };
    a.runtime.events = [event];
    b.runtime.events = [event];
    a.runtime.sessions.set("owner-b", {
      id: "owner-b",
      agent: "build",
      location: { directory: "/workspace/b" },
    });
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents).toEqual([]);
      expect(secondEvents).toEqual([event]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("distinguishes workspaces that share the same directory", async () => {
    const a = makeRuntime(
      "a",
      noEditorSessions(),
      "/workspace/shared",
      "workspace-a",
    );
    const b = makeRuntime(
      "b",
      noEditorSessions(),
      "/workspace/shared",
      "workspace-b",
    );
    const event = {
      id: "workspace-b-event",
      type: "session.execution.started",
      location: {
        directory: "/workspace/shared",
        workspaceID: "workspace-b",
      },
      data: { sessionID: "owner-b", agent: "build" },
    };
    a.runtime.events = [event];
    b.runtime.events = [event];
    a.runtime.sessions.set("owner-b", {
      id: "owner-b",
      agent: "build",
      location: {
        directory: "/workspace/shared",
        workspaceID: "workspace-b",
      },
    });
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents).toEqual([]);
      expect(secondEvents).toEqual([event]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("reassigns a routed session when it moves locations", async () => {
    const a = makeRuntime("a", noEditorSessions(), "/workspace/a");
    const b = makeRuntime("b", noEditorSessions(), "/workspace/b");
    const started = {
      id: "move-started",
      type: "session.execution.started",
      location: { directory: "/workspace/a" },
      data: { sessionID: "moving", agent: "build" },
    };
    const moved = {
      id: "move-location",
      type: "session.moved",
      location: { directory: "/workspace/b" },
      data: {
        sessionID: "moving",
        location: { directory: "/workspace/b" },
      },
    };
    const succeeded = {
      id: "move-succeeded",
      type: "session.execution.succeeded",
      location: { directory: "/workspace/b" },
      data: { sessionID: "moving" },
    };
    a.runtime.events = [started, moved, succeeded];
    b.runtime.events = a.runtime.events;
    a.runtime.sessions.set("moving", {
      id: "moving",
      agent: "build",
      location: { directory: "/workspace/b" },
    });
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents).toEqual([started]);
      expect(secondEvents).toEqual([moved, succeeded]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("routes events whose project location differs from the activation scope", async () => {
    // Regression: beta servers tag bus events with the session's project
    // directory while the activation registers the service-wide directory.
    // An unmatched location must fall through to the lone-activation
    // fallback instead of silently starving the core of every event.
    const a = makeRuntime("a", noEditorSessions(), "/home/ugur");
    const event = {
      id: "project-location-event",
      type: "session.execution.started",
      location: { directory: "/home/ugur/Projects/Demo" },
      data: { sessionID: "owner-project", agent: "build" },
    };
    a.runtime.events = [event];
    a.runtime.sessions.set("owner-project", {
      id: "owner-project",
      agent: "build",
      location: { directory: "/home/ugur/Projects/Demo" },
    });
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    try {
      expect(
        await collect(activation.createContext().event.subscribe()),
      ).toEqual([event]);
    } finally {
      activation.cleanup();
    }
  });

  test("stays fail-closed for unmatched locations across multiple activations", async () => {
    const a = makeRuntime("a", noEditorSessions(), "/workspace/a");
    const b = makeRuntime("b", noEditorSessions(), "/workspace/b");
    const event = {
      id: "unclaimed-location-event",
      type: "session.execution.started",
      location: { directory: "/workspace/unclaimed" },
      data: { sessionID: "owner-unclaimed", agent: "build" },
    };
    a.runtime.events = [event];
    b.runtime.events = [event];
    a.runtime.sessions.set("owner-unclaimed", {
      id: "owner-unclaimed",
      agent: "build",
      location: { directory: "/workspace/unclaimed" },
    });
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents).toEqual([]);
      expect(secondEvents).toEqual([]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("fails closed when a shared event has no resolvable project scope", async () => {
    const a = makeRuntime("a", noEditorSessions(), "/workspace/a");
    const b = makeRuntime("b", noEditorSessions(), "/workspace/b");
    const event = {
      id: "scope-unknown",
      type: "session.execution.started",
      data: { sessionID: "unknown", agent: "build" },
    };
    a.runtime.events = [event];
    b.runtime.events = [event];
    a.runtime.session.get = async () => undefined;
    b.runtime.session.get = async () => undefined;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      expect(await collect(first.createContext().event.subscribe())).toEqual(
        [],
      );
      expect(await collect(second.createContext().event.subscribe())).toEqual(
        [],
      );
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("keeps execution lifecycle events with their first owner", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const events = [
      {
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
      { type: "session.execution.succeeded", data: { sessionID: "owner" } },
    ];
    a.runtime.events = events;
    b.runtime.events = events;
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    b.runtime.sessions.set("owner", { id: "owner", agent: "build" });

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const firstEvents = await collect(
        first.createContext().event.subscribe(),
      );
      const secondEvents = await collect(
        second.createContext().event.subscribe(),
      );
      expect(firstEvents).toHaveLength(2);
      expect(secondEvents).toHaveLength(0);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("blocks a routed session after it switches to an SPR agent", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const events = [
      {
        id: "role-started",
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
      {
        id: "role-selected",
        type: "session.agent.selected",
        data: { sessionID: "owner", agent: "spr", previous: "build" },
      },
      {
        id: "role-succeeded",
        type: "session.execution.succeeded",
        data: { sessionID: "owner" },
      },
    ];
    a.runtime.events = events;
    b.runtime.events = events;
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    b.runtime.sessions = a.runtime.sessions;

    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents.length + secondEvents.length).toBe(1);
      expect([...firstEvents, ...secondEvents]).toEqual([events[0]]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("blocks a routed session after it switches to a hidden agent", async () => {
    const a = makeRuntime("a");
    const events = [
      {
        id: "hidden-started",
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
      {
        id: "hidden-selected",
        type: "session.agent.selected",
        data: { sessionID: "owner", agent: "hidden", previous: "build" },
      },
      {
        id: "hidden-succeeded",
        type: "session.execution.succeeded",
        data: { sessionID: "owner" },
      },
    ];
    a.runtime.events = events;
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    try {
      expect(
        await collect(activation.createContext().event.subscribe()),
      ).toEqual([events[0]]);
    } finally {
      activation.cleanup();
    }
  });

  test("delivers a created SPR review context only to its creator", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    const firstContext = first.createContext();
    const secondContext = second.createContext();
    let firstCalls = 0;
    let secondCalls = 0;
    await firstContext.session.hook("context", (event) => {
      firstCalls += 1;
      delete event.tools?.read;
    });
    await secondContext.session.hook("context", () => {
      secondCalls += 1;
    });

    try {
      const created = (await firstContext.session.create({ agent: "spr" })) as {
        id: string;
      };
      const event: CoreContextEvent = {
        sessionID: created.id,
        agent: "spr",
        tools: { read: {}, skill: {} },
      };
      await dispatchContext(a.runtime, event);
      await dispatchContext(b.runtime, event);

      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(0);
      expect(event.tools?.read).toBeUndefined();
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("quarantines SPR context until its create response records ownership", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    let resolveCreate!: (value: unknown) => void;
    a.runtime.session.create = async () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      });
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    const firstContext = first.createContext();
    const secondContext = second.createContext();
    let firstCalls = 0;
    let secondCalls = 0;
    await firstContext.session.hook("context", () => {
      firstCalls += 1;
    });
    await secondContext.session.hook("context", () => {
      secondCalls += 1;
    });

    try {
      const creating = firstContext.session.create({ agent: "spr" });
      const event: CoreContextEvent = {
        sessionID: "review-delayed",
        agent: "spr",
        tools: { read: {} },
      };
      await dispatchContext(a.runtime, event);
      await dispatchContext(b.runtime, event);
      expect(firstCalls).toBe(0);
      expect(secondCalls).toBe(0);

      resolveCreate({ id: "review-delayed" });
      await creating;
      await dispatchContext(a.runtime, event);
      await dispatchContext(b.runtime, event);
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(0);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("recognizes the published omni-spr reviewer identity", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    const firstContext = first.createContext();
    const secondContext = second.createContext();
    let firstCalls = 0;
    let secondCalls = 0;
    await firstContext.session.hook("context", () => {
      firstCalls += 1;
    });
    await secondContext.session.hook("context", () => {
      secondCalls += 1;
    });

    try {
      const created = (await firstContext.session.create({
        agent: "omni-spr",
        title: "skill-power-review",
      })) as { id: string };
      const event: CoreContextEvent = {
        sessionID: created.id,
        agent: "omni-spr",
        tools: { read: {} },
      };
      await dispatchContext(a.runtime, event);
      await dispatchContext(b.runtime, event);
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(0);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("skips unknown SPR context without changing its tools", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    let calls = 0;
    await activation.createContext().session.hook("context", (event) => {
      calls += 1;
      delete event.tools?.read;
    });

    try {
      const event: CoreContextEvent = {
        sessionID: "stale-review",
        agent: "spr",
        tools: { read: {}, skill: {} },
      };
      await dispatchContext(a.runtime, event);
      expect(calls).toBe(0);
      expect(event.tools).toEqual({ read: {}, skill: {} });
    } finally {
      activation.cleanup();
    }
  });

  test("skips parented, forked, hidden, and subagent contexts", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    let calls = 0;
    await activation.createContext().session.hook("context", () => {
      calls += 1;
    });

    try {
      for (const event of [
        {
          sessionID: "parented",
          agent: "build",
          parentID: "parent",
          tools: { read: {} },
        },
        {
          sessionID: "legacy-parented",
          agent: "build",
          parent_id: "parent",
          tools: { read: {} },
        },
        {
          sessionID: "forked",
          agent: "build",
          fork: { sessionID: "source" },
          tools: { read: {} },
        },
        { sessionID: "hidden", agent: "hidden", tools: { read: {} } },
        { sessionID: "subagent", agent: "subagent", tools: { read: {} } },
      ]) {
        await dispatchContext(a.runtime, event);
        expect(event.tools).toEqual({ read: {} });
      }
      expect(calls).toBe(0);
    } finally {
      activation.cleanup();
    }
  });

  test("routes new work after an owner cleanup and tolerates duplicate cleanup", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      a.runtime.events = [
        {
          type: "session.execution.started",
          data: { sessionID: "first", agent: "build" },
        },
      ];
      a.runtime.sessions.set("first", { id: "first", agent: "build" });
      await collect(first.createContext().event.subscribe());

      first.cleanup();
      first.cleanup();
      b.runtime.events = [
        {
          type: "session.execution.started",
          data: { sessionID: "second", agent: "build" },
        },
      ];
      b.runtime.sessions.set("second", { id: "second", agent: "build" });
      expect(
        await collect(second.createContext().event.subscribe()),
      ).toHaveLength(1);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("fences an event lookup that finishes after cleanup", async () => {
    const a = makeRuntime("a");
    let resolveLookup!: (value: unknown) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    a.runtime.session.get = async () => {
      lookupStarted();
      return new Promise((resolve) => {
        resolveLookup = resolve;
      });
    };
    a.runtime.events = [
      {
        id: "cleanup-race",
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
    ];
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    const pending = collect(activation.createContext().event.subscribe());
    await started;
    activation.cleanup();
    resolveLookup({
      id: "owner",
      agent: "build",
      location: { directory: "/workspace" },
    });
    expect(await pending).toEqual([]);
  });

  test("fences a context lookup that finishes after cleanup", async () => {
    const a = makeRuntime("a");
    let resolveLookup!: (value: unknown) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    a.runtime.session.get = async () => {
      lookupStarted();
      return new Promise((resolve) => {
        resolveLookup = resolve;
      });
    };
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    let calls = 0;
    await activation.createContext().session.hook("context", () => {
      calls += 1;
    });
    const pending = dispatchContext(a.runtime, {
      sessionID: "owner",
      agent: "build",
      tools: { read: {} },
    });
    await started;
    activation.cleanup();
    resolveLookup({
      id: "owner",
      agent: "build",
      location: { directory: "/workspace" },
    });
    await pending;
    expect(calls).toBe(0);
  });

  test("delivers deletion once and tombstones late events", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const initial = [
        {
          type: "session.execution.started",
          data: { sessionID: "owner", agent: "build" },
        },
        { type: "session.deleted", data: { sessionID: "owner" } },
      ];
      a.runtime.events = initial;
      b.runtime.events = initial;
      a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
      b.runtime.sessions.set("owner", { id: "owner", agent: "build" });
      expect(
        await collect(first.createContext().event.subscribe()),
      ).toHaveLength(2);

      first.cleanup();
      b.runtime.events = [
        {
          id: "late-owner-event",
          type: "session.execution.started",
          data: { sessionID: "owner", agent: "build" },
        },
      ];
      expect(
        await collect(second.createContext().event.subscribe()),
      ).toHaveLength(0);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("tombstones deletion before the consumer requests another event", async () => {
    const a = makeRuntime("a");
    a.runtime.events = [
      {
        id: "delete-started",
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
      {
        id: "delete-terminal",
        type: "session.deleted",
        data: { sessionID: "owner" },
      },
    ];
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    const iterator = activation
      .createContext()
      .event.subscribe()
      [Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toEqual(a.runtime.events[0]);
      expect((await iterator.next()).value).toEqual(a.runtime.events[1]);
      const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
        CORE_RUNTIME_STATE
      ] as {
        sessionRoutes: Map<string, unknown>;
        deletedSessionIDs: Map<string, unknown>;
      };
      expect(state.sessionRoutes.has("owner")).toBe(false);
      expect(state.deletedSessionIDs.has("owner")).toBe(true);
    } finally {
      await iterator.return?.();
      activation.cleanup();
    }
  });

  test("claims a duplicate durable event ID only once", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const event = {
      id: "durable-event-1",
      type: "session.execution.started",
      data: { sessionID: "owner", agent: "build" },
    };
    a.runtime.events = [event, event];
    b.runtime.events = [event, event];
    a.runtime.sessions.set("owner", {
      id: "owner",
      agent: "build",
      location: { directory: "/workspace" },
    });
    b.runtime.sessions = a.runtime.sessions;
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents.length + secondEvents.length).toBe(1);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("keeps reviews blocked after their owner activation cleans up", async () => {
    const a = makeRuntime("a");
    const b = makeRuntime("b");
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    const firstContext = first.createContext();
    try {
      const created = (await firstContext.session.create({
        agent: "spr",
        title: "skill-power-review",
      })) as { id: string };
      first.cleanup();
      b.runtime.events = [
        {
          id: "stale-review-event",
          type: "session.execution.succeeded",
          data: { sessionID: created.id, agent: "spr" },
        },
      ];
      expect(await collect(second.createContext().event.subscribe())).toEqual(
        [],
      );
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("bounds review ownership with fail-closed eviction", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    const context = activation.createContext();
    try {
      for (let index = 0; index < 1_025; index += 1)
        await context.session.create({ agent: "spr" });
      const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
        CORE_RUNTIME_STATE
      ] as {
        reviewOwners: Map<string, string>;
        blockedSessionIDs: Map<string, unknown>;
      };
      expect(state.reviewOwners.size).toBe(1_024);
      expect(state.blockedSessionIDs.has("review-a-1")).toBe(true);
    } finally {
      activation.cleanup();
    }
  });

  test("cleanup removes only undelivered event claims", () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
      CORE_RUNTIME_STATE
    ] as {
      eventClaims: Map<string, string>;
      deliveredEventIDs: Map<string, unknown>;
    };
    state.eventClaims.set("pending", activation.activationID);
    state.eventClaims.set("delivered", activation.activationID);
    state.deliveredEventIDs.set("delivered", undefined);

    activation.cleanup();

    expect(state.eventClaims.has("pending")).toBe(false);
    expect(state.eventClaims.get("delivered")).toBe(activation.activationID);
  });

  test("filters editor sessions for every activation", async () => {
    const editorRegistry: EditorSessionLookup = {
      isEditorSession: (sessionID) => sessionID === "editor",
    };
    const a = makeRuntime("a", editorRegistry);
    const b = makeRuntime("b");
    const events = [
      {
        type: "session.execution.succeeded",
        data: { sessionID: "editor", agent: "build" },
      },
    ];
    a.runtime.events = events;
    b.runtime.events = events;
    const first = registerCoreActivation(a.runtime, a.editorRegistry);
    const second = registerCoreActivation(b.runtime, b.editorRegistry);
    try {
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.createContext().event.subscribe()),
        collect(second.createContext().event.subscribe()),
      ]);
      expect(firstEvents).toHaveLength(0);
      expect(secondEvents).toHaveLength(0);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("accepts an array-shaped agent list response", async () => {
    const a = makeRuntime("a");
    a.runtime.agent!.list = async () => [
      { id: "build", mode: "primary", hidden: false },
    ];
    a.runtime.events = [
      {
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
    ];
    a.runtime.sessions.set("owner", { id: "owner", agent: "build" });
    const activation = registerCoreActivation(a.runtime, a.editorRegistry);
    try {
      expect(
        await collect(activation.createContext().event.subscribe()),
      ).toHaveLength(1);
    } finally {
      activation.cleanup();
    }
  });

  test("handoff-only mode does not observe normal owner sessions", async () => {
    const a = makeRuntime("a");
    a.runtime.events = [
      {
        id: "normal-owner-event",
        type: "session.execution.succeeded",
        data: { sessionID: "owner", agent: "build" },
      },
    ];
    a.runtime.sessions.set("owner", {
      id: "owner",
      agent: "build",
      location: { directory: "/workspace" },
    });
    const activation = registerCoreActivation(a.runtime, a.editorRegistry, {
      handoffOnly: true,
    });
    const context = activation.createContext();
    let contextCalls = 0;
    await context.session.hook("context", () => {
      contextCalls += 1;
    });
    const collected = collect(context.event.subscribe());

    try {
      const event: CoreContextEvent = {
        sessionID: "owner",
        agent: "build",
        messages: [{ type: "assistant", content: "private transcript" }],
        tools: { read: {} },
      };
      await dispatchContext(a.runtime, event);
      expect(contextCalls).toBe(0);
      expect(event.tools).toEqual({ read: {} });
    } finally {
      activation.cleanup();
    }
    expect(await collected).toEqual([]);
  });

  test("handoff-only mode emits a bounded virtual source", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry, {
      handoffOnly: true,
    });
    const context = activation.createContext();
    let captured: CoreContextEvent | undefined;
    await context.session.hook("context", (event) => {
      captured = event;
    });
    const iterator = context.event.subscribe()[Symbol.asyncIterator]();

    try {
      expect(
        await activation.enqueueHandoff({
          agent: "build",
          directory: "/workspace",
          workspaceID: "workspace-a",
          summary: "A concise verified workflow with reusable constraints.",
        }),
      ).toBe(true);
      expect(captured?.messages).toHaveLength(2);
      expect(JSON.stringify(captured?.messages)).not.toContain(
        "[skillforge:curate]",
      );
      expect(captured?.messages?.[1]).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "text",
            text: "A concise verified workflow with reusable constraints.",
          },
        ],
      });

      const started = (await iterator.next()).value as Record<string, any>;
      const succeeded = (await iterator.next()).value as Record<string, any>;
      expect(started.type).toBe("session.execution.started");
      expect(succeeded.type).toBe("session.execution.succeeded");
      expect(started.data.sessionID).toBe(succeeded.data.sessionID);
      expect(
        await context.session.get?.({ sessionID: started.data.sessionID }),
      ).toMatchObject({
        agent: "build",
        title: "skill-power-handoff",
        location: {
          directory: "/workspace",
          workspaceID: "workspace-a",
        },
      });

      expect(
        await activation.enqueueHandoff({
          agent: "build",
          directory: "/workspace",
          summary: "A later reusable procedure from the same owner session.",
        }),
      ).toBe(true);
      expect(captured?.messages).toHaveLength(2);
      const nextStarted = (await iterator.next()).value as Record<string, any>;
      const nextSucceeded = (await iterator.next()).value as Record<
        string,
        any
      >;
      expect(nextStarted.data.sessionID).not.toBe(started.data.sessionID);
      expect(nextSucceeded.data.sessionID).toBe(nextStarted.data.sessionID);
    } finally {
      await iterator.return?.();
      activation.cleanup();
    }
  });

  test("handoff enqueue fails if its activation closes during capture", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry, {
      handoffOnly: true,
    });
    const context = activation.createContext();
    await context.session.hook("context", () => activation.cleanup());

    expect(
      await activation.enqueueHandoff({
        agent: "build",
        directory: "/workspace",
        summary: "This handoff must not report a queued review.",
      }),
    ).toBe(false);
    expect(await collect(context.event.subscribe())).toEqual([]);
  });

  test("handoff-only mode hides owner tool results but keeps review tools", async () => {
    const a = makeRuntime("a");
    const activation = registerCoreActivation(a.runtime, a.editorRegistry, {
      handoffOnly: true,
    });
    const context = activation.createContext();
    let calls = 0;
    await context.tool?.hook?.("execute.after", () => {
      calls += 1;
    });

    try {
      await dispatchTool(a.runtime, {
        sessionID: "owner",
        agent: "build",
        tool: "shell",
        status: "completed",
        result: "private output",
      });
      expect(calls).toBe(0);

      const review = (await context.session.create({ agent: "spr" })) as {
        id: string;
      };
      await dispatchTool(a.runtime, {
        sessionID: review.id,
        agent: "spr",
        tool: "omni_skill_list",
        status: "completed",
      });
      expect(calls).toBe(1);
    } finally {
      activation.cleanup();
    }
  });

  test("fails closed when another module generation owns an incompatible protocol", async () => {
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previous = host[CORE_RUNTIME_STATE];
    host[CORE_RUNTIME_STATE] = { protocol: 999 };
    const a = makeRuntime("a");
    a.runtime.events = [
      {
        type: "session.execution.started",
        data: { sessionID: "owner", agent: "build" },
      },
    ];

    try {
      const activation = registerCoreActivation(a.runtime, a.editorRegistry);
      expect(activation.compatible).toBe(false);
      let calls = 0;
      const context = activation.createContext();
      await context.session.hook("context", () => {
        calls += 1;
      });
      await dispatchContext(a.runtime, {
        sessionID: "owner",
        agent: "build",
        tools: { read: {} },
      });
      expect(await collect(context.event.subscribe())).toEqual([]);
      expect(a.runtime.contextHooks).toHaveLength(0);
      expect(calls).toBe(0);
    } finally {
      host[CORE_RUNTIME_STATE] = previous;
    }
  });
});
