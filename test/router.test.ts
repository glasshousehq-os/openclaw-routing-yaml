import { describe, expect, it } from "vitest";
import { applyRule } from "../src/router.js";
import { buildFixtureConfig } from "./fixtures.js";

describe("router", () => {
  // Per v0.1.2: decision.modelOverride is the SDK-canonical id resolved via
  // DEFAULT_MODEL_MAP (or caller-supplied modelMap). decision.familyTierModel
  // is the routing.yaml family name (opus-4.7, sonnet-4.6, etc).
  it("routes compliance_review to opus via compliance_routing rule", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "compliance_review" });
    expect(decision.familyTierModel).toBe("opus-4.7");
    expect(decision.modelOverride).toBe("claude-opus-4-7");
    expect(decision.matchedRule).toBe("compliance_routing");
  });

  it("routes long_context_recall to gemini (non-Anthropic family pass-through)", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "long_context_recall" });
    expect(decision.familyTierModel).toBe("gemini-3.1-pro");
    // gemini not in DEFAULT_MODEL_MAP -> family-tier id surfaces unchanged so
    // the orchestrator either resolves via its own catalog OR fails loud.
    expect(decision.modelOverride).toBe("gemini-3.1-pro");
  });

  it("routes code_agent_loop to gpt-5.3-codex via rule (non-Anthropic pass-through)", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "code_agent_loop" });
    expect(decision.familyTierModel).toBe("gpt-5.3-codex");
    expect(decision.modelOverride).toBe("gpt-5.3-codex");
    expect(decision.matchedRule).toBe("code_agent_loop");
  });

  it("falls back to default for strategy (no rule match)", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "strategy" });
    expect(decision.modelOverride).toBeNull();
    expect(decision.familyTierModel).toBeNull();
    expect(decision.matchedRule).toBeNull();
  });

  it("falls back to defaults.text for text task class", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "text" });
    expect(decision.familyTierModel).toBe("opus-4.7");
    expect(decision.modelOverride).toBe("claude-opus-4-7");
    expect(decision.matchedRule).toBeNull();
  });

  it("returns FIRST step of pipeline for research_multi_agent", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "web_research_fanout" });
    // web_research_fanout matches research_multi_agent_pipeline first
    expect(decision.familyTierModel).toBe("opus-4.7");
    expect(decision.modelOverride).toBe("claude-opus-4-7");
    expect(decision.matchedRule).toBe("research_multi_agent_pipeline");
  });

  it("ner_structured_extraction routes to sonnet with approval event", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "ner_structured_extraction" });
    expect(decision.familyTierModel).toBe("sonnet-4.6");
    expect(decision.modelOverride).toBe("claude-sonnet-4-6");
    expect(decision.events.some((e) => e.kind === "APPROVAL_REQUIRED")).toBe(true);
  });

  it("bulk_classify routes to haiku with approval event", () => {
    const cfg = buildFixtureConfig();
    const decision = applyRule(cfg, { taskClass: "bulk_classify" });
    expect(decision.familyTierModel).toBe("haiku-4.5");
    expect(decision.modelOverride).toBe("claude-haiku-4-5-20251001");
    expect(decision.events.some((e) => e.kind === "APPROVAL_REQUIRED")).toBe(true);
  });

  describe("quarantine smoke tests", () => {
    it("BLOCKS rogue sonnet rule without approval; falls back if declared", () => {
      const cfg = buildFixtureConfig();
      cfg.rules.unshift({
        name: "compliance_routing", // hijack the matcher slot
        when: "tags contains_any [tga]",
        use: "sonnet-4.6", // QUARANTINED, no requires_approval
        provenance: "U",
        fallback_on_decline: "opus-4.7",
      });
      const decision = applyRule(cfg, { taskClass: "compliance_review" });
      expect(decision.events.some((e) => e.kind === "QUARANTINE_BLOCKED")).toBe(true);
      // Fallback applied: family-tier opus-4.7 resolves to SDK claude-opus-4-7.
      expect(decision.familyTierModel).toBe("opus-4.7");
      expect(decision.modelOverride).toBe("claude-opus-4-7");
    });

    it("BLOCKS rogue haiku rule with no fallback -> null override", () => {
      const cfg = buildFixtureConfig();
      cfg.rules.unshift({
        name: "client_copy_brand_voice",
        when: "tags contains client_copy",
        use: "haiku-4.5", // QUARANTINED, no requires_approval, no fallback
        provenance: "U",
      });
      const decision = applyRule(cfg, { taskClass: "client_copy" });
      expect(decision.events.some((e) => e.kind === "QUARANTINE_BLOCKED")).toBe(true);
      expect(decision.modelOverride).toBeNull();
    });

    it("ALLOWS sonnet when rule has requires_approval: blake (Graphiti NER path)", () => {
      const cfg = buildFixtureConfig();
      // The shipped ner_structured_extraction rule in fixtures already sets
      // requires_approval: blake AND the model is in named_exceptions. This
      // is the canonical, lint-approved Graphiti carve-out.
      const decision = applyRule(cfg, { taskClass: "ner_structured_extraction" });
      expect(decision.familyTierModel).toBe("sonnet-4.6");
      expect(decision.modelOverride).toBe("claude-sonnet-4-6");
      expect(decision.events.some((e) => e.kind === "QUARANTINE_BLOCKED")).toBe(false);
      expect(decision.events.some((e) => e.kind === "APPROVAL_REQUIRED")).toBe(true);
    });

    it("BLOCKS sonnet rule that lacks requires_approval EVEN IF model is in named_exceptions", () => {
      // Runtime is stricter than "is the model in named_exceptions": the rule
      // must explicitly require approval. Named-exceptions are a lint/audit
      // surface, not a runtime bypass.
      const cfg = buildFixtureConfig();
      cfg.rules.unshift({
        name: "compliance_routing",
        when: "tags contains rogue",
        use: "sonnet-4.6", // listed in named_exceptions BUT rule lacks approval
        provenance: "U",
        fallback_on_decline: "opus-4.7",
      });
      const decision = applyRule(cfg, { taskClass: "compliance_review" });
      expect(decision.events.some((e) => e.kind === "QUARANTINE_BLOCKED")).toBe(true);
      expect(decision.familyTierModel).toBe("opus-4.7");
      expect(decision.modelOverride).toBe("claude-opus-4-7");
    });
  });

  describe("cost-cliff warnings", () => {
    it("fires for gpt-5.5 above 272K", () => {
      const cfg = buildFixtureConfig();
      // Insert a rule mapping text task class to gpt-5.5
      cfg.rules.unshift({
        name: "client_copy_brand_voice",
        when: "tags contains client_copy",
        use: "gpt-5.5",
        override_blocked: true,
        provenance: "U",
      });
      const decision = applyRule(cfg, {
        taskClass: "client_copy",
        estimatedInputTokens: 273_000,
      });
      const cliff = decision.events.find((e) => e.kind === "COST_CLIFF_WARN");
      expect(cliff).toBeDefined();
      if (cliff && cliff.kind === "COST_CLIFF_WARN") {
        expect(cliff.modelId).toBe("gpt-5.5");
        expect(cliff.thresholdTokens).toBe(272_000);
        expect(cliff.estimatedTokens).toBe(273_000);
      }
    });

    it("fires for gemini above 200K", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "long_context_recall",
        estimatedInputTokens: 250_000,
      });
      const cliff = decision.events.find((e) => e.kind === "COST_CLIFF_WARN");
      expect(cliff).toBeDefined();
      if (cliff && cliff.kind === "COST_CLIFF_WARN") {
        expect(cliff.modelId).toBe("gemini-3.1-pro");
      }
    });

    it("does NOT fire below threshold", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "long_context_recall",
        estimatedInputTokens: 150_000,
      });
      expect(decision.events.some((e) => e.kind === "COST_CLIFF_WARN")).toBe(false);
    });
  });

  describe("degraded mode", () => {
    it("PARK_AND_NOTIFY when regulated + primary unreachable", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "client_copy",
        regulatedClientTag: true,
        primaryUnreachable: true,
      });
      expect(decision.modelOverride).toBeNull();
      const park = decision.events.find((e) => e.kind === "PARK_AND_NOTIFY");
      expect(park).toBeDefined();
      if (park && park.kind === "PARK_AND_NOTIFY") {
        expect(park.notifyChannel).toBe("telegram://blake-direct");
      }
    });

    it("honours notifyChannelOverride", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "client_copy",
        regulatedClientTag: true,
        primaryUnreachable: true,
        notifyChannelOverride: "slack://incidents",
      });
      const park = decision.events.find((e) => e.kind === "PARK_AND_NOTIFY");
      if (park && park.kind === "PARK_AND_NOTIFY") {
        expect(park.notifyChannel).toBe("slack://incidents");
      }
    });

    it("does NOT park if not regulated", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "client_copy",
        regulatedClientTag: false,
        primaryUnreachable: true,
      });
      expect(decision.events.some((e) => e.kind === "PARK_AND_NOTIFY")).toBe(false);
    });
  });

  describe("provider map", () => {
    it("applies providerOverride when family is mapped via caller providerMap", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "code_agent_loop",
        providerMap: { "gpt-5.3-codex": "openai" },
      });
      // caller modelMap not set -> non-Anthropic family passes through unchanged
      expect(decision.modelOverride).toBe("gpt-5.3-codex");
      expect(decision.familyTierModel).toBe("gpt-5.3-codex");
      expect(decision.providerOverride).toBe("openai");
    });

    it("falls back to DEFAULT_PROVIDER_MAP for known Anthropic family when providerMap omits it", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "code_agent_loop",
        // No providerMap entry for opus-4.7 -> still resolves via default.
        providerMap: { "gpt-5.3-codex": "openai" },
      });
      // code_agent_loop fixture points at gpt-5.3-codex; ensure opus path tested via different taskClass
      // (text default = opus-4.7 in the fixture)
      const opusDecision = applyRule(cfg, { taskClass: "text" });
      expect(opusDecision.familyTierModel).toBe("opus-4.7");
      expect(opusDecision.modelOverride).toBe("claude-opus-4-7");
      expect(opusDecision.providerOverride).toBe("anthropic");
      // sanity: original decision still resolves codex correctly
      expect(decision.providerOverride).toBe("openai");
    });

    it("returns null providerOverride for unknown family with no caller map", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "code_agent_loop",
      });
      // Family-tier model still surfaces; provider unknown -> null.
      expect(decision.familyTierModel).toBe("gpt-5.3-codex");
      expect(decision.providerOverride).toBeNull();
    });
  });

  describe("model map", () => {
    it("falls back to DEFAULT_MODEL_MAP for canonical Anthropic families", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, { taskClass: "text" });
      expect(decision.familyTierModel).toBe("opus-4.7");
      expect(decision.modelOverride).toBe("claude-opus-4-7");
    });

    it("caller modelMap overrides DEFAULT_MODEL_MAP", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "text",
        modelMap: { "opus-4.7": "claude-cli/claude-opus-4-7" },
      });
      // Caller-supplied SDK id wins over the baked-in default.
      expect(decision.modelOverride).toBe("claude-cli/claude-opus-4-7");
    });

    it("passes unknown family-tier through unchanged for caller to detect", () => {
      const cfg = buildFixtureConfig();
      // gpt-5.3-codex is NOT in DEFAULT_MODEL_MAP, caller didn't supply modelMap
      // -> override surfaces the family-tier id so the orchestrator can either
      //    resolve it via its own catalog OR fail loud (which is the signal the
      //    per-fleet config should add a modelMap entry).
      const decision = applyRule(cfg, { taskClass: "code_agent_loop" });
      expect(decision.familyTierModel).toBe("gpt-5.3-codex");
      expect(decision.modelOverride).toBe("gpt-5.3-codex");
    });

    it("caller modelMap can plumb in non-Anthropic SDK ids", () => {
      const cfg = buildFixtureConfig();
      const decision = applyRule(cfg, {
        taskClass: "code_agent_loop",
        modelMap: { "gpt-5.3-codex": "openai/gpt-5.3-codex-2026-05" },
      });
      expect(decision.modelOverride).toBe("openai/gpt-5.3-codex-2026-05");
    });
  });
});
