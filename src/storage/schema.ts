import type { Generated } from "kysely";
import type { MemberRole, ProjectRole } from "../domain/roles.js";
export interface Tenant {
  id: string;
  name: string;
  created_at: number;
}
export interface User {
  id: string;
  subject: string;
  display_name: string;
  created_at: number;
}
export interface Membership {
  disabled: Generated<number>;
  generation: Generated<number>;
  tenant_id: string;
  user_id: string;
  role: MemberRole;
}
export interface Project {
  tenant_id: string;
  id: string;
  name: string;
  environment_id: string | null;
  created_at: number;
}
export interface ProjectMember {
  generation: Generated<number>;
  tenant_id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
}
export interface Binding {
  tenant_id: string;
  project_id: string;
  user_id: string;
  client_id: string;
  path: string;
  local_name: string | null;
  fs_fingerprint: string | null;
}
export interface Environment {
  tenant_id: string;
  id: string;
  name: string;
  created_at: number;
}
export interface ConfigRevision {
  tenant_id: string;
  id: string;
  scope_key: string;
  revision: number;
  payload: string;
  created_by: string;
  created_at: number;
}
export interface AuthSession {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  revoked: number;
  kind: "session" | "pairing" | "device";
  created_at: number;
}
export interface AuditEvent {
  tenant_id: string;
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  detail: string;
  created_at: number;
}
export interface Invitation {
  tenant_id: string;
  id: string;
  token_hash: string;
  role: string;
  invited_by: string;
  expires_at: number;
  accepted_at: number | null;
  revoked: Generated<number>;
  created_at: number;
}
export interface TenantLifecycle {
  tenant_id: string;
  frozen: Generated<number>;
  deletion_requested_at: number | null;
  deletion_requested_by: string | null;
}
export interface TransferOffer {
  tenant_id: string;
  id: string;
  to_user_id: string;
  created_by: string;
  expires_at: number;
  accepted_at: number | null;
  created_at: number;
}
export interface RoleDefinition {
  tenant_id: string;
  name: string;
  kind: "builtin" | "custom";
  base: string | null;
  tools_json: string | null;
  deleted: Generated<number>;
  created_by: string;
  created_at: number;
}
export interface AgentPrompt {
  tenant_id: string;
  profile: string;
  scope: string;
  version: number;
  content: string;
  created_by: string;
  created_at: number;
}
export interface Skill {
  tenant_id: string;
  id: string;
  scope_key: string;
  project_id: string | null;
  owner_id: string;
  name: string;
  description: string;
  search_text: string;
  active_revision: string | null;
  managed: number;
  pinned: number;
  protected: number;
  archived: number;
  created_at: number;
  updated_at: number;
}
export interface SkillRevision {
  tenant_id: string;
  skill_id: string;
  revision: string;
  manifest_json: string;
  package_path: string;
  created_by: string;
  run_id: string | null;
  validation_json: string;
  created_at: number;
}
export interface DB {
  package_deletions: {
    tenant_id: string;
    skill_id: string;
    scope_key: string;
    created_at: number;
  };
  package_gc: {
    tenant_id: string;
    skill_id: string;
    revision: string;
    package_path: string;
    state: string;
    updated_at: number;
  };
  revision_readers: {
    tenant_id: string;
    id: string;
    skill_id: string;
    revision: string;
    created_at: number;
  };
  run_revision_pins: {
    tenant_id: string;
    run_id: string;
    fence: number;
    skill_id: string;
    revision: string;
    created_at: number;
  };
  execution_revision_pins: {
    tenant_id: string;
    execution_id: string;
    skill_id: string;
    revision: string;
    created_at: number;
  };
  session_preferences: {
    tenant_id: string;
    user_id: string;
    project_id: string;
    session_key: string;
    revision: number;
    payload: string;
    updated_at: number;
  };
  migration_receipts: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    source_id: string;
    source_checksum: string;
    skill_id: string;
    revision: string;
    skill_generation: number;
    flags_json: string;
    state: "applied" | "rolled_back";
    created_at: number;
    updated_at: number;
  };
  skill_observations: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    skill_id: string;
    revision: string;
    kind: string;
    correlation: string;
    created_at: number;
  };
  maintenance_items: {
    tenant_id: string;
    user_id: string;
    project_id: string;
    operation_id: string;
    skill_id: string;
    input_hash: string;
    result_json: string;
    created_at: number;
  };
  client_installations: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    client: string;
    version: string | null;
    directory: string;
    capabilities_json: string;
    last_seen: number | null;
    last_event: string | null;
    created_at: number;
  };
  flag_imports: DB["learning_imports"];
  rewrite_imports: DB["learning_imports"];
  rewrite_import_links: {
    tenant_id: string;
    import_id: string;
    entry_id: string;
  };
  imported_rewrites: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    import_id: string;
    payload_json: string;
    source_ts: number;
  };
  learning_imports: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    source_id: string;
    checksum: string;
    original_base64: string;
    original_bytes: number;
    report_json: string;
    state: "applied" | "rolled_back";
    created_at: number;
  };
  learning_history: {
    tenant_id: string;
    entry_id: string;
    revision: number;
    content: string;
    trigger_text: string;
    disabled: number;
    created_at: number;
  };
  learning_entries: {
    revision: number;
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    scope_key: string;
    content: string;
    content_hash: string;
    trigger_text: string;
    run_id: string | null;
    disabled: number;
    created_at: number;
  };
  executions: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    idempotency_key: string;
    input_hash: string;
    state: string;
    result_json: string | null;
    created_at: number;
  };
  skills: Skill;
  skill_revisions: SkillRevision;
  skill_overrides: {
    tenant_id: string;
    project_id: string;
    name: string;
    skill_id: string;
  };

  provider_profiles: {
    tenant_id: string;
    id: string;
    user_id: string;
    role: "skill" | "evaluation";
    revision: number;
    profile_json: string;
    secret_ref: string | null;
    created_at: number;
  };
  forge_sessions: {
    tenant_id: string;
    id: string;
    user_id: string;
    project_id: string;
    created_at: number;
  };
  runs: Run;
  outbox: { tenant_id: string; run_id: string; delivered: number };
  run_attempts: {
    tenant_id: string;
    run_id: string;
    fence: number;
    worker_id: string;
    started_at: number;
    ended_at: number | null;
    result: string | null;
  };
  queue_fairness: { tenant_id: string; user_id: string; last_claimed: number };
  budget_accounts: {
    tenant_id: string;
    user_id: string;
    limit_micros: number;
    reserved_micros: number;
    spent_micros: number;
  };
  budget_reservations: {
    tenant_id: string;
    id: string;
    user_id: string;
    run_id: string;
    reserved_micros: number;
    actual_micros: number | null;
    state: "reserved" | "settled" | "unknown";
  };

  tenants: Tenant;
  users: User;
  memberships: Membership;
  environments: Environment;
  projects: Project;
  project_members: ProjectMember;
  project_bindings: Binding;
  config_revisions: ConfigRevision;
  auth_sessions: AuthSession;
  audit_events: AuditEvent;
  invitations: Invitation;
  tenant_lifecycle: TenantLifecycle;
  transfer_offers: TransferOffer;
  role_registry: RoleDefinition;
  agent_prompts: AgentPrompt;
}

export type RunState =
  | "queued"
  | "running"
  | "retry_wait"
  | "completed"
  | "no_op"
  | "rejected"
  | "failed"
  | "cancelled"
  | "superseded"
  | "improved"
  | "unchanged"
  | "fallback";
export interface Run {
  tenant_id: string;
  id: string;
  session_id: string;
  user_id: string;
  project_id: string;
  kind: "skill_evolve";
  state: RunState;
  idempotency_key: string;
  input_hash: string;
  input_json: string;
  config_json: string;
  result_json: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  available_at: number;
  deadline_at: number;
  lease_until: number;
  worker_id: string | null;
  fence: number;
  attempt: number;
  max_attempts: number;
}
