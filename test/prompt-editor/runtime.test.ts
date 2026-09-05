import { afterEach, expect, test } from "bun:test";
import type { ContextHookController } from "../legacy-runtime/prompt-editor/context-hook.js";
import type { PromptEditorRequest } from "../legacy-runtime/prompt-editor/live.js";
import {
  beginPromptEditorActivation,
  PROMPT_EDITOR_RUNTIME_STATE,
} from "../legacy-runtime/prompt-editor/runtime.js";

function registerPromptEditorController(controller: ContextHookController) {
  const bootstrap = beginPromptEditorActivation();
  return bootstrap?.attach(controller) ?? null;
}

afterEach(() => {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    PROMPT_EDITOR_RUNTIME_STATE
  ];
});

function controller(owns: boolean, handled: string[]): ContextHookController {
  return {
    ownsRequest: () => owns,
    processRequest: async (request) => {
      handled.push(request.gateID);
      return true;
    },
    cancelSession: () => undefined,
    cancelAll: () => undefined,
    stop: async () => undefined,
  };
}

const request: PromptEditorRequest = {
  protocolVersion: 2,
  kind: "accept",
  sessionID: "ses_1",
  messageID: "msg_1",
  gateID: "gate-owner-1",
  revision: 1,
  ts: 1,
};

test("one process runtime routes a decision only to its owning activation", async () => {
  const handled: string[] = [];
  const nonOwner = registerPromptEditorController(controller(false, handled));
  const owner = registerPromptEditorController(controller(true, handled));
  expect(nonOwner).not.toBeNull();
  expect(owner).not.toBeNull();
  await nonOwner!.route(request);
  expect(handled).toEqual(["gate-owner-1"]);
  await nonOwner!.release();
  await owner!.release();
});

test("orphan sweep and request poller are process-global across activations", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  const second = registerPromptEditorController(controller(false, []))!;
  expect(first.claimOrphanSweep()).toBe(true);
  expect(second.claimOrphanSweep()).toBe(false);
  let starts = 0;
  let stops = 0;
  const create = () => {
    starts += 1;
    return {
      poll: async () => undefined,
      stop: async () => {
        stops += 1;
      },
    };
  };
  await first.ensurePoller(create);
  await second.ensurePoller(create);
  expect(starts).toBe(1);
  await first.release();
  expect(stops).toBe(0);
  await second.release();
  expect(stops).toBe(1);
});

test("bootstrap keeps no-owner requests pending until a controller attaches", async () => {
  const handled: string[] = [];
  const existing = registerPromptEditorController(controller(false, handled))!;
  const bootstrap = beginPromptEditorActivation()!;
  await expect(existing.route(request)).rejects.toThrow("still bootstrapping");
  const owner = bootstrap.attach(controller(true, handled));
  await existing.route(request);
  expect(handled).toEqual(["gate-owner-1"]);
  await existing.release();
  await owner.release();
});

test("overlapping teardown and startup cannot reclaim the orphan sweep", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  expect(first.claimOrphanSweep()).toBe(true);
  let stopStarted!: () => void;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  await first.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => {
      stopStarted();
      await stopGate;
    },
  }));

  const releasing = first.release();
  await stopping;
  const replacement = registerPromptEditorController(controller(false, []))!;
  const replacementPoller = replacement.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => undefined,
  }));
  finishStop();
  await releasing;
  await replacementPoller;

  expect(replacement.claimOrphanSweep()).toBe(false);
  await replacement.release();
});

test("replacement poller starts only after the old in-flight tail stops", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  let stopStarted!: () => void;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  let pollerCreates = 0;
  await first.ensurePoller(() => {
    pollerCreates += 1;
    return {
      poll: async () => undefined,
      stop: async () => {
        stopStarted();
        await stopGate;
      },
    };
  });

  const releasing = first.release();
  await stopping;
  const replacement = registerPromptEditorController(controller(false, []))!;
  const replacementPoller = replacement.ensurePoller(() => {
    pollerCreates += 1;
    return {
      poll: async () => undefined,
      stop: async () => undefined,
    };
  });
  expect(pollerCreates).toBe(1);
  finishStop();
  await releasing;
  await replacementPoller;
  expect(pollerCreates).toBe(2);
  await replacement.release();
});

test("a pending activation preserves orphan-sweep ownership", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  expect(first.claimOrphanSweep()).toBe(true);
  const pending = beginPromptEditorActivation()!;
  await first.release();
  const replacement = pending.attach(controller(false, []));
  expect(replacement.claimOrphanSweep()).toBe(false);
  await replacement.release();
});

test("aborting the last pending activation releases an idle sweep claim", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  expect(first.claimOrphanSweep()).toBe(true);
  const pending = beginPromptEditorActivation()!;
  await first.release();
  pending.abort();
  const replacement = registerPromptEditorController(controller(false, []))!;
  expect(replacement.claimOrphanSweep()).toBe(true);
  await replacement.release();
});

test("release is idempotent and stale requests return normally", async () => {
  let stops = 0;
  const registration = registerPromptEditorController(controller(false, []))!;
  await registration.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => {
      stops += 1;
    },
  }));
  await Promise.all([registration.release(), registration.release()]);
  await expect(registration.route(request)).resolves.toBeUndefined();
  expect(stops).toBe(1);
});

test("stop failures reset idle state and allow a later poller", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  expect(first.claimOrphanSweep()).toBe(true);
  await first.ensurePoller(() => ({
    poll: async () => undefined,
    stop: () => {
      throw new Error("stop failed");
    },
  }));
  await expect(first.release()).rejects.toThrow("stop failed");

  const replacement = registerPromptEditorController(controller(false, []))!;
  expect(replacement.claimOrphanSweep()).toBe(true);
  let created = false;
  await replacement.ensurePoller(() => {
    created = true;
    return {
      poll: async () => undefined,
      stop: async () => undefined,
    };
  });
  expect(created).toBe(true);
  await replacement.release();
});

test("an async undefined stop rejection is reported while handoff recovers", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  let stopStarted!: () => void;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  await first.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => {
      stopStarted();
      await stopGate;
      throw undefined;
    },
  }));
  const releasing = first.release();
  const releaseResult = releasing.then(
    () => ({ rejected: false, error: undefined }),
    (error: unknown) => ({ rejected: true, error }),
  );
  await stopping;

  const replacement = registerPromptEditorController(controller(false, []))!;
  let created = false;
  const ensuring = replacement.ensurePoller(() => {
    created = true;
    return {
      poll: async () => undefined,
      stop: async () => undefined,
    };
  });
  finishStop();
  expect(await releaseResult).toEqual({ rejected: true, error: undefined });
  await ensuring;
  expect(created).toBe(true);
  await replacement.release();
});

test("a deferred poller factory failure is observable and retryable", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  let stopStarted!: () => void;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  await first.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => {
      stopStarted();
      await stopGate;
    },
  }));
  const releasing = first.release();
  await stopping;

  const replacement = registerPromptEditorController(controller(false, []))!;
  const failed = replacement.ensurePoller(() => {
    throw new Error("create failed");
  });
  finishStop();
  await releasing;
  await expect(failed).rejects.toThrow("create failed");
  await replacement.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => undefined,
  }));
  await replacement.release();
});

test("a released replacement never creates a deferred poller", async () => {
  const first = registerPromptEditorController(controller(false, []))!;
  let stopStarted!: () => void;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  await first.ensurePoller(() => ({
    poll: async () => undefined,
    stop: async () => {
      stopStarted();
      await stopGate;
    },
  }));
  const releasing = first.release();
  await stopping;
  const replacement = registerPromptEditorController(controller(false, []))!;
  let created = false;
  const ensuring = replacement.ensurePoller(() => {
    created = true;
    return {
      poll: async () => undefined,
      stop: async () => undefined,
    };
  });
  await replacement.release();
  finishStop();
  await releasing;
  await ensuring;
  expect(created).toBe(false);
});
