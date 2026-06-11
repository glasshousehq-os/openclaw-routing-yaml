/**
 * Plugin core — wires the loader + classifier + router together behind a
 * single function. Imported by index.ts (which adds the OpenClaw SDK glue)
 * and by tests (which call it directly with mock loggers/notifiers).
 *
 * Hook contract reference (fetched from openclaw/openclaw main on 11 Jun 2026):
 *
 *   // src/plugins/hook-before-agent-start.types.ts
 *   export type PluginHookBeforeModelResolveEvent = {
 *     prompt: string;
 *     attachments?: PluginHookBeforeModelResolveAttachment[];
 *   };
 *   export type PluginHookBeforeModelResolveResult = {
 *     modelOverride?: string;
 *     providerOverride?: string;
 *   };
 *
 * Runtime integration point (line refs same source, ~setup.ts:45):
 *   resolveHookModelSelection() runs before resolveModel(). Our return
 *   value short-circuits the orchestrator's primary model pick.
 */
import { classify, type ClassifyInput, type TaskClass } from "./classifier.js";
import { applyRule, type RouterDecision, type RouterEvent } from "./router.js";
import type { RoutingConfig } from "./schema.js";

/**
 * Event payload the OpenClaw runtime passes to `before_model_resolve`.
 * Re-declared locally so unit tests don't need to import OpenClaw types.
 */
export interface BeforeModelResolveEvent {
  prompt: string;
  attachments?: Array<{
    kind: "image" | "video" | "audio" | "document" | "other";
    mimeType?: string;
  }>;
}

/**
 * Return shape the OpenClaw runtime accepts from `before_model_resolve`.
 * Either field may be omitted; both undefined means "no override".
 */
export interface BeforeModelResolveResult {
  modelOverride?: string;
  providerOverride?: string;
}

export interface PluginRuntimeConfig {
  /** Parsed + validated routing.yaml. */
  routingConfig: RoutingConfig;
  /** Optional caller-supplied task-class override (used by Graphiti for NER). */
  callerTaskClass?: TaskClass;
  /** Optional flag that this agent serves a regulated client. */
  regulatedClientTag?: boolean;
  /** Extra regulated keywords (per-agent override). */
  extraRegulatedKeywords?: string[];
  /** Family-name -> provider id (rarely set). */
  providerMap?: Record<string, string>;
  /** Override the notify_channel from routing.yaml. */
  notifyChannelOverride?: string;
  /** Token estimator. If unset, long-context-recall classifier won't fire. */
  estimateInputTokens?: (event: BeforeModelResolveEvent) => number;
  /** Runtime signal: primary provider is currently unreachable. */
  isPrimaryUnreachable?: () => boolean;
  /** Side-channel for emitted events (cost cliffs, park-and-notify). */
  emit?: (event: RouterEvent) => void;
  /** Structured logger; falls back to console. */
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface DecideResult extends RouterDecision {
  taskClass: TaskClass;
  classifierReason: string;
}

/**
 * Pure decision function. Inputs in, decision out, side-effects (logger /
 * emit) deferred to the caller-supplied closures so the function stays
 * unit-testable.
 */
export function decide(
  event: BeforeModelResolveEvent,
  cfg: PluginRuntimeConfig,
): DecideResult {
  const tokens = cfg.estimateInputTokens?.(event) ?? 0;

  const classifierInput: ClassifyInput = {
    prompt: event.prompt,
    attachments: event.attachments,
    estimatedInputTokens: tokens,
    callerTaskClass: cfg.callerTaskClass,
    regulatedClientTag: cfg.regulatedClientTag,
    extraRegulatedKeywords: cfg.extraRegulatedKeywords,
  };
  const classification = classify(classifierInput);

  const decision = applyRule(cfg.routingConfig, {
    taskClass: classification.taskClass,
    estimatedInputTokens: tokens,
    regulatedClientTag: cfg.regulatedClientTag,
    primaryUnreachable: cfg.isPrimaryUnreachable?.() ?? false,
    providerMap: cfg.providerMap,
    notifyChannelOverride: cfg.notifyChannelOverride,
  });

  // Drain events through the optional emitter.
  if (cfg.emit) {
    for (const e of decision.events) cfg.emit(e);
  }

  // Structured log line for the decision (one per turn, audit-friendly).
  const log = cfg.logger;
  if (log) {
    const summary = JSON.stringify({
      task_class: classification.taskClass,
      classifier_reason: classification.reason,
      matched_rule: decision.matchedRule,
      model_override: decision.modelOverride,
      provider_override: decision.providerOverride,
      decision_reason: decision.reason,
      event_kinds: decision.events.map((e) => e.kind),
    });
    log.info(`[routing-yaml] decision ${summary}`);
  }

  return {
    ...decision,
    taskClass: classification.taskClass,
    classifierReason: classification.reason,
  };
}

/**
 * Map a DecideResult to the OpenClaw `before_model_resolve` return shape.
 * Empty object when there's no override (orchestrator's own default wins).
 */
export function toHookResult(decision: DecideResult): BeforeModelResolveResult {
  const out: BeforeModelResolveResult = {};
  if (decision.modelOverride) out.modelOverride = decision.modelOverride;
  if (decision.providerOverride) out.providerOverride = decision.providerOverride;
  return out;
}
