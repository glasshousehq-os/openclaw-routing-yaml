/**
 * OpenClaw plugin entry point.
 *
 * This module is loaded by the OpenClaw runtime when the plugin is enabled.
 * Per docs/plugins/building-plugins.md the canonical shape is:
 *
 *   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 *
 *   export default definePluginEntry({
 *     id: "routing-yaml",
 *     name: "Routing YAML",
 *     register(api) { api.on("before_model_resolve", handler); },
 *   });
 *
 * `openclaw` is declared as an OPTIONAL peerDependency — the host gateway
 * provides it at runtime. We resolve `definePluginEntry` synchronously via
 * `createRequire(import.meta.url)` so this module has NO top-level await
 * (top-level await produces `dist/index.js` that fails to load under the
 * OpenClaw plugin loader — see v0.1.0 -> v0.1.1 fix notes in README).
 *
 * Library-mode fallback: if the SDK isn't resolvable (unit tests, standalone
 * library import in a non-OpenClaw process), we identity-pass the
 * definition so the module still loads and the named exports remain usable.
 *
 * The hook signature is taken verbatim from openclaw/openclaw main:
 *   src/plugins/hook-before-agent-start.types.ts
 *
 *     PluginHookBeforeModelResolveEvent  -> { prompt; attachments? }
 *     PluginHookBeforeModelResolveResult -> { modelOverride?; providerOverride? }
 */
import { createRequire } from "node:module";
import { loadRoutingConfig } from "./loader.js";
import {
  decide,
  toHookResult,
  type BeforeModelResolveEvent,
  type BeforeModelResolveResult,
  type PluginRuntimeConfig,
} from "./plugin.js";
import type { TaskClass } from "./classifier.js";

// Re-exports for downstream consumers / tests / docs.
export { loadRoutingConfig } from "./loader.js";
export {
  decide,
  toHookResult,
  type BeforeModelResolveEvent,
  type BeforeModelResolveResult,
  type PluginRuntimeConfig,
} from "./plugin.js";
export { classify, type TaskClass, type ClassifyInput } from "./classifier.js";
export { applyRule, type RouterDecision, type RouterEvent } from "./router.js";
export {
  RoutingConfigSchema,
  crossCheck,
  isQuarantinedModel,
  type RoutingConfig,
} from "./schema.js";

/**
 * Shape of `plugins.entries["routing-yaml"].config` (mirrors
 * openclaw.plugin.json `configSchema`).
 */
export interface RoutingYamlPluginConfig {
  routingYamlPath?: string;
  callerTaskClass?: TaskClass;
  regulatedClientTag?: boolean;
  extraRegulatedKeywords?: string[];
  providerMap?: Record<string, string>;
  notifyChannelOverride?: string;
}

/**
 * Loose-typed shape of the API passed by definePluginEntry's register fn.
 * We only depend on the two surfaces we actually use: `api.config` (to read
 * our plugin entry) and `api.on(...)` (to register the hook).
 */
interface PluginApiLike {
  id: string;
  name: string;
  config?: unknown;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  on(
    hookName: "before_model_resolve",
    handler: (event: BeforeModelResolveEvent) => Promise<BeforeModelResolveResult | undefined>,
  ): void;
}

interface PluginEntryDefinition {
  id: string;
  name: string;
  description?: string;
  register(api: PluginApiLike): void;
}

/**
 * Read `plugins.entries["routing-yaml"].config` off the runtime api.config
 * blob without trusting its shape — every field is validated.
 */
function readPluginConfig(api: PluginApiLike): RoutingYamlPluginConfig {
  // Defensive parse: we don't want a malformed config field to crash the hook.
  const cfg = api.config as
    | undefined
    | {
        plugins?: {
          entries?: Record<string, { config?: RoutingYamlPluginConfig }>;
        };
      };
  const entry = cfg?.plugins?.entries?.[api.id]?.config;
  return entry ?? {};
}

/**
 * Build the runtime config consumed by `decide(...)`. Pulled into its own
 * function so the gateway-side test can call it without going through the
 * dynamic SDK import.
 */
export function buildRuntimeConfig(
  pluginConfig: RoutingYamlPluginConfig,
  logger: PluginApiLike["logger"],
): PluginRuntimeConfig | null {
  const loaded = loadRoutingConfig({
    routingYamlPath: pluginConfig.routingYamlPath,
    logger,
  });
  if (!loaded.config) return null;

  return {
    routingConfig: loaded.config,
    callerTaskClass: pluginConfig.callerTaskClass,
    regulatedClientTag: pluginConfig.regulatedClientTag ?? false,
    extraRegulatedKeywords: pluginConfig.extraRegulatedKeywords,
    providerMap: pluginConfig.providerMap,
    notifyChannelOverride: pluginConfig.notifyChannelOverride,
    logger,
    // v1 doesn't ship a token estimator. Heuristic long-context detection
    // wants a real session-token signal which only the orchestrator owns;
    // we add this as a plugin-config callback hook in v1.1.
    estimateInputTokens: undefined,
    // v1 doesn't probe provider reachability. Degraded mode fires only when
    // the orchestrator signals primary-unreachable through a future
    // plugin-runtime contract; for v1 we hard-wire it off.
    isPrimaryUnreachable: () => false,
    emit: (event) => {
      // Default emitter: log structured event line. The orchestrator can
      // pipe these into Telegram via the OpenClaw notification API once
      // that surface is stable (issue tracked in v1.1 outstanding).
      const msg = `[routing-yaml] event ${JSON.stringify(event)}`;
      if (event.kind === "QUARANTINE_BLOCKED" || event.kind === "PARK_AND_NOTIFY") {
        logger?.warn(msg);
      } else {
        logger?.info(msg);
      }
    },
  };
}

/**
 * Resolve `definePluginEntry` from the host-provided `openclaw` package
 * synchronously. We use `createRequire` rather than `import()` so the
 * resolution happens at module-load time with NO top-level await — that
 * top-level await is exactly what broke v0.1.0 under the OpenClaw plugin
 * loader.
 *
 * If the SDK isn't installed (standalone library use, unit tests, dry
 * inspection), we fall through to an identity wrapper so the module still
 * loads cleanly.
 */
function resolveDefinePluginEntry(): (def: PluginEntryDefinition) => PluginEntryDefinition {
  try {
    const require = createRequire(import.meta.url);
    const mod: unknown = require("openclaw/plugin-sdk/plugin-entry");
    if (
      mod !== null &&
      typeof mod === "object" &&
      "definePluginEntry" in mod &&
      typeof (mod as { definePluginEntry: unknown }).definePluginEntry === "function"
    ) {
      return (mod as { definePluginEntry: (def: PluginEntryDefinition) => PluginEntryDefinition })
        .definePluginEntry;
    }
  } catch {
    // SDK not present (library use or unit test): identity-pass the definition.
  }
  return (def) => def;
}

const definePluginEntry = resolveDefinePluginEntry();

/**
 * The default export — OpenClaw's plugin loader reads this directly. No
 * top-level await; the SDK wrapper is resolved synchronously above.
 */
export default definePluginEntry({
  id: "routing-yaml",
  name: "Routing YAML",
  description: "Routes each agent turn to a model per task class via routing.yaml.",
  register(api: PluginApiLike): void {
    const pluginCfg = readPluginConfig(api);
    const runtime = buildRuntimeConfig(pluginCfg, api.logger);
    if (!runtime) {
      api.logger?.warn(
        "[routing-yaml] routing.yaml unavailable; plugin will no-op (no model override).",
      );
      return;
    }
    api.on(
      "before_model_resolve",
      async (event: BeforeModelResolveEvent): Promise<BeforeModelResolveResult | undefined> => {
        try {
          const decision = decide(event, runtime);
          const result = toHookResult(decision);
          // Empty object -> undefined keeps the hook a true no-op for the
          // orchestrator instead of stamping a no-op record in setup.ts.
          return Object.keys(result).length > 0 ? result : undefined;
        } catch (err) {
          api.logger?.error(`[routing-yaml] hook threw: ${String(err)}`);
          return undefined;
        }
      },
    );
    api.logger?.info(
      "[routing-yaml] before_model_resolve hook registered; routing.yaml live.",
    );
  },
});
