const CORE_RUNTIME_PROTOCOL = 4;
const CORE_RUNTIME_STATE = Symbol.for("opencode2-skill-forge.core-runtime");
const REVIEW_SESSION_TITLE = "skill-power-review";
const SPR_AGENT_IDS = new Set(["spr", "omni-spr"]);
const MAX_BLOCKED_SESSION_IDS = 256;
const MAX_DELETED_SESSION_IDS = 512;
const MAX_EVENT_CLAIMS = 2_048;
const MAX_SESSION_ROUTES = 4_096;
const MAX_REVIEW_OWNERS = 1_024;
const MAX_HANDOFF_SOURCES = 256;

export { CORE_RUNTIME_STATE };

export interface EditorSessionLookup {
  isEditorSession(sessionID: string): boolean;
}

export interface CoreRuntimeContext {
  options?: unknown;
  session: {
    create(input: Record<string, unknown>): Promise<unknown>;
    hook(
      name: "context",
      callback: (event: CoreContextEvent) => Promise<void> | void,
    ): Promise<unknown> | unknown;
    get?: (input: { sessionID: string }) => Promise<unknown>;
    [key: string]: unknown;
  };
  tool?: {
    hook?: (
      name: string,
      callback: (event: Record<string, unknown>) => Promise<void> | void,
    ) => Promise<unknown> | unknown;
    [key: string]: unknown;
  };
  event: {
    subscribe(input?: { signal?: AbortSignal }): AsyncIterable<unknown>;
    [key: string]: unknown;
  };
  agent?: {
    list?: (input?: Record<string, unknown>) => Promise<unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CoreContextEvent {
  sessionID?: unknown;
  agent?: unknown;
  parentID?: unknown;
  parent_id?: unknown;
  fork?: unknown;
  system?: unknown[];
  messages?: unknown[];
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CoreActivation<TContext extends CoreRuntimeContext> {
  activationID: string;
  compatible: boolean;
  createContext(options?: unknown): TContext;
  enqueueHandoff(input: CoreHandoffInput): Promise<boolean>;
  cleanup(): void;
  unregister(): void;
}

export interface CoreHandoffInput {
  agent: string;
  directory: string;
  workspaceID?: string;
  summary: string;
}

interface AgentInfo {
  id?: unknown;
  mode?: unknown;
  hidden?: unknown;
}

interface SessionInfo {
  agent?: unknown;
  title?: unknown;
  parentID?: unknown;
  parent_id?: unknown;
  fork?: unknown;
  location?: unknown;
}

interface LocationIdentity {
  directory: string;
  workspaceID?: string;
}

interface Activation {
  id: string;
  context: CoreRuntimeContext;
  editorRegistry: EditorSessionLookup;
  active: boolean;
  location?: LocationIdentity;
  agents?: AgentInfo[];
  metadata?: Promise<void>;
  handoffOnly: boolean;
  handoffEvents: AsyncEventQueue;
  contextHooks: Set<(event: CoreContextEvent) => Promise<void> | void>;
}

interface SessionRoute {
  activationID: string;
}

interface HandoffSource {
  activationID: string;
  info: SessionInfo & {
    id: string;
    agent: string;
    title: string;
    location: LocationIdentity;
  };
}

interface RouterState {
  protocol: number;
  nextActivationID: number;
  nextHandoffID: number;
  activations: Map<string, Activation>;
  sessionRoutes: Map<string, SessionRoute>;
  reviewOwners: Map<string, string>;
  blockedSessionIDs: Map<string, undefined>;
  deletedSessionIDs: Map<string, undefined>;
  eventClaims: Map<string, string>;
  deliveredEventIDs: Map<string, undefined>;
  handoffSources: Map<string, HandoffSource>;
}

export interface CoreActivationOptions {
  handoffOnly?: boolean;
}

class AsyncEventQueue implements AsyncIterable<unknown> {
  private values: unknown[] = [];
  private waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private closed = false;

  push(value: unknown): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined)
          return Promise.resolve({ value, done: false as const });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true as const });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouterState(value: unknown): value is RouterState {
  if (!isRecord(value) || value.protocol !== CORE_RUNTIME_PROTOCOL)
    return false;
  return (
    value.activations instanceof Map &&
    value.sessionRoutes instanceof Map &&
    value.reviewOwners instanceof Map &&
    value.blockedSessionIDs instanceof Map &&
    value.deletedSessionIDs instanceof Map &&
    value.eventClaims instanceof Map &&
    value.deliveredEventIDs instanceof Map &&
    value.handoffSources instanceof Map &&
    typeof value.nextActivationID === "number" &&
    typeof value.nextHandoffID === "number"
  );
}

function runtimeHost(): Record<symbol, unknown> {
  return globalThis as typeof globalThis & Record<symbol, unknown>;
}

function routerState(): RouterState | undefined {
  const host = runtimeHost();
  const current = host[CORE_RUNTIME_STATE];
  if (current === undefined) {
    const state: RouterState = {
      protocol: CORE_RUNTIME_PROTOCOL,
      nextActivationID: 1,
      nextHandoffID: 1,
      activations: new Map(),
      sessionRoutes: new Map(),
      reviewOwners: new Map(),
      blockedSessionIDs: new Map(),
      deletedSessionIDs: new Map(),
      eventClaims: new Map(),
      deliveredEventIDs: new Map(),
      handoffSources: new Map(),
    };
    host[CORE_RUNTIME_STATE] = state;
    return state;
  }
  return isRouterState(current) ? current : undefined;
}

function activeActivation(
  state: RouterState,
  activationID: string,
): Activation | undefined {
  const activation = state.activations.get(activationID);
  return activation?.active ? activation : undefined;
}

function sessionIDFromEvent(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const data = isRecord(raw.data) ? raw.data : undefined;
  const sessionID = data?.sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

function eventType(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.type === "string" ? raw.type : undefined;
}

function eventID(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
}

function eventData(raw: unknown): Record<string, unknown> | undefined {
  return isRecord(raw) && isRecord(raw.data) ? raw.data : undefined;
}

function locationFrom(value: unknown): LocationIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const location = isRecord(value.location) ? value.location : undefined;
  if (
    typeof location?.directory !== "string" ||
    location.directory.length === 0
  )
    return undefined;
  return {
    directory: location.directory,
    ...(typeof location.workspaceID === "string" && location.workspaceID
      ? { workspaceID: location.workspaceID }
      : {}),
  };
}

function sameLocation(
  left: LocationIdentity | undefined,
  right: LocationIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.directory === right.directory &&
    left.workspaceID === right.workspaceID
  );
}

function locationKey(location: LocationIdentity): string {
  return `${location.directory}\u0000${location.workspaceID ?? ""}`;
}

function hasDerivedMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.parentID !== undefined && value.parentID !== null) ||
    (value.parent_id !== undefined && value.parent_id !== null) ||
    (value.fork !== undefined && value.fork !== null && value.fork !== false)
  );
}

function isReviewDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (typeof value.agent === "string" && SPR_AGENT_IDS.has(value.agent)) ||
    value.title === REVIEW_SESSION_TITLE
  );
}

function isReviewCreate(input: Record<string, unknown>): boolean {
  return (
    (typeof input.agent === "string" && SPR_AGENT_IDS.has(input.agent)) ||
    input.title === REVIEW_SESSION_TITLE
  );
}

function rememberBounded<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  maxSize: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== "string") return;
    map.delete(oldest);
  }
}

function rememberBlockedSession(state: RouterState, sessionID: string): void {
  rememberBounded(
    state.blockedSessionIDs,
    sessionID,
    undefined,
    MAX_BLOCKED_SESSION_IDS,
  );
}

function rememberDeletedSession(state: RouterState, sessionID: string): void {
  rememberBounded(
    state.deletedSessionIDs,
    sessionID,
    undefined,
    MAX_DELETED_SESSION_IDS,
  );
}

function isEditorSession(state: RouterState, sessionID: string): boolean {
  for (const activation of state.activations.values()) {
    if (!activation.active) continue;
    try {
      if (activation.editorRegistry.isEditorSession(sessionID)) return true;
    } catch {
      // A failed editor lookup must not expose its hidden session to the core.
      return true;
    }
  }
  return false;
}

function agentsFromResponse(response: unknown): AgentInfo[] | undefined {
  const items = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.data)
      ? response.data
      : undefined;
  if (!items) return undefined;
  return items.filter(isRecord);
}

async function loadActivationMetadata(activation: Activation): Promise<void> {
  const list = activation.context.agent?.list;
  if (typeof list !== "function") return;
  try {
    const response = await list.call(activation.context.agent);
    if (!activation.active) return;
    activation.agents = agentsFromResponse(response);
    activation.location = locationFrom(response);
  } catch {
    // Unknown activation scope and agents fail closed below.
  }
}

async function ensureActivationMetadata(activation: Activation): Promise<void> {
  activation.metadata ??= loadActivationMetadata(activation);
  await activation.metadata;
}

async function isCoreEligibleAgent(
  activation: Activation,
  agentID: string,
): Promise<boolean> {
  await ensureActivationMetadata(activation);
  const agent = activation.agents?.find(
    (candidate) => candidate.id === agentID,
  );
  return (
    agent !== undefined && agent.hidden !== true && agent.mode !== "subagent"
  );
}

async function sessionInfo(
  activation: Activation,
  sessionID: string,
): Promise<SessionInfo | undefined> {
  const get = activation.context.session.get;
  if (typeof get !== "function") return undefined;
  try {
    const result = await get.call(activation.context.session, { sessionID });
    if (!isRecord(result)) return undefined;
    return isRecord(result.data) ? result.data : result;
  } catch {
    return undefined;
  }
}

async function sessionIsEligible(
  state: RouterState,
  sessionID: string,
  activation: Activation,
  details: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (details && hasDerivedMarker(details)) {
    rememberBlockedSession(state, sessionID);
    return false;
  }
  if (details && isReviewDetails(details)) {
    rememberBlockedSession(state, sessionID);
    return false;
  }

  const info = await sessionInfo(activation, sessionID);
  if (!info || hasDerivedMarker(info) || isReviewDetails(info)) {
    if (info && (hasDerivedMarker(info) || isReviewDetails(info)))
      rememberBlockedSession(state, sessionID);
    return false;
  }

  const agentID =
    typeof details?.agent === "string"
      ? details.agent
      : typeof info.agent === "string"
        ? info.agent
        : undefined;
  if (!agentID || SPR_AGENT_IDS.has(agentID)) return false;
  return isCoreEligibleAgent(activation, agentID);
}

async function activationForLocation(
  state: RouterState,
  location: LocationIdentity | undefined,
  eligible: (activation: Activation) => boolean = () => true,
): Promise<Activation | undefined> {
  const active = [...state.activations.values()].filter(
    (activation) => activation.active && eligible(activation),
  );
  await Promise.all(active.map(ensureActivationMetadata));
  if (location) {
    const matches = active.filter((activation) =>
      sameLocation(activation.location, location),
    );
    if (matches.length > 0) return matches[0];
    // Servers may tag events with the session's project directory while the
    // activation registered the service-wide directory (or vice versa). An
    // unmatched location must fall through to the shared fallback below
    // instead of dropping the event: with one active activation, that lone
    // instance owns every otherwise-unclaimed location. Multi-activation
    // setups stay fail-closed unless exactly one known location exists.
  }
  const knownLocations = new Set(
    active
      .map((activation) => activation.location)
      .filter((item): item is LocationIdentity => item !== undefined)
      .map(locationKey),
  );
  if (
    knownLocations.size === 1 &&
    active.every((activation) => activation.location !== undefined)
  )
    return active[0];
  return active.length === 1 ? active[0] : undefined;
}

async function sessionLocation(
  state: RouterState,
  sessionID: string,
  details: Record<string, unknown> | undefined,
  eventLocation?: LocationIdentity,
): Promise<LocationIdentity | undefined> {
  const direct = locationFrom(details) ?? eventLocation;
  if (direct) return direct;
  for (const activation of state.activations.values()) {
    if (!activation.active) continue;
    const info = await sessionInfo(activation, sessionID);
    const location = locationFrom(info);
    if (location) return location;
  }
  return undefined;
}

function rememberSessionRoute(
  state: RouterState,
  sessionID: string,
  activationID: string,
): void {
  rememberBounded(
    state.sessionRoutes,
    sessionID,
    { activationID },
    MAX_SESSION_ROUTES,
  );
}

function rememberReviewOwner(
  state: RouterState,
  sessionID: string,
  activationID: string,
): void {
  state.reviewOwners.delete(sessionID);
  state.reviewOwners.set(sessionID, activationID);
  while (state.reviewOwners.size > MAX_REVIEW_OWNERS) {
    const oldest = state.reviewOwners.keys().next().value;
    if (typeof oldest !== "string") return;
    state.reviewOwners.delete(oldest);
    rememberBlockedSession(state, oldest);
  }
}

async function routeNormalSession(
  state: RouterState,
  sessionID: string,
  details: Record<string, unknown> | undefined,
  eventLocation?: LocationIdentity,
  forceReroute = false,
): Promise<string | undefined> {
  if (forceReroute) state.sessionRoutes.delete(sessionID);
  const existing = state.sessionRoutes.get(sessionID);
  if (existing) {
    const owner = activeActivation(state, existing.activationID);
    if (owner) {
      if (details && hasDerivedMarker(details)) {
        state.sessionRoutes.delete(sessionID);
        rememberBlockedSession(state, sessionID);
        return undefined;
      }
      if (details && isReviewDetails(details)) {
        state.sessionRoutes.delete(sessionID);
        rememberBlockedSession(state, sessionID);
        return undefined;
      }
      if (
        typeof details?.agent === "string" &&
        !(await isCoreEligibleAgent(owner, details.agent))
      ) {
        state.sessionRoutes.delete(sessionID);
        rememberBlockedSession(state, sessionID);
        return undefined;
      }
      return existing.activationID;
    }
  }
  if (existing) state.sessionRoutes.delete(sessionID);
  if (
    state.blockedSessionIDs.has(sessionID) ||
    state.deletedSessionIDs.has(sessionID)
  )
    return undefined;

  const location = await sessionLocation(
    state,
    sessionID,
    details,
    eventLocation,
  );
  const normalActivation = (activation: Activation) => !activation.handoffOnly;
  const candidate = await activationForLocation(
    state,
    location,
    normalActivation,
  );
  if (
    !candidate ||
    !(await sessionIsEligible(state, sessionID, candidate, details))
  )
    return undefined;

  const afterLookup = state.sessionRoutes.get(sessionID);
  if (afterLookup && activeActivation(state, afterLookup.activationID))
    return afterLookup.activationID;

  const owner = await activationForLocation(state, location, normalActivation);
  if (!owner) return undefined;
  rememberSessionRoute(state, sessionID, owner.id);
  return owner.id;
}

async function eventOwner(
  state: RouterState,
  sessionID: string,
  raw: unknown,
): Promise<string | undefined> {
  if (isEditorSession(state, sessionID)) return undefined;

  const handoffSource = state.handoffSources.get(sessionID);
  if (handoffSource)
    return activeActivation(state, handoffSource.activationID)
      ? handoffSource.activationID
      : undefined;
  const reviewOwner = state.reviewOwners.get(sessionID);
  if (reviewOwner)
    return activeActivation(state, reviewOwner) ? reviewOwner : undefined;
  if (
    state.blockedSessionIDs.has(sessionID) ||
    state.deletedSessionIDs.has(sessionID)
  )
    return undefined;
  return routeNormalSession(
    state,
    sessionID,
    eventData(raw),
    locationFrom(raw),
    eventType(raw) === "session.moved",
  );
}

async function contextOwner(
  state: RouterState,
  sessionID: string,
  event: CoreContextEvent,
): Promise<string | undefined> {
  if (
    isEditorSession(state, sessionID) ||
    state.deletedSessionIDs.has(sessionID)
  )
    return undefined;
  const handoffSource = state.handoffSources.get(sessionID);
  if (handoffSource)
    return activeActivation(state, handoffSource.activationID)
      ? handoffSource.activationID
      : undefined;
  if (hasDerivedMarker(event)) {
    state.sessionRoutes.delete(sessionID);
    rememberBlockedSession(state, sessionID);
    return undefined;
  }

  const reviewOwner = state.reviewOwners.get(sessionID);
  if (reviewOwner)
    return activeActivation(state, reviewOwner) ? reviewOwner : undefined;
  if (
    (typeof event.agent === "string" && SPR_AGENT_IDS.has(event.agent)) ||
    state.blockedSessionIDs.has(sessionID)
  ) {
    rememberBlockedSession(state, sessionID);
    return undefined;
  }

  const existing = state.sessionRoutes.get(sessionID);
  if (existing && activeActivation(state, existing.activationID)) {
    if (typeof event.agent !== "string") return undefined;
    const candidate = activeActivation(state, existing.activationID);
    if (candidate && (await isCoreEligibleAgent(candidate, event.agent)))
      return existing.activationID;
    state.sessionRoutes.delete(sessionID);
    rememberBlockedSession(state, sessionID);
    return undefined;
  }
  if (existing) state.sessionRoutes.delete(sessionID);

  return routeNormalSession(state, sessionID, event);
}

function cleanupDeliveredSession(
  state: RouterState,
  activationID: string,
  sessionID: string,
): void {
  const wasReview = state.reviewOwners.get(sessionID) === activationID;
  if (wasReview) state.reviewOwners.delete(sessionID);
  if (state.sessionRoutes.get(sessionID)?.activationID === activationID)
    state.sessionRoutes.delete(sessionID);
  if (wasReview) rememberBlockedSession(state, sessionID);
  rememberDeletedSession(state, sessionID);
}

async function claimedEventOwner(
  state: RouterState,
  sessionID: string,
  raw: unknown,
): Promise<string | undefined> {
  const id = eventID(raw);
  const claimed = id ? state.eventClaims.get(id) : undefined;
  if (claimed) return activeActivation(state, claimed) ? claimed : undefined;

  const owner = await eventOwner(state, sessionID, raw);
  if (!owner || !id) return owner;

  const afterLookup = state.eventClaims.get(id);
  if (afterLookup)
    return activeActivation(state, afterLookup) ? afterLookup : undefined;
  rememberBounded(state.eventClaims, id, owner, MAX_EVENT_CLAIMS);
  return owner;
}

async function* routedEvents(
  state: RouterState,
  activationID: string,
  source: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  for await (const raw of source) {
    if (!activeActivation(state, activationID)) return;
    const sessionID = sessionIDFromEvent(raw);
    if (
      !sessionID ||
      (await claimedEventOwner(state, sessionID, raw)) !== activationID
    )
      continue;
    if (!activeActivation(state, activationID)) return;
    const id = eventID(raw);
    if (id && state.deliveredEventIDs.has(id)) continue;
    if (id)
      rememberBounded(state.deliveredEventIDs, id, undefined, MAX_EVENT_CLAIMS);

    if (eventType(raw) === "session.deleted")
      cleanupDeliveredSession(state, activationID, sessionID);
    yield raw;
  }
}

function emptyEvents(): AsyncIterable<unknown> {
  return (async function* () {})();
}

async function* mergeEvents(
  left: AsyncIterable<unknown>,
  right: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  const iterators = [
    left[Symbol.asyncIterator](),
    right[Symbol.asyncIterator](),
  ];
  const pending = new Map<
    number,
    Promise<{ index: number; result: IteratorResult<unknown> }>
  >();
  const schedule = (index: number) => {
    pending.set(
      index,
      iterators[index]!.next().then((result) => ({ index, result })),
    );
  };
  schedule(0);
  schedule(1);
  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);
      if (result.done) continue;
      schedule(index);
      yield result.value;
    }
  } finally {
    await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
  }
}

function rememberHandoffSource(
  state: RouterState,
  sessionID: string,
  source: HandoffSource,
): void {
  state.handoffSources.delete(sessionID);
  state.handoffSources.set(sessionID, source);
  while (state.handoffSources.size > MAX_HANDOFF_SOURCES) {
    const oldest = state.handoffSources.keys().next().value;
    if (typeof oldest !== "string") return;
    state.handoffSources.delete(oldest);
    rememberBlockedSession(state, oldest);
  }
}

async function enqueueHandoff(
  state: RouterState,
  activationID: string,
  input: CoreHandoffInput,
): Promise<boolean> {
  const activation = activeActivation(state, activationID);
  const summary = input.summary.trim();
  if (!activation?.handoffOnly || !summary || !input.directory) return false;

  const sequence = state.nextHandoffID++;
  const id = `spr-handoff-${Date.now().toString(36)}-${sequence}`;
  const now = Date.now();
  const location: LocationIdentity = {
    directory: input.directory,
    ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
  };
  rememberHandoffSource(state, id, {
    activationID,
    info: {
      id,
      agent: input.agent,
      title: "skill-power-handoff",
      location,
    },
  });

  const contextEvent: CoreContextEvent = {
    sessionID: id,
    agent: input.agent,
    system: [],
    tools: {},
    messages: [
      {
        id: `${id}-request`,
        type: "user",
        text: "Review only the bounded handoff below. No source conversation, hidden reasoning, or raw tool output was provided.",
        time: { created: now },
      },
      {
        id: `${id}-result`,
        type: "assistant",
        agent: input.agent,
        time: { created: now, completed: now },
        content: [{ type: "text", text: summary }],
      },
    ],
  };
  try {
    for (const callback of activation.contextHooks)
      await callback(contextEvent);
  } catch {
    state.handoffSources.delete(id);
    return false;
  }

  if (activeActivation(state, activationID) !== activation) {
    state.handoffSources.delete(id);
    return false;
  }

  activation.handoffEvents.push({
    id: `${id}-started`,
    type: "session.execution.started",
    location,
    data: { sessionID: id, agent: input.agent },
  });
  activation.handoffEvents.push({
    id: `${id}-succeeded`,
    type: "session.execution.succeeded",
    location,
    data: { sessionID: id, agent: input.agent },
  });
  return true;
}

/**
 * Wrap one core setup so its hooks and event stream can only observe sessions
 * assigned to this activation. State intentionally lives under Symbol.for so
 * hot-reloaded module generations share the same routing table.
 */
export function registerCoreActivation<TContext extends CoreRuntimeContext>(
  context: TContext,
  editorRegistry: EditorSessionLookup,
  options: CoreActivationOptions = {},
): CoreActivation<TContext> {
  const state = routerState();
  if (!state) {
    const activationID = "core-runtime-protocol-mismatch";
    return {
      activationID,
      compatible: false,
      createContext(options = context.options): TContext {
        return createBlockedContext(context, options);
      },
      enqueueHandoff: async () => false,
      cleanup() {},
      unregister() {},
    };
  }

  const activationID = `core-runtime-${state.nextActivationID++}`;
  const activation: Activation = {
    id: activationID,
    context,
    editorRegistry,
    active: true,
    handoffOnly: options.handoffOnly === true,
    handoffEvents: new AsyncEventQueue(),
    contextHooks: new Set(),
  };
  state.activations.set(activationID, activation);
  activation.metadata = loadActivationMetadata(activation);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activation.active = false;
    activation.handoffEvents.close();
    activation.contextHooks.clear();
    state.activations.delete(activationID);
    for (const [sessionID, route] of state.sessionRoutes) {
      if (route.activationID === activationID)
        state.sessionRoutes.delete(sessionID);
    }
    for (const [reviewID, ownerID] of state.reviewOwners) {
      if (ownerID !== activationID) continue;
      state.reviewOwners.delete(reviewID);
      rememberBlockedSession(state, reviewID);
    }
    for (const [sourceID, source] of state.handoffSources) {
      if (source.activationID !== activationID) continue;
      state.handoffSources.delete(sourceID);
      rememberBlockedSession(state, sourceID);
    }
    for (const [claimedEventID, ownerID] of state.eventClaims) {
      if (
        ownerID === activationID &&
        !state.deliveredEventIDs.has(claimedEventID)
      )
        state.eventClaims.delete(claimedEventID);
    }
  };

  return {
    activationID,
    compatible: true,
    createContext(options = context.options): TContext {
      return createRoutedContext(context, state, activationID, options);
    },
    enqueueHandoff: (input) => enqueueHandoff(state, activationID, input),
    cleanup,
    unregister: cleanup,
  };
}

function createBlockedContext<TContext extends CoreRuntimeContext>(
  context: TContext,
  options: unknown,
): TContext {
  const session = {
    ...context.session,
    hook: async () => undefined,
  };
  const event = {
    ...context.event,
    subscribe: () => emptyEvents(),
  };
  const tool = context.tool
    ? { ...context.tool, hook: async () => undefined }
    : undefined;
  return {
    ...context,
    options,
    session,
    event,
    ...(tool ? { tool } : {}),
  } as TContext;
}

function createRoutedContext<TContext extends CoreRuntimeContext>(
  context: TContext,
  state: RouterState,
  activationID: string,
  options: unknown,
): TContext {
  const originalSession = context.session;
  const originalEvent = context.event;
  const activation = activeActivation(state, activationID);
  const session = {
    ...originalSession,
    create: async (input: Record<string, unknown>) => {
      const created = await originalSession.create.call(originalSession, input);
      if (
        !isReviewCreate(input) ||
        !activeActivation(state, activationID) ||
        !isRecord(created)
      )
        return created;
      if (typeof created.id === "string") {
        rememberReviewOwner(state, created.id, activationID);
        state.blockedSessionIDs.delete(created.id);
      }
      return created;
    },
    get: async (input: { sessionID: string }) => {
      const source = state.handoffSources.get(input.sessionID);
      if (source?.activationID === activationID) return source.info;
      const get = originalSession.get;
      return typeof get === "function"
        ? get.call(originalSession, input)
        : undefined;
    },
    hook: (
      name: "context",
      callback: (event: CoreContextEvent) => Promise<void> | void,
    ) => {
      activation?.contextHooks.add(callback);
      return originalSession.hook.call(
        originalSession,
        name,
        async (event: CoreContextEvent) => {
          const sessionID =
            typeof event?.sessionID === "string" ? event.sessionID : undefined;
          if (!sessionID || !activeActivation(state, activationID)) return;
          if ((await contextOwner(state, sessionID, event)) !== activationID)
            return;
          if (!activeActivation(state, activationID)) return;
          await callback(event);
        },
      );
    },
  };
  const event = {
    ...originalEvent,
    subscribe: (input?: { signal?: AbortSignal }) => {
      const active = activeActivation(state, activationID);
      if (!active) return emptyEvents();
      const routed = routedEvents(
        state,
        activationID,
        originalEvent.subscribe.call(originalEvent, input),
      );
      return active.handoffOnly
        ? mergeEvents(routed, active.handoffEvents)
        : routed;
    },
  };
  const originalTool = context.tool;
  const tool = originalTool
    ? {
        ...originalTool,
        hook:
          typeof originalTool.hook === "function"
            ? (
                name: string,
                callback: (
                  event: Record<string, unknown>,
                ) => Promise<void> | void,
              ) =>
                originalTool.hook!.call(
                  originalTool,
                  name,
                  async (event: Record<string, unknown>) => {
                    const current = activeActivation(state, activationID);
                    if (!current) return;
                    if (!current.handoffOnly) {
                      await callback(event);
                      return;
                    }
                    const sessionID = event.sessionID;
                    if (typeof sessionID !== "string") return;
                    const source = state.handoffSources.get(sessionID);
                    const reviewOwner = state.reviewOwners.get(sessionID);
                    if (
                      source?.activationID !== activationID &&
                      reviewOwner !== activationID
                    )
                      return;
                    await callback(event);
                  },
                )
            : undefined,
      }
    : undefined;
  return {
    ...context,
    options,
    session,
    event,
    ...(tool ? { tool } : {}),
  } as TContext;
}
