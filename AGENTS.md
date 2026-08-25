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
  `prompt-editor-agent.jsonc`, `README.md`, `LICENSE` are packaged.

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

## Local plugin reload

- After changing plugin source, run `bun run build:plugin`. The shared OpenCode
  service can retain ESM modules across reloads; run
  `opencode2 service restart` from your own terminal before claiming a change
  is active, then verify with `opencode2 api get /api/plugin`.
