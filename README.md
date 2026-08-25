# opencode2-skill-forge

Independent OpenCode V2 automatic skill-evolution plugin.

The plugin preserves the existing skill-forge behavior and on-disk locations:

- project skills: `.opencode/skills/`
- global skills: `~/.config/opencode/skills/`
- evolution state: `.opencode/.skill-power/`
- global evolution state: `~/.opencode/.skill-power/`

Ships with an opt-in **prompt-editor** subsystem (independent of the skill
evolution system) — see [Prompt Editor](#prompt-editor) below.

Reviews are deny-first and isolated. Background reviews may not mutate user-owned,
pinned, protected, or unmanaged skills, and the embedded `skill-creator` is kept
in memory only. Automatic evolution remains opt-in through `evolutionMode`.

Support resources are confined to the target skill and symbolic links are rejected.
Background reviews must read an existing support file before changing it and cannot
create, modify, or remove executable files under `scripts/`. Review mutations are
transactional per skill and are rolled back when review or graduation fails.

Configure the plugin with its own options object. Existing skill options can be
moved unchanged from `opencode-omni` into this plugin.

## Background handoff policy

SPR no longer observes or serializes normal session history. For configured main
agents, the plugin adds a system instruction asking the agent to decide immediately
before its final answer whether the completed work contains a durable, reusable
procedure. When it does, the agent calls `omni_spr_handoff` once with a bounded
summary (maximum 4,000 characters). The handoff contains only the problem class,
verified method, and important constraints; conversation messages, hidden reasoning,
raw tool calls/results, secrets, and the final answer are not copied.

The handoff queues an independent `spr` review and returns immediately. The main
session never waits for the review, receives no later review result, and does not
return to it. If the agent finds no reusable procedure, it does not call the tool.

Choose which agent sessions may receive this instruction and tool with
`spr.allowedAgents` (default: `general`, `plan`, `build`):

```jsonc
{
  "package": "@vaur94/opencode2-skill-forge",
  "options": {
    "enabled": true,
    "evolutionMode": "active",
    "spr": {
      "allowedAgents": ["general", "plan", "build"],
    },
  },
}
```

Legacy `skills.trigger` / `trigger` cadence settings are ignored by the wrapper;
the preserved core receives only explicit bounded handoff sessions. Transactional
mutation controls remain in force. Each handoff is an independent review source,
so core failure counts and cooldowns are not aggregated across separate handoffs.

OpenCode can activate the plugin for multiple project locations in one server
process. Each activation keeps its location-scoped transforms and hooks, while
the wrapper routes a session's skill-forge lifecycle to exactly one activation.
Reviewer sessions are recorded at creation and delivered only to their owner;
foreign reviewers and normal owner sessions never become review sources. This
process-wide routing prevents duplicate attempts and SPR-on-SPR recursion.

## Prompt Editor

A separate, opt-in subsystem (`options.promptEditor`, default **off**) that
intercepts a human user message before it reaches the main agent and lets a
small editor agent rewrite it into a clearer, agent-friendly prompt (prompt
engineering). It is independent from the skill evolution system: it runs even
when the master `enabled` is `false`, uses its own model setting, and keeps
its own state. With automatic approval enabled it is fail-open: an editor
error, timeout, or missing model sends the **original message untouched**.
With automatic approval disabled, no message is dispatched until the user
explicitly chooses the candidate, sends the original, or re-evaluates it.

### Behavior

- **Interception.** A `session.hook("context")` callback finds the newest user
  message, dedups by message id (LRU + in-flight guard), and runs a hidden
  editor session with the `omni-prompt-editor` agent. In blocking mode (the
  default), the editor prompt is dispatched and OpenCode V2 `session.wait`
  gates the main context until the editor session is idle and the rewritten
  message has been applied.
- **Manual approval.** Each pending candidate has a process-unique gate id and
  revision. Decisions from the web UI are scoped to both, so stale/replayed
  clicks cannot authorize a new run. Restart, interruption, and shutdown cancel
  pending gates without dispatching them.
- **Session lifecycle.** The transient editor session is interrupted and deleted
  after every run, including timeout and error paths. Its lifecycle events are
  hidden from the skill-forge event loop, so the `spr` reviewer never runs
  for prompt-editor sessions.
- **Editor agent.** `mode: "subagent"`, `hidden: true`, `steps: 30` by
  default (`maxSteps`, configurable in the hard range `1..100`), deny-first
  permissions: read-only `read`/`grep`/`glob` plus
  the single terminal `omni_prompt_submit` tool. By default every submission
  must differ from the original, correct writing errors, and add all useful
  context-backed detail without inventing requirements.
- **Conversation context.** Every run receives the previous three user
  messages, previous three assistant messages, and previous ten tool calls by
  default. Tool names, states, inputs, and outputs are bounded and sanitized;
  reasoning, media, files, and credential material are omitted.
- **Learning.** By default each run returns a lesson (≤5,000 characters) that the
  plugin appends to a **single global** `learn.md`
  (`~/.opencode/.skill-power/prompt-editor/learn.md`, overridable with
  `promptEditor.learnFile`). The file is injected back into every future
  editor run and is capped (`learnMaxBytes`, default 256 KB, oldest entries
  trimmed). Per-entry and per-run injection limits are independently configurable.
- **Persistence / UI.** When `persist` is enabled (default), the plugin
  updates the stored message at the server level (`part.update`, emitting a
  `PartUpdated` event) so the TUI and web UIs reflect the rewritten prompt.
  Persistence is best-effort: if the server lacks the part API the rewrite
  stays request-scoped. It begins only after the intercepted context has
  committed the rewrite and never delays provider dispatch.
- **Web display (opencode2-web).** Every successful rewrite is also stored in
  `~/.opencode/.skill-power/prompt-editor/rewrites.jsonl` (newest 200, with
  original + improved text). opencode2-web serves it via
  `GET /api/v1/plugins/skillforge/prompt-editor/rewrites` and shows an
  "Improved prompt" toggler on the user message.
- **Live state.** Each editor run appends a lifecycle record to
  `~/.opencode/.skill-power/prompt-editor/states.jsonl`
  (`editing` → `completed`, plus `accepted` / `rejected` / `re-evaluating`
  once a decision or re-run happens). opencode2-web polls
  `GET /api/v1/plugins/skillforge/prompt-editor/states` to render a
  left-to-right shine while the editor works, a working panel with elapsed
  time, and — once completed — the swapped prompt with the original collapsed
  behind an AI badge, plus a Yes / No / Re-evaluate confirmation.
- **Session runtime flags.** Per-session `enabled` / `autoAccept` toggles live
  in `~/.opencode/.skill-power/prompt-editor/session-flags.json` (defaults:
  both true, configurable with `defaultSessionEnabled` / `defaultAutoAccept`).
  Stored overrides remain runtime-only and are surfaced by
  the web's two composer icon buttons via
  `GET`/`PUT /api/v1/plugins/skillforge/prompt-editor/session-flags?session=…`;
  the plugin skips editing sessions whose `enabled` flag is off.
- **Decisions.** The web sends accept / reject / re-evaluate through
  `POST /api/v1/plugins/skillforge/prompt-editor/request`; the plugin poller
  records decisions as state and re-runs the editor (with re-evaluation
  guidance) for `re-evaluate`.
- **Telemetry.** Every run is appended to
  `~/.opencode/.skill-power/prompt-editor/journal.jsonl` (outcome, lengths,
  duration, model, and error details).

### Configuration

```jsonc
{
  "package": "@vaur94/opencode2-skill-forge",
  "options": {
    "enabled": true, // skill evolution subsystem (unchanged)
    "spr": {
      // Optional model override for the SPR reviewer; maps onto the core's
      // reviewModel option and updates the registered agent definition.
      "model": "opencode/mimo-v2.5-free", // omit to keep the packaged default
      "variant": null,
      "allowedAgents": ["general", "plan", "build"],
    },
    "promptEditor": {
      "enabled": true, // opt-in; default false
      "model": "opencode-go/deepseek-v4-flash", // null -> session model
      "variant": null,
      "description": null, // null -> prompt-editor-agent.jsonc/default
      "maxSteps": 30, // editor step budget; range 1..100
      "timeoutMs": 30000, // finite fail-open deadline; range 1000..120000
      "directoryTimeoutMs": 5000, // owning-session lookup deadline
      "cleanupTimeoutMs": 4000, // transient-session deletion deadline
      "blocking": true, // wait for the edited prompt before the main agent starts
      "defaultSessionEnabled": true,
      "defaultAutoAccept": true,
      "minChars": 1, // shorter messages are never rewritten
      "maxChars": 200000, // longer messages pass through unedited
      "rewriteMode": "always", // "always" | "when-needed"
      "detailLevel": "thorough", // "concise" | "balanced" | "thorough"
      "correctWriting": true, // spelling, grammar, punctuation, and wording
      "learningMode": "always", // "always" | "reusable-only" | "off"

      "contextUserMessages": 3,
      "contextAssistantMessages": 3,
      "contextToolCalls": 10,
      "contextUserMessageChars": 5000,
      "contextAssistantMessageChars": 5000,
      "contextToolCallChars": 3000,
      "contextMaxChars": 98304,
      "contextScanMessages": 512,
      "contextPartsPerMessage": 128,
      "contextInputChars": 262144,
      "contextIncludeToolInputs": true,
      "contextIncludeToolOutputs": true,

      "learnFile": null, // default ~/.opencode/.skill-power/prompt-editor/learn.md
      "learnEntryMaxChars": 5000,
      "learnMaxBytes": 262144,
      "learnContextMaxChars": 65536,
      "tools": ["read", "grep", "glob"], // read-only allowlist
      "persist": true, // write the rewrite back to the message
    },
  },
}
```

`contextMaxChars` is raised automatically when necessary to retain the empty
structure of the configured message and tool-call counts; text is truncated
before an item is dropped.

`tools` may contain any subset of `read`, `grep`, and `glob`. Unknown or
write-capable tool names are discarded.

The editor agent model, variant, and description can additionally be tuned via
`prompt-editor-agent.jsonc` next to the plugin bundle; the `options` block wins
over that file. Its system prompt, hidden subagent mode, and deny-first
permissions are fixed safety controls.

An explicit `spr.model` overrides the packaged `spr-agent.jsonc` model for
review sessions (the core's `reviewModel` knob) and also updates the
registered `spr` agent definition; `spr.variant` applies to that definition.
`spr.allowedAgents` controls which agent sessions can submit the bounded
background handoff. Invalid values fail closed for handoff access.

With `rewriteMode: "always"`, unchanged submissions are rejected inside the
hidden editor session so the model can revise and submit again. If editing still
falls back to the original, check the journal
(`~/.opencode/.skill-power/prompt-editor/journal.jsonl`): entries marked
`"outcome": "error"` with `"editor run timed out"` mean the editor ran out of
time on your model/provider. Raise `timeoutMs` up to the 120-second safety cap,
or use non-blocking mode. Zero and negative values fall back to the safe default.
Oversized messages above `maxChars` skip editing immediately by design.

### Guardrails

- No write tools are granted; write-capable tools are stripped even if listed.
- Editor/review/goal-role sessions and `subagent`/hidden agent sessions are
  never rewritten (prevents rewrite loops and double-processing of agent
  instructions).
- Commands (`/…`), messages below `minChars`, and messages above `maxChars`
  are skipped.
- Tool context and `learn.md` content are treated as data by the editor.
  Credentials are redacted; per-field, aggregate, per-entry, and file caps
  plus full journaling contain prompt-injection risk.
- Builds require the preserved core bundle at `dist/skillforge-core.js` and
  fail closed if it is missing; `dist/plugin.js` is only the wrapper.

## Build & verify

Run `bun run typecheck`, `bun test`, then `bun run build:plugin`. See
`scripts/build-plugin.sh`. After a source change, restart the shared OpenCode
service from your terminal (`opencode2 service restart`) and confirm the
plugin is loaded with `opencode2 api get /api/plugin`.

Build with `bun run build:plugin`; the wrapper remains separate from and imports
the adjacent preserved `dist/skillforge-core.js` artifact. The published surface
also includes the agent configs and native helper artifacts.
