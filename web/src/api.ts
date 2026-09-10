let csrf = "";
let activeTenant = "";
/** Bind API calls to the tenant visible on this screen (issue #3): the shared
 * forge_tenant cookie can flip when another tab switches organization, so a
 * write from a stale tab must keep its own explicit scope. */
export function setActiveTenant(tenantId: string) {
  activeTenant = tenantId;
}
/** Tenant currently bound to the visible screen (issue #22). */
export function activeTenantValue() {
  return activeTenant;
}
/** Adopt a CSRF token delivered by a session-only recovery endpoint. */
export function setCsrfToken(value: string) {
  csrf = value;
}

/** Issue #22: a tenant transition is one coordinated operation. The screen
 * context only moves when the transition commits; until then ordinary
 * mutations are refused so a stale form can never write to another tenant. */
let transitionGeneration = 0;
let transitionPending = false;
export function beginTenantTransition(): number {
  transitionGeneration += 1;
  transitionPending = true;
  return transitionGeneration;
}
export function currentTenantTransition(): number {
  return transitionGeneration;
}
export function tenantTransitionPending(): boolean {
  return transitionPending;
}
/** Commit or abandon one transition generation. Superseded generations are
 * ignored so out-of-order completions cannot roll the screen back. */
export function settleTenantTransition(
  generation: number,
  committedTenant?: string,
): boolean {
  if (generation !== transitionGeneration) return false;
  transitionPending = false;
  if (committedTenant !== undefined) activeTenant = committedTenant;
  return true;
}

/** Shared header policy: CSRF plus the explicit screen tenant for API calls.
 * `tenant` overrides the screen context for the transition's own requests. */
export function apiHeaders(
  path: string,
  extra: Record<string, string> = {},
  tenant?: string,
): Record<string, string> {
  const scoped = tenant ?? activeTenant;
  return {
    ...(csrf ? { "x-forge-csrf": csrf } : {}),
    ...(scoped && path.startsWith("/api/") ? { "x-forge-tenant": scoped } : {}),
    ...extra,
  };
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
/** Extract the stable server error code for dictionary rendering. */
export function errorCode(error: unknown): string {
  return error instanceof ApiError && error.code ? error.code : "unknown";
}
export interface ApiOptions {
  /** Explicit tenant for transition requests (switch, target account read). */
  tenant?: string;
}
export function isMutationMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
export async function api<T>(
  path: string,
  init: RequestInit = {},
  options: ApiOptions = {},
): Promise<T> {
  if (
    transitionPending &&
    options.tenant === undefined &&
    isMutationMethod(init.method ?? "GET")
  )
    throw new ApiError(
      "Organizasyon geçişi tamamlanıyor; işlemi yeni bağlamda yeniden deneyin.",
      409,
      "tenant_switch_pending",
    );
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: apiHeaders(
      path,
      {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      options.tenant,
    ),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.message ?? value.error?.code ?? "unknown",
      response.status,
      value.error?.code,
    );
  if (value.csrf) csrf = value.csrf;
  return value as T;
}
export type Project = { id: string; name: string };
export type Account = {
  role: "founder" | "admin" | "writer" | "reader" | "auditor";
  identity: { userId: string; tenantId: string };
  projects: Project[];
  csrf: string;
};

export interface PageLike<T> {
  items: T[];
  next?: string | null;
}
export interface PageSnapshot<T> {
  items: T[];
  next: string | null;
  pages: number;
}
export interface PageWalkOptions<T> {
  /** Hard page bound; when it is reached with a cursor left the walk is
   * reported as `incomplete` instead of hiding the missing rows. */
  maxPages?: number;
  /** Explicit tenant for every page request (transition-owned walks). */
  tenant?: string;
  isCancelled?: () => boolean;
  keyOf?: (item: T) => string;
  /** Return true when `next` moves strictly forward in iteration order.
   * Used to catch a regressing cursor as well as an exact repeat. */
  cursorOrder?: (previous: string, next: string) => boolean;
  onPage?: (snapshot: PageSnapshot<T>) => void;
  /** Injectable fetch for tests; defaults to the `after` continuation API. */
  fetchPage?: (cursor: string) => Promise<PageLike<T>>;
  /** Shared cursor memory so several walk calls cannot loop. */
  seenCursors?: Set<string>;
}
export interface PageWalkResult<T> {
  items: T[];
  next: string | null;
  pages: number;
  /** Stopped at `maxPages` while the server still offers `next`. */
  incomplete: boolean;
  cancelled: boolean;
  repeatedCursor: boolean;
  error: unknown;
}

/** Stable identity for keyset deduplication. */
export function pageItemKey(item: unknown): string {
  return typeof item === "object" && item !== null && "id" in item
    ? String((item as { id: unknown }).id)
    : JSON.stringify(item);
}

async function fetchContinuationPage<T>(
  path: string,
  cursor: string,
  tenant?: string,
): Promise<PageLike<T>> {
  const separator = path.includes("?") ? "&" : "?";
  return api<PageLike<T>>(
    `${path}${separator}after=${encodeURIComponent(cursor)}`,
    {},
    tenant === undefined ? {} : { tenant },
  );
}

/** Issue #29: shared keyset walker. It detects repeated/regressing cursors,
 * deduplicates rows, preserves already-collected pages on error, reports an
 * explicit incomplete state at the page bound, and aborts cleanly when the
 * caller's generation is cancelled. */
export async function walkPages<T>(
  path: string,
  start: PageLike<T>,
  options: PageWalkOptions<T> = {},
): Promise<PageWalkResult<T>> {
  const maxPages = options.maxPages ?? 50;
  const keyOf = options.keyOf ?? pageItemKey;
  const isCancelled = options.isCancelled ?? (() => false);
  const seenCursors = options.seenCursors ?? new Set<string>();
  const seenKeys = new Set<string>((start.items ?? []).map(keyOf));
  const items = [...(start.items ?? [])];
  let next = start.next ?? null;
  let previous: string | null = null;
  let pages = 0;
  let incomplete = false;
  let cancelled = false;
  let repeatedCursor = false;
  let error: unknown = null;
  while (next && pages < maxPages) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const cursor = next;
    const regressed =
      previous !== null &&
      options.cursorOrder !== undefined &&
      !options.cursorOrder(previous, cursor);
    if (seenCursors.has(cursor) || regressed) {
      repeatedCursor = seenCursors.has(cursor);
      error = new ApiError(
        "Sayfa anahtarı ilerlemiyor.",
        409,
        "invalid_cursor",
      );
      break;
    }
    seenCursors.add(cursor);
    let page: PageLike<T>;
    try {
      page = options.fetchPage
        ? await options.fetchPage(cursor)
        : await fetchContinuationPage<T>(path, cursor, options.tenant);
    } catch (caught) {
      error = caught;
      break;
    }
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    for (const item of page.items ?? []) {
      const key = keyOf(item);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        items.push(item);
      }
    }
    previous = cursor;
    next = page.next ?? null;
    pages += 1;
    options.onPage?.({ items, next, pages });
  }
  if (!cancelled && next !== null && pages >= maxPages) incomplete = true;
  return {
    items,
    next,
    pages,
    incomplete,
    cancelled,
    repeatedCursor,
    error,
  };
}

/** Keyset cursor order for endpoints whose page direction is known. */
export function cursorOrderFor(
  path: string,
): ((previous: string, next: string) => boolean) | undefined {
  if (path.startsWith("/api/installations") || path.startsWith("/api/projects"))
    return (previous, next) => next > previous;
  if (path.startsWith("/api/logs") || path.includes("/revisions"))
    return (previous, next) => next < previous;
  return undefined;
}
