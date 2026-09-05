let csrf = "";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(csrf ? { "x-forge-csrf": csrf } : {}),
      ...init.headers,
    },
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.message ?? "İşlem tamamlanamadı.",
      response.status,
    );
  if (value.csrf) csrf = value.csrf;
  return value as T;
}
export type Project = { id: string; name: string };
export type Account = {
  role: "owner" | "admin" | "editor" | "viewer";
  identity: { userId: string; tenantId: string };
  projects: Project[];
  csrf: string;
};
