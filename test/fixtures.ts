/**
 * Shared test fixtures — a complete in-memory RoutingConfig that exercises
 * every rule/default/named-exception code path.
 */
import type { RoutingConfig } from "../src/schema.js";

export function buildFixtureConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  const base: RoutingConfig = {
    provenance: {
      version: "1.0.0",
      blueprint_alignment: "test",
      last_updated: "2026-06-01",
      next_review: "2026-12-01",
      locked_decisions: ["test fixture"],
    },
    defaults: {
      text: "opus-4.7",
      code_agent_loop: "gpt-5.3-codex",
      code_one_shot: "opus-4.7",
      long_context_recall: "gemini-3.1-pro",
      web_research_fanout: "sonar-pro",
      image: "nano-banana-2",
      image_product_colour_critical: "imagen-4",
      video_hero: "veo-3.1-standard",
      video_social_bulk: "veo-3.1-lite",
      voice: "gpt-realtime-1.5",
      vision: "opus-4.7",
      ner_structured_extraction: "sonnet-4.6",
    },
    guardrails: {
      sonnet_use_requires_approval: true,
      haiku_use_requires_approval: true,
      quarterly_revaluation_gate: "2026-08-01",
      sonnet_next_version_auto_revaluation: true,
      cost_trigger_review_per_category_per_month_usd: 300,
      max_concurrent_subagents: 10,
      max_subagent_depth: 1,
      multi_agent_token_budget_warning_multiplier: 15,
      cost_cliff_warn: {
        "gpt-5.5": {
          threshold_tokens: 272000,
          note: "2x input / 1.5x output above 272K.",
        },
        "gemini-3.1-pro": {
          threshold_tokens: 200000,
          note: "$4/$18 above 200K tier.",
        },
      },
    },
    degraded_mode: {
      trigger: "primary unavailable >15m",
      regulated_clients_action: "PARK_AND_NOTIFY",
      regulated_clients: ["Sage Clinics", "Good Ledger"],
      notify_channel: "telegram://blake-direct",
      non_regulated_fallback: {
        text_default: {
          primary_model: "opus-4.7",
          fallbacks: ["gemini-3.1-pro", "gpt-5.5"],
        },
      },
      outage_contract: {
        avoid_window_aest: "22:00-02:00",
        avoid_window_reason: "test",
        max_parallel_subagents_per_batch: 3,
        stagger_seconds_between_batches: [30, 60],
        brief_must_include_fallback_clause: true,
        retry_loop_forbidden: true,
      },
    },
    rules: [
      {
        name: "compliance_routing",
        when: "tags contains_any [tga, compliance]",
        use: "opus-4.7",
        effort: "high",
        double_pass: true,
        override_blocked: true,
        provenance: "P",
      },
      {
        name: "client_copy_brand_voice",
        when: "tags contains client_copy",
        use: "opus-4.7",
        override_blocked: true,
        provenance: "P",
      },
      {
        name: "long_context_recall_route",
        when: "estimated_input_tokens > 500000",
        use: "gemini-3.1-pro",
        escalate_synthesis_to: "opus-4.7",
        provenance: "U",
      },
      {
        name: "code_agent_loop",
        when: "tags contains code and intent == agent_loop",
        use: "gpt-5.3-codex",
        provenance: "U",
      },
      {
        name: "code_one_shot_design_led",
        when: "tags contains code and intent == one_shot_design_led",
        use: "opus-4.7",
        provenance: "U",
      },
      {
        name: "ner_structured_extraction",
        when: "tags contains ner and component == graphiti",
        use: "sonnet-4.6",
        requires_approval: "blake",
        fallback_on_decline: "opus-4.7",
        provenance: "U",
      },
      {
        name: "bulk_classify_haiku_approval",
        when: "tags contains bulk_extract",
        use: "haiku-4.5",
        requires_approval: "blake",
        fallback_on_decline: "opus-4.7",
        provenance: "U",
      },
      {
        name: "research_multi_agent_pipeline",
        when: "tags contains research_multi_agent",
        pipeline: ["opus-4.7", "sonar-pro", "gemini-3.1-pro", "opus-4.7"],
        provenance: "U",
      },
      {
        name: "image_default",
        when: "tags contains image",
        use: "nano-banana-2",
        provenance: "U",
      },
      {
        name: "voice_agent",
        when: "tags contains voice",
        use: "gpt-realtime-1.5",
        provenance: "U",
      },
    ],
    named_exceptions: [
      {
        name: "Graphiti entity extraction",
        scope: "NER + relation tagging inside Graphiti",
        why_approved: "narrow NLP task",
        approved_by: "Blake",
        approved_date: "2026-05-18",
        bounded_to: "Graphiti AnthropicClient only",
        review_cadence: "weekly first month then monthly",
        logged_in: "memory/sonnet-incidents-2026-05.md",
        model: "sonnet-4.6",
      },
    ],
  };
  return { ...base, ...overrides };
}
