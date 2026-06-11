/**
 * routing.yaml loader.
 *
 * Resolution order:
 *   1. explicit `routingYamlPath` (plugin config)
 *   2. env var `ROUTING_YAML_PATH`
 *   3. ~/.openclaw/workspace/routing.yaml
 *
 * Behaviour:
 *   - If the resolved path doesn't exist: return null + log warning. Plugin
 *     no-ops; orchestrator's own default model wins.
 *   - If parse or schema validation fails: return null + log structured error.
 *   - If cross-check produces warnings: log each, but RETURN the config.
 *     Cross-check is the lint surface; runtime stays permissive so that
 *     a single broken cross-invariant doesn't take down every agent turn.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RoutingConfigSchema, crossCheck, type RoutingConfig } from "./schema.js";

export interface LoaderLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoadOptions {
  routingYamlPath?: string;
  envVarName?: string; // default ROUTING_YAML_PATH
  logger?: LoaderLogger;
}

export function resolveRoutingPath(opts: LoadOptions): string {
  if (opts.routingYamlPath) return opts.routingYamlPath;
  const envName = opts.envVarName ?? "ROUTING_YAML_PATH";
  const envPath = process.env[envName];
  if (envPath) return envPath;
  return join(homedir(), ".openclaw", "workspace", "routing.yaml");
}

export interface LoadResult {
  config: RoutingConfig | null;
  resolvedPath: string;
  warnings: string[];
  fatalError: string | null;
}

export function loadRoutingConfig(opts: LoadOptions = {}): LoadResult {
  const logger = opts.logger ?? {
    info: () => {},
    warn: (m) => console.warn(`[routing-yaml] ${m}`),
    error: (m) => console.error(`[routing-yaml] ${m}`),
  };

  const resolvedPath = resolveRoutingPath(opts);

  if (!existsSync(resolvedPath)) {
    const msg = `routing.yaml not found at ${resolvedPath}; plugin is a no-op for this gateway.`;
    logger.warn(msg);
    return {
      config: null,
      resolvedPath,
      warnings: [],
      fatalError: msg,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    const msg = `failed to read routing.yaml at ${resolvedPath}: ${String(err)}`;
    logger.error(msg);
    return {
      config: null,
      resolvedPath,
      warnings: [],
      fatalError: msg,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = `failed to parse YAML at ${resolvedPath}: ${String(err)}`;
    logger.error(msg);
    return {
      config: null,
      resolvedPath,
      warnings: [],
      fatalError: msg,
    };
  }

  const result = RoutingConfigSchema.safeParse(parsed);
  if (!result.success) {
    const msg = `routing.yaml schema validation failed at ${resolvedPath}: ${JSON.stringify(result.error.format(), null, 2)}`;
    logger.error(msg);
    return {
      config: null,
      resolvedPath,
      warnings: [],
      fatalError: msg,
    };
  }

  const warnings = crossCheck(result.data);
  for (const w of warnings) logger.warn(`cross-check: ${w}`);

  logger.info(
    `routing.yaml loaded from ${resolvedPath} (rules=${result.data.rules.length}, version=${result.data.provenance.version})`,
  );

  return {
    config: result.data,
    resolvedPath,
    warnings,
    fatalError: null,
  };
}
