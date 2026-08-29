# opencode2-skill-forge

## Verify changes

- Run `bun run typecheck`, `bun test`, then `bun run build:plugin`.
- `test/security-regressions.test.ts` exercises the **preserved core bundle**
  (`dist/skillforge-core.js`) via instrumented exports; do not delete that
  file, and never overwrite it with the wrapper build. The wrapper entry is
  `src/index.ts` → `dist/plugin.js`.
- Tests that touch global state must set `OC_SKILL_POWER_HOME` to a temp dir
  instead of writing the real home directory.
- Before publishing: `npm pack --dry-run`; only `dist/`, `spr-agent.jsonc`,
  `prompt-editor-agent.jsonc`, `SPR_SKILL_AUTHORING.md`, `README.md`, and
  `LICENSE` are packaged.

## Architecture

- `src/index.ts` is the V2 plugin entry (wrapper). It registers the
  `prompt-editor` subsystem first (independent of the master `enabled` flag),
  then delegates to the preserved skill-forge core bundle
  (`dist/skillforge-core.js`) — do not change the core; upstream skill-forge
  behaviour lives there.
- `src/prompt-editor/` is the maintainable TypeScript subsystem: interception
  lives in the `session.hook("context")` callback (`context-hook.ts`), the
  hidden editor session in `runner.ts`/`editor-session.ts`, learning in
  `learn.ts`, server-side persistence in `persist.ts`.
- Every successful rewrite is also appended to
  `~/.opencode/.skill-power/prompt-editor/rewrites.jsonl` (capped to the newest
  200 entries, with the original + improved text). The opencode2-web bridge
  serves this via `GET /api/v1/plugins/skillforge/prompt-editor/rewrites`; keep
  the record shape compatible with `test/prompt-editor/rewrites.test.ts` and
  the bridge reader in `opencode2-web/apps/bridge/src/index.ts`.
- The prompt-editor is fail-open: the original user message passes through on
  any editor error, timeout, or missing model. Keep it that way.

## SPR policy changes

- Read `SPR_SKILL_AUTHORING.md` before changing the SPR prompt, permissions,
  lifecycle expectations, global/project scope rules, or skill quality gates.
- Keep `spr-agent.jsonc` and `dist/spr-agent.jsonc` byte-identical. The build
  copies the root definition into `dist/`; committed files must already agree.
- The SPR security boundary is deny-first. Do not grant filesystem, shell,
  question, task-delegation, main-history, or additional lifecycle tools.
- The only supported lifecycle tools are `omni_skill_list`, `omni_skill_view`,
  `omni_skill_manage`, and `omni_skill_finalize`, plus the in-memory
  `skill-creator`. Do not document or prompt for imaginary validate/review tools.
- Preserve deterministic `create | update | no-op | reject` decisions, explicit
  project/global precedence handling, evidence-backed evaluation, and reversible
  manager-controlled writes. Add or update policy tests with every contract change.

## Local plugin reload

- After changing plugin source, run `bun run build:plugin`. The shared OpenCode
  service can retain ESM modules across reloads; run
  `opencode2 service restart` from your own terminal before claiming a change
  is active, then verify with `opencode2 api get /api/plugin`.
