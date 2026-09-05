// Legacy OpenCode characterization only; never a distribution entry.
import skillForge, {
  resolveOptions,
} from "../fixtures/legacy/skillforge-core.js";
import { normalizeCoreOptions } from "./core-options.js";
import { DEFAULT_SPR_ALLOWED_AGENTS, parseSprOptions } from "./spr-options.js";
import {
  registerCoreActivation,
  type CoreRuntimeContext,
} from "./core-runtime.js";
import { setupPromptEditor } from "./prompt-editor/index.js";
import { EditorRegistry } from "./prompt-editor/runner.js";
import type { PluginRuntime } from "./prompt-editor/types.js";
import { setupSprHandoff } from "./spr-handoff.js";

const PLUGIN_ID = "opencode2-skill-forge";

type Cleanup = (() => void | Promise<void>) | void;

function registrationCleanup(
  value: unknown,
): (() => Promise<void>) | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("dispose" in value) ||
    typeof value.dispose !== "function"
  )
    return undefined;
  const registration = value as { dispose(): Promise<void> };
  return () => registration.dispose();
}

export async function setup(ctx: PluginRuntime) {
  const cleanups: Array<() => void | Promise<void>> = [];
  const editorRegistry = new EditorRegistry();

  // Prompt-editor first: it must run even when the skill subsystem is off.
  try {
    const editorCleanup = setupPromptEditor(ctx, editorRegistry);
    if (editorCleanup) cleanups.push(editorCleanup);
  } catch (error) {
    console.error(
      `[${PLUGIN_ID}] prompt-editor setup failed: ${String(error)}`,
    );
  }

  // Keep location-scoped registrations per activation, but route each session's
  // core hooks and lifecycle events to one activation across the server process.
  const coreActivation = registerCoreActivation(
    ctx as unknown as CoreRuntimeContext,
    editorRegistry,
    { handoffOnly: true },
  );
  try {
    if (!coreActivation.compatible)
      throw new Error("incompatible core runtime protocol");
    const coreOptions = normalizeCoreOptions(ctx.options);
    const coreContext = coreActivation.createContext(coreOptions);
    const coreCleanup = (await skillForge.setup(
      coreContext as never,
    )) as Cleanup;
    if (coreCleanup) cleanups.push(coreCleanup as () => void | Promise<void>);
    // Fence routing before waiting for the core consumer to stop.
    cleanups.push(coreActivation.cleanup);

    // Reflect an explicit spr.model/variant on the registered agent too;
    // reviewModel alone governs runtime review-session resolution.
    const spr = parseSprOptions(ctx.options);
    const { config } = resolveOptions(coreOptions);
    const handoffEnabled =
      config.enabled === true &&
      (config.evolutionMode === "active" ||
        config.evolutionMode === "dry-run") &&
      config.writeApproval !== true;
    if (handoffEnabled) {
      try {
        const handoffCleanup = await setupSprHandoff(
          ctx as never,
          coreActivation as never,
          spr?.allowedAgents ?? DEFAULT_SPR_ALLOWED_AGENTS,
        );
        cleanups.push(handoffCleanup);
      } catch (error) {
        console.error(
          `[${PLUGIN_ID}] spr handoff setup failed: ${String(error)}`,
        );
      }
    }
    if (spr?.model || spr?.variant) {
      try {
        const slash = spr.model?.indexOf("/") ?? -1;
        const registration = await ctx.agent.transform((draft) => {
          draft.update("spr", (agent) => {
            if (spr.model) {
              agent.model = {
                providerID: spr.model.slice(0, slash),
                id: spr.model.slice(slash + 1),
                ...(spr.variant ? { variant: spr.variant } : {}),
              };
            } else if (
              spr.variant &&
              agent.model &&
              typeof agent.model === "object"
            ) {
              agent.model = { ...agent.model, variant: spr.variant };
            }
          });
        });
        const cleanup = registrationCleanup(registration);
        if (cleanup) cleanups.push(cleanup);
      } catch (error) {
        console.error(
          `[${PLUGIN_ID}] spr model override failed: ${String(error)}`,
        );
      }
    }
  } catch (error) {
    coreActivation.cleanup();
    console.error(
      `[${PLUGIN_ID}] skill subsystems setup failed: ${String(error)}`,
    );
  }

  return async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best-effort
      }
    }
  };
}

export default { id: PLUGIN_ID, setup };

export { PLUGIN_ID };
