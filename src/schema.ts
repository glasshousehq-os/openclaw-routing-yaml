/**
 * routing.yaml schema (Zod) — mirrors the Pydantic v2 schema at
 * glasshouse/os/routing/schema.py used by the GLA-25 lint.
 *
 * Single source of truth for routing.yaml shape. Stays in lockstep with
 * the Pydantic schema; if one changes, the other MUST change in the same
 * PR. The Pydantic schema is authoritative for lint; this Zod schema is
 * authoritative for runtime parsing inside the plugin.
 *
 * Locked decisions (see routing.yaml header):
 *   - Identity-tier config (same trust level as SOUL.md / AGENTS.md).
 *   - extra="forbid" / .strict() — typos surface on load, not at runtime.
 *   - Every rule must set exactly one of `use:` or `pipeline:`.
 */
import { z } from "zod";

// -------------------------------------------------------------------------
// Sub-schemas
// -------------------------------------------------------------------------

export const DefaultsSchema = z
  .object({
    text: z.string(),
    code_agent_loop: z.string(),
    code_one_shot: z.string(),
    long_context_recall: z.string(),
    web_research_fanout: z.string(),
    image: z.string(),
    image_product_colour_critical: z.string(),
    video_hero: z.string(),
    video_social_bulk: z.string(),
    voice: z.string(),
    ner_structured_extraction: z.string(),
    vision: z.string(),
  })
  .strict();

export type Defaults = z.infer<typeof DefaultsSchema>;

export const CostCliffSchema = z
  .object({
    threshold_tokens: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict();

export type CostCliff = z.infer<typeof CostCliffSchema>;

export const GuardrailsSchema = z
  .object({
    sonnet_use_requires_approval: z.boolean(),
    haiku_use_requires_approval: z.boolean(),
    quarterly_revaluation_gate: z.string(), // ISO date-string from YAML
    sonnet_next_version_auto_revaluation: z.boolean(),
    cost_trigger_review_per_category_per_month_usd: z.number().int().nonnegative(),
    max_concurrent_subagents: z.number().int().min(1).max(10),
    max_subagent_depth: z.number().int().min(1).max(2),
    multi_agent_token_budget_warning_multiplier: z.number().int().min(1),
    cost_cliff_warn: z.record(z.string(), CostCliffSchema),
  })
  .strict();

export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const FallbackChainSchema = z
  .object({
    primary_model: z.string(),
    fallbacks: z.array(z.string()).min(1),
  })
  .strict();

export type FallbackChain = z.infer<typeof FallbackChainSchema>;

export const OutageContractSchema = z
  .object({
    avoid_window_aest: z.string(),
    avoid_window_reason: z.string(),
    max_parallel_subagents_per_batch: z.number().int().min(1),
    // YAML `[30, 60]` -> tuple of two ints.
    stagger_seconds_between_batches: z.tuple([z.number().int(), z.number().int()]),
    brief_must_include_fallback_clause: z.boolean(),
    retry_loop_forbidden: z.boolean(),
  })
  .strict();

export type OutageContract = z.infer<typeof OutageContractSchema>;

export const DegradedModeSchema = z
  .object({
    trigger: z.string(),
    regulated_clients_action: z.literal("PARK_AND_NOTIFY"),
    regulated_clients: z.array(z.string()).min(1),
    non_regulated_fallback: z.record(z.string(), FallbackChainSchema),
    notify_channel: z.string(),
    outage_contract: OutageContractSchema,
  })
  .strict();

export type DegradedMode = z.infer<typeof DegradedModeSchema>;

// -------------------------------------------------------------------------
// Rules — exactly one of `use:` or `pipeline:` must be set per rule.
// -------------------------------------------------------------------------

export const RoutingRuleSchema = z
  .object({
    name: z.string(),
    when: z.string(),
    use: z.string().optional(),
    pipeline: z.array(z.string()).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    double_pass: z.boolean().optional(),
    override_blocked: z.boolean().optional(),
    requires_approval: z.literal("blake").optional(),
    fallback_on_decline: z.string().optional(),
    escalate_synthesis_to: z.string().optional(),
    provenance: z.enum(["U", "P"]),
    notes: z.string().optional(),
  })
  .strict()
  .refine(
    (r) => (r.use === undefined) !== (r.pipeline === undefined),
    (r) => ({
      message: `rule '${r.name}': must set exactly one of \`use:\` or \`pipeline:\``,
    }),
  );

export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

export const NamedExceptionSchema = z
  .object({
    name: z.string(),
    scope: z.string(),
    why_approved: z.string(),
    approved_by: z.string(),
    approved_date: z.string(),
    bounded_to: z.string(),
    review_cadence: z.string(),
    logged_in: z.string(),
    model: z.string(),
  })
  .strict();

export type NamedException = z.infer<typeof NamedExceptionSchema>;

export const ProvenanceSchema = z
  .object({
    version: z.string(),
    blueprint_alignment: z.string(),
    last_updated: z.string(),
    next_review: z.string(),
    locked_decisions: z.array(z.string()),
  })
  .strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;

// -------------------------------------------------------------------------
// Root schema
// -------------------------------------------------------------------------

export const RoutingConfigSchema = z
  .object({
    provenance: ProvenanceSchema,
    defaults: DefaultsSchema,
    guardrails: GuardrailsSchema,
    degraded_mode: DegradedModeSchema,
    rules: z.array(RoutingRuleSchema).min(1),
    named_exceptions: z.array(NamedExceptionSchema),
  })
  .strict();

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

// -------------------------------------------------------------------------
// Cross-file invariants (mirrors cross_check() in schema.py).
// Returns a list of human-readable problems; empty list = clean.
// -------------------------------------------------------------------------

const QUARANTINED_PREFIXES = ["sonnet", "haiku"] as const;

export function isQuarantinedModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  return QUARANTINED_PREFIXES.some((p) => m.startsWith(p));
}

export function crossCheck(cfg: RoutingConfig): string[] {
  const problems: string[] = [];
  const exceptionModels = new Set(cfg.named_exceptions.map((e) => e.model));

  // 1. defaults.* must not point at quarantined models EXCEPT
  //    `ner_structured_extraction` AND only if listed in named_exceptions.
  for (const [field, value] of Object.entries(cfg.defaults)) {
    if (isQuarantinedModel(value)) {
      if (field !== "ner_structured_extraction") {
        problems.push(
          `defaults.${field}=${JSON.stringify(value)} uses a quarantined model. ` +
            `Only \`ner_structured_extraction\` may default to Sonnet/Haiku and ONLY via a Named Exception.`,
        );
      } else if (!exceptionModels.has(value)) {
        problems.push(
          `defaults.${field}=${JSON.stringify(value)} is quarantined but NOT listed in named_exceptions.`,
        );
      }
    }
  }

  // 2. Any rule routing to a quarantined model MUST require approval.
  for (const r of cfg.rules) {
    if (isQuarantinedModel(r.use) && r.requires_approval !== "blake") {
      problems.push(
        `rule '${r.name}': use=${JSON.stringify(r.use)} is quarantined; ` +
          `requires_approval must be set to 'blake'.`,
      );
    }
    if (r.pipeline) {
      for (const step of r.pipeline) {
        if (isQuarantinedModel(step) && r.requires_approval !== "blake") {
          problems.push(
            `rule '${r.name}': pipeline step ${JSON.stringify(step)} is quarantined; ` +
              `requires_approval must be set to 'blake'.`,
          );
        }
      }
    }
  }

  // 3. Fallback chains must never include a quarantined model.
  for (const [key, chain] of Object.entries(cfg.degraded_mode.non_regulated_fallback)) {
    for (const fb of chain.fallbacks) {
      if (isQuarantinedModel(fb)) {
        problems.push(
          `degraded_mode.non_regulated_fallback[${JSON.stringify(key)}]: ` +
            `fallback ${JSON.stringify(fb)} is quarantined. Forbidden as silent fallback.`,
        );
      }
    }
  }

  // 4. provenance.next_review must be after last_updated (string compare ok for ISO dates).
  if (cfg.provenance.next_review <= cfg.provenance.last_updated) {
    problems.push("provenance.next_review must be AFTER provenance.last_updated.");
  }

  return problems;
}
