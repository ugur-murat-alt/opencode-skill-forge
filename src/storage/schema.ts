import type { Generated } from "kysely";
import type { MemberRole, ProjectRole } from "../domain/roles.js";
import type { JobKind, RunScopeKind } from "../domain/job-kinds.js";
import type {
  MemoryLifecycle,
  MemorySpaceKind,
  TaskStatus,
} from "../domain/memory.js";
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
    owner: string | null;
    expires_at: number | null;
    kind: "read" | "integrity" | "backup";
  };
  package_claims: {
    tenant_id: string;
    kind: "revision" | "staging";
    claim_key: string;
    owner: string;
    expires_at: number;
    created_at: number;
  };
  package_scan_state: {
    tenant_id: string;
    staging_cursor: string;
    packages_cursor: string;
    updated_at: number;
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
    /** Issue #34: null for personal/organization-scope sessions. */
    project_id: string | null;
    created_at: number;
  };
  runs: Run;
  memory_spaces: MemorySpace;
  memory_notes: MemoryNote;
  memory_note_revisions: MemoryNoteRevision;
  memory_events: MemoryEvent;
  memory_sources: MemorySource;
  memory_change_candidates: MemoryChangeCandidate;
  memory_index_terms: MemoryIndexTerm;
  memory_index_heads: MemoryIndexHead;
  memory_index_edges: MemoryIndexEdge;
  memory_spool: MemorySpoolRow;
  memory_turn_flags: MemoryTurnFlag;
  memory_spool_counters: MemorySpoolCounter;
  outbox: {
    tenant_id: string;
    run_id: string;
    delivered: number;
    delivered_at: Generated<number>;
    delivery_attempts: Generated<number>;
    dispatch_owner: string | null;
    dispatch_until: Generated<number>;
  };
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
  /**
   * Issue #34: null for personal/organization scope. Project-scope runs keep
   * the real project id; no fake project is ever generated.
   */
  project_id: string | null;
  /** Issue #34: typed job scope carried on every persisted run. */
  scope_kind: RunScopeKind;
  /** Project id, user id or the literal "organization" (see queue). */
  scope_key: string;
  /**
   * Issue #32: persisted text column; the production union stays visible in
   * the type while explicitly registered composition kinds (tests, future
   * kinds) remain assignable. Typed validation lives in `JobQueue` /
   * `ForgeWorker`, which are keyed by the kind registry.
   */
  kind: JobKind;
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

/**
 * Issue #34: memory spaces are typed. A personal space belongs to one user,
 * a project space names a real project and an organization space is shared
 * tenant-wide; project_id is never fabricated for the latter two.
 */
export interface MemorySpace {
  tenant_id: string;
  id: string;
  kind: MemorySpaceKind;
  owner_user_id: string;
  project_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
}
export interface MemoryNote {
  tenant_id: string;
  space_id: string;
  id: string;
  lifecycle: MemoryLifecycle;
  pinned: number;
  task_status: TaskStatus | null;
  current_revision: number | null;
  format_version: number;
  title: string;
  summary: string | null;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  /** Issue #35: source binding; null for service-created notes. */
  source_id: string | null;
  source_path: string | null;
  source_hash: string | null;
  source_state: MemorySourceState;
  /** Tombstone; a deleted note is never revived by a scan or spool replay. */
  deleted_at: number | null;
}
export type MemorySourceState = "present" | "missing";
export interface MemoryNoteRevision {
  tenant_id: string;
  space_id: string;
  note_id: string;
  revision: number;
  format_version: number;
  kind: string;
  title: string;
  summary: string | null;
  body_md: string;
  metadata_json: string;
  sources_json: string;
  base_revision: number | null;
  created_by: string;
  created_at: number;
  /** Issue #35: vault-relative immutable file and canonical hash. */
  file_path: string | null;
  content_hash: string | null;
  byte_size: number | null;
}
export type MemoryEventState = "pending" | "committed" | "rejected";
export interface MemoryEvent {
  tenant_id: string;
  space_id: string;
  id: string;
  source_event_key: string;
  source_kind: string;
  content_hash: string;
  state: MemoryEventState;
  observed_at: number | null;
  created_at: number;
  updated_at: number;
  committed_revision: number | null;
  /** Issue #35 follow-up (034): target note for receipt reconstruction. */
  note_id: string | null;
  /** Issue #35: durable receipt/diagnostic and derived-index marker. */
  error_code: string | null;
  receipt_json: string | null;
  attempts: number;
  indexed_at: number | null;
}
export type MemorySourceMode = "read_only" | "managed";
export interface MemorySource {
  tenant_id: string;
  id: string;
  space_id: string;
  root_path: string;
  mode: MemorySourceMode;
  cursor_json: string | null;
  checkpoint: string | null;
  last_scan_at: number | null;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}
/**
 * Issue #38 (M05): local hook spool rows. This is a delivery buffer, not a
 * primary record; `state` never claims a durable memory commit by itself.
 */
export type MemorySpoolState =
  "pending" | "delivered" | "rejected" | "conflict";
export interface MemorySpoolRow {
  id: string;
  installation_id: string;
  project_ref: string;
  client: string;
  event: string;
  session_id: string;
  turn_ref: string | null;
  worktree_key: string | null;
  event_id: string;
  source_kind: string;
  kind: string;
  content: string;
  content_hash: string;
  content_bytes: number;
  state: MemorySpoolState;
  attempts: number;
  next_attempt_at: number;
  run_id: string | null;
  last_error: string | null;
  observed_at: number;
  created_at: number;
  updated_at: number;
}
/** Whole-turn `[memory:off]` state; Stop consumes the flag. */
export interface MemoryTurnFlag {
  installation_id: string;
  session_id: string;
  turn_ref: string | null;
  memory_off: number;
  created_at: number;
  expires_at: number;
}
/** Visible diagnostics counters; no user content is stored here. */
export interface MemorySpoolCounter {
  key: string;
  value: number;
  updated_at: number;
}
export type MemoryCandidateState =
  "candidate" | "conflict" | "applied" | "rejected" | "quarantined";
export interface MemoryChangeCandidate {
  tenant_id: string;
  id: string;
  /** Null when the candidate belongs to a service working-copy conflict. */
  source_id: string | null;
  path: string;
  note_id: string | null;
  previous_hash: string | null;
  observed_hash: string | null;
  base_revision: number | null;
  state: MemoryCandidateState;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

/** Issue #36 (M03): derived lexical index rows (one per term/field). */
export interface MemoryIndexTerm {
  tenant_id: string;
  space_id: string;
  note_id: string;
  revision: number;
  content_hash: string;
  term: string;
  field: "title" | "body" | "kind";
  frequency: number;
}
/** One derived head per note, bound to the indexed revision/hash. */
export interface MemoryIndexHead {
  tenant_id: string;
  space_id: string;
  note_id: string;
  revision: number;
  content_hash: string;
  record_hash: string;
  kind: string;
  title: string;
  summary: string | null;
  lifecycle: string;
  pinned: number;
  task_status: string | null;
  verification: string;
  sources_json: string;
  edges_json: string;
  indexed_at: number;
}
/** Derived typed relations from accepted revision metadata. */
export interface MemoryIndexEdge {
  tenant_id: string;
  space_id: string;
  source_note_id: string;
  source_revision: number;
  relation: string;
  target_note_id: string;
  target_revision: number | null;
  created_at: number;
}
