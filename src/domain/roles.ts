/** Workspace membership roles. Founder is irremovable except by voluntary transfer. */
export const MEMBER_ROLES = [
  "founder",
  "admin",
  "writer",
  "reader",
  "auditor",
] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const PROJECT_ROLES = ["writer", "reader"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Roles allowed on invitations and member provisioning (never founder). */
export const GRANTABLE_ROLES = [
  "admin",
  "writer",
  "reader",
  "auditor",
] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/** MCP tools governed by the role matrix (mirrors mcp/schemas tool names). */
export const MATRIX_TOOLS = [
  "forge_search",
  "forge_load",
  "forge_run",
  "forge_handoff",
  "forge_report",
] as const;
export type MatrixTool = (typeof MATRIX_TOOLS)[number];

type BaseRole = "reader" | "writer" | "admin";
const BASE_TOOLS: Record<BaseRole, readonly MatrixTool[]> = {
  reader: ["forge_search", "forge_load", "forge_report"],
  writer: [...MATRIX_TOOLS],
  admin: [...MATRIX_TOOLS],
};
const BASE_PERMISSION = {
  reader: "read",
  writer: "write",
  admin: "admin",
} as const;

export const BUILTIN_BASE: Record<string, BaseRole> = {
  founder: "admin",
  admin: "admin",
  writer: "writer",
  reader: "reader",
  auditor: "reader",
};
export const BUILTIN_TOOLS: Record<string, readonly MatrixTool[]> = {
  founder: [...MATRIX_TOOLS],
  admin: [...MATRIX_TOOLS],
  writer: [...MATRIX_TOOLS],
  reader: ["forge_search", "forge_load", "forge_report"],
  auditor: ["forge_report"],
};

const ROLE_RANK: Record<string, number> = {
  founder: 4,
  admin: 3,
  writer: 2,
  reader: 1,
  auditor: 1,
};

/** Rank for escalation checks; unknown roles rank 0 (fail closed). */
export function roleRank(role: string, base?: string | null): number {
  if (role in ROLE_RANK) return ROLE_RANK[role]!;
  if (base && base in BASE_TOOLS)
    return base === "admin" ? 3 : base === "writer" ? 2 : 1;
  return 0;
}

export function baseTools(base: BaseRole): readonly MatrixTool[] {
  return BASE_TOOLS[base];
}

export function basePermission(base: BaseRole): "read" | "write" | "admin" {
  return BASE_PERMISSION[base];
}
