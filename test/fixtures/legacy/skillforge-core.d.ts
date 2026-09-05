// Type declaration for the precompiled skill-forge core bundle.
// `dist/skillforge-core.js` is the published 0.2.2 bundle, preserved
// byte-for-byte; this file gives the wrapper its static surface.
import type { PluginRuntime } from "../src/prompt-editor/types.js";

declare const core: {
  id: string;
  setup(ctx: PluginRuntime): Promise<(() => void | Promise<void>) | void>;
};

export default core;
export declare const PLUGIN_ID: string;
export declare const SKILL_TOOL_NAMES: string[];
export declare const NATIVE_SKILL_TOOLS: string[];
export declare const SKILLS_DEFAULTS: Record<string, unknown>;
export declare function resolveOptions(
  options?: Record<string, unknown>,
): { config: Record<string, unknown>; warnings: string[] };
export declare function resolveSkills(input?: Record<string, unknown>): Record<string, unknown>;
export declare function exposeToolName(input?: Record<string, unknown>): string | undefined;
