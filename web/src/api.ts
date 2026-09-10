let csrf = "";
let activeTenant = "";
/** Bind API calls to the tenant visible on this screen (issue #3): the shared
 * forge_tenant cookie can flip when another tab switches organization, so a
 * write from a stale tab must keep its own explicit scope. */
export function setActiveTenant(tenantId: string) {
  activeTenant = tenantId;
}
/** Shared header policy: CSRF plus the explicit screen tenant for API calls. */
export function apiHeaders(
  path: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(csrf ? { "x-forge-csrf": csrf } : {}),
    ...(activeTenant && path.startsWith("/api/")
      ? { "x-forge-tenant": activeTenant }
      : {}),
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
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: apiHeaders(path, {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }),
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
