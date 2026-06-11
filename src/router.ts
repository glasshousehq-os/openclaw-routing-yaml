/**
 * Router — given a classified task class + the parsed routing.yaml,
 * pick the override model (and provider, if configured).
 *
 * Enforces guardrails IN CODE:
 *   - Quarantined models (Sonnet, Haiku) require `requires_approval: blake`
 *     on the matched rule OR a matching named_exceptions entry. Else BLOCK.
 *   - Cost-cliff warnings: GPT-5.5 @ 272K, Gemini @ 200K (or whatever
 *     thresholds the parsed config carries).
 *   - Degraded mode: regulated client tag + primary unreachable → return
 *     a null override AND emit a PARK_AND_NOTIFY event for the caller.
 *
 * Pipeline rules (multi-stage research topology) — v1 returns the FIRST
 * step model. v1.1 may expose the full pipeline via a side channel; for
 * now the orchestrator drives subsequent stages via its own subagent
 * spawning, NOT via this plugin (Anthropic enforces depth=1, see SOUL.md).
 */
import {
  type RoutingConfig,
  type RoutingRule,
  isQuarantinedModel,
} from "./schema.js";
import type { TaskClass } from "./classifier.js";

export type RouterEvent =
  | {
      kind: "PARK_AND_NOTIFY";
      reason: string;
      notifyChannel: string;
      taskClass: TaskClass;
      details: Record<string, unknown>;
    }
  | {
      kind: "COST_CLIFF_WARN";
      modelId: string;
      thresholdTokens: number;
      estimatedTokens: number;
      note: string;
    }
  | {
      kind: "QUARANTINE_BLOCKED";
      ruleName: string;
      modelId: string;
      reason: string;
    }
  | {
      kind: "APPROVAL_REQUIRED";
      ruleName: string;
      modelId: string;
      fallbackOnDecline: string | null;
    };

export interface RouterDecision {
  /** Model the plugin wants to apply via modelOverride. `null` means no override. */
  modelOverride: string | null;
  /** Provider override, only set if providerMap is configured for this model. */
  providerOverride: string | null;
  /** Matched routing rule name, or null when defaults applied. */
  matchedRule: string | null;
  /** Why this decision was made (for logs/audit). */
  reason: string;
  /** Side events the caller should act on (warnings, park-and-notify). */
  events: RouterEvent[];
}

export interface ApplyRuleInput {
  taskClass: TaskClass;
  estimatedInputTokens?: number;
  /** Caller marks the agent as serving a regulated client. */
  regulatedClientTag?: boolean;
  /** Treat primary as unreachable (for degraded-mode tests / runtime signals). */
  primaryUnreachable?: boolean;
  /** Optional model-family -> provider id map; usually unset. */
  providerMap?: Record<string, string>;
  /** Override the notify_channel from the config. */
  notifyChannelOverride?: string;
  /** A list of explicit caller tags merged into rule predicate hints. v1 uses
   *  this only for the regulatedClientTag plumb; reserved for v1.1. */
  callerTags?: string[];
}

// -------------------------------------------------------------------------
// Rule selection
// -------------------------------------------------------------------------

/**
 * Find the routing rule that handles `taskClass`. First match wins.
 *
 * v1 does NOT execute the raw `when:` predicate DSL from routing.yaml — that
 * DSL is a HUMAN-READABLE annotation. We map task classes to rule names by
 * convention, which matches the rules shipped in GLA-25's routing.yaml.
 *
 * If a future routing.yaml adds rules whose names don't match the canonical
 * task class strings below, override the rule name on the rule entry to
 * something this map recognises, or fall through to defaults.
 */
function findRuleForTaskClass(
  cfg: RoutingConfig,
  taskClass: TaskClass,
): RoutingRule | null {
  // Map task class -> set of rule-name prefixes the router will accept.
  // First-match-wins in the `rules:` array order, so we walk that order.
  const acceptPrefixes: Record<TaskClass, readonly string[]> = {
    compliance_review: ["compliance_routing"],
    client_copy: ["client_copy"],
    long_context_recall: ["long_context_recall"],
    code_agent_loop: ["code_agent_loop"],
    code_one_shot: ["code_one_shot"],
    ner_structured_extraction: ["ner_structured_extraction"],
    bulk_classify: ["bulk_classify"],
    web_research_fanout: ["research_multi_agent", "web_research"],
    strategy: [],
    image: ["image_default", "image"],
    video_hero: ["video_hero"],
    video_social_bulk: ["video_social_bulk"],
    voice: ["voice_agent", "voice"],
    vision: [],
    text: [],
  };

  const prefixes = acceptPrefixes[taskClass] ?? [];
  if (prefixes.length === 0) return null;

  for (const rule of cfg.rules) {
    for (const p of prefixes) {
      if (rule.name.startsWith(p)) return rule;
    }
  }
  return null;
}

function defaultForTaskClass(cfg: RoutingConfig, taskClass: TaskClass): string | null {
  const map: Record<TaskClass, keyof RoutingConfig["defaults"] | null> = {
    text: "text",
    code_agent_loop: "code_agent_loop",
    code_one_shot: "code_one_shot",
    long_context_recall: "long_context_recall",
    web_research_fanout: "web_research_fanout",
    image: "image",
    video_hero: "video_hero",
    video_social_bulk: "video_social_bulk",
    voice: "voice",
    vision: "vision",
    ner_structured_extraction: "ner_structured_extraction",
    // No default; falls through to orchestrator primary.
    compliance_review: null,
    client_copy: null,
    strategy: null,
    bulk_classify: null,
  };
  const key = map[taskClass];
  if (!key) return null;
  return cfg.defaults[key];
}

// -------------------------------------------------------------------------
// Cost-cliff warnings
// -------------------------------------------------------------------------

function buildCostCliffEvents(
  cfg: RoutingConfig,
  modelId: string,
  estimatedInputTokens: number | undefined,
): RouterEvent[] {
  if (!estimatedInputTokens) return [];
  const events: RouterEvent[] = [];
  for (const [name, cliff] of Object.entries(cfg.guardrails.cost_cliff_warn)) {
    // Match cost-cliff key against the model family (prefix match, case-insensitive).
    if (modelId.toLowerCase().startsWith(name.toLowerCase()) && estimatedInputTokens >= cliff.threshold_tokens) {
      events.push({
        kind: "COST_CLIFF_WARN",
        modelId,
        thresholdTokens: cliff.threshold_tokens,
        estimatedTokens: estimatedInputTokens,
        note: cliff.note,
      });
    }
  }
  return events;
}

// -------------------------------------------------------------------------
// Quarantine enforcement
// -------------------------------------------------------------------------

function isApprovalCarvedOut(rule: RoutingRule | null, _cfg: RoutingConfig, _modelId: string): boolean {
  // Quarantined-model gate at runtime: the rule MUST set
  // `requires_approval: blake`. Named-exceptions in routing.yaml are
  // documentation + lint surface, not a runtime bypass. This mirrors the
  // Pydantic lint (schema.py crossCheck): every rule using sonnet/haiku
  // requires_approval=blake even when the model id matches a named_exception
  // entry. The named_exception only legitimises one default field
  // (ner_structured_extraction) which is checked separately below.
  return rule?.requires_approval === "blake";
}

// -------------------------------------------------------------------------
// Public entrypoint
// -------------------------------------------------------------------------

export function applyRule(cfg: RoutingConfig, input: ApplyRuleInput): RouterDecision {
  const events: RouterEvent[] = [];

  // Degraded mode — regulated client tag + primary unreachable = PARK.
  if (input.primaryUnreachable && input.regulatedClientTag) {
    const notifyChannel = input.notifyChannelOverride ?? cfg.degraded_mode.notify_channel;
    events.push({
      kind: "PARK_AND_NOTIFY",
      reason: "primary_unreachable_AND_regulated_client",
      notifyChannel,
      taskClass: input.taskClass,
      details: {
        action: cfg.degraded_mode.regulated_clients_action,
        trigger: cfg.degraded_mode.trigger,
      },
    });
    return {
      modelOverride: null,
      providerOverride: null,
      matchedRule: null,
      reason: "PARK_AND_NOTIFY: regulated client + primary unreachable",
      events,
    };
  }

  // 1. Look for a rule matching the task class.
  const rule = findRuleForTaskClass(cfg, input.taskClass);
  let chosenModel: string | null = null;
  let matchedRuleName: string | null = null;
  let reason: string;

  if (rule) {
    matchedRuleName = rule.name;
    if (rule.use) {
      chosenModel = rule.use;
    } else if (rule.pipeline && rule.pipeline.length > 0) {
      // v1: pick the FIRST step of the pipeline as the override. The
      // orchestrator drives later stages via its own subagent spawning
      // (Anthropic depth=1 cap; SOUL.md). Surface via reason.
      const firstStep = rule.pipeline[0];
      if (firstStep) {
        chosenModel = firstStep;
      }
    }
    reason = `rule_matched=${rule.name}`;

    // Quarantine guard.
    if (chosenModel && isQuarantinedModel(chosenModel)) {
      const approved = isApprovalCarvedOut(rule, cfg, chosenModel);
      if (!approved) {
        events.push({
          kind: "QUARANTINE_BLOCKED",
          ruleName: rule.name,
          modelId: chosenModel,
          reason: "quarantined model with no approval and no named_exception",
        });
        // Fall back to fallback_on_decline if rule provided it, else null.
        const fallback = rule.fallback_on_decline ?? null;
        chosenModel = fallback;
        reason = `rule_matched=${rule.name} BLOCKED quarantine; using fallback=${fallback ?? "none"}`;
      } else {
        events.push({
          kind: "APPROVAL_REQUIRED",
          ruleName: rule.name,
          modelId: chosenModel,
          fallbackOnDecline: rule.fallback_on_decline ?? null,
        });
      }
    }
  } else {
    // 2. Defaults table for the task class.
    chosenModel = defaultForTaskClass(cfg, input.taskClass);
    reason = chosenModel
      ? `no_rule_matched; defaults.${input.taskClass}`
      : `no_rule_and_no_default for task_class=${input.taskClass}`;

    // Defaults can still be quarantined (ner_structured_extraction = sonnet-4.6).
    // We don't second-guess named_exceptions here; if the default is named-exception
    // approved at lint time, the override is allowed at runtime.
    if (chosenModel && isQuarantinedModel(chosenModel)) {
      const inExceptions = cfg.named_exceptions.some((e) => e.model === chosenModel);
      if (!inExceptions) {
        events.push({
          kind: "QUARANTINE_BLOCKED",
          ruleName: `<defaults.${input.taskClass}>`,
          modelId: chosenModel,
          reason: "default points at quarantined model without named_exception",
        });
        chosenModel = null;
      }
    }
  }

  // 3. Cost-cliff warnings if we resolved a model and got an est token count.
  if (chosenModel) {
    events.push(...buildCostCliffEvents(cfg, chosenModel, input.estimatedInputTokens));
  }

  // 4. Provider override (if mapped).
  const providerOverride =
    chosenModel && input.providerMap ? input.providerMap[chosenModel] ?? null : null;

  return {
    modelOverride: chosenModel,
    providerOverride,
    matchedRule: matchedRuleName,
    reason,
    events,
  };
}
