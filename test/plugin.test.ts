import { describe, expect, it } from "vitest";
import { decide, toHookResult, type PluginRuntimeConfig } from "../src/plugin.js";
import type { RouterEvent } from "../src/router.js";
import { buildFixtureConfig } from "./fixtures.js";

function buildRuntime(overrides?: Partial<PluginRuntimeConfig>): {
  runtime: PluginRuntimeConfig;
  emitted: RouterEvent[];
  logs: string[];
} {
  const emitted: RouterEvent[] = [];
  const logs: string[] = [];
  const runtime: PluginRuntimeConfig = {
    routingConfig: buildFixtureConfig(),
    emit: (e) => emitted.push(e),
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
    ...overrides,
  };
  return { runtime, emitted, logs };
}

describe("decide()", () => {
  it("returns the right override + task class for a compliance prompt", () => {
    const { runtime } = buildRuntime();
    const decision = decide(
      { prompt: "Draft the TGA disclaimer for the supplement landing page." },
      runtime,
    );
    expect(decision.taskClass).toBe("compliance_review");
    // modelOverride is now the SDK-canonical id (claude-opus-4-7), familyTierModel
    // exposes the routing.yaml family name for logging / debugging.
    expect(decision.familyTierModel).toBe("opus-4.7");
    expect(decision.modelOverride).toBe("claude-opus-4-7");
    expect(decision.providerOverride).toBe("anthropic");
    expect(decision.matchedRule).toBe("compliance_routing");
  });

  it("respects callerTaskClass override", () => {
    const { runtime, emitted } = buildRuntime({
      callerTaskClass: "ner_structured_extraction",
    });
    const decision = decide({ prompt: "anything" }, runtime);
    expect(decision.taskClass).toBe("ner_structured_extraction");
    expect(decision.familyTierModel).toBe("sonnet-4.6");
    expect(decision.modelOverride).toBe("claude-sonnet-4-6");
    expect(emitted.some((e) => e.kind === "APPROVAL_REQUIRED")).toBe(true);
  });

  it("toHookResult drops empty overrides to undefined keys", () => {
    const result = toHookResult({
      modelOverride: null,
      familyTierModel: null,
      providerOverride: null,
      matchedRule: null,
      reason: "x",
      events: [],
      taskClass: "text",
      classifierReason: "x",
    });
    expect(result.modelOverride).toBeUndefined();
    expect(result.providerOverride).toBeUndefined();
  });

  it("toHookResult includes both fields when set", () => {
    const result = toHookResult({
      modelOverride: "claude-opus-4-7",
      familyTierModel: "opus-4.7",
      providerOverride: "anthropic",
      matchedRule: "compliance_routing",
      reason: "x",
      events: [],
      taskClass: "compliance_review",
      classifierReason: "x",
    });
    expect(result.modelOverride).toBe("claude-opus-4-7");
    expect(result.providerOverride).toBe("anthropic");
  });

  it("emits COST_CLIFF_WARN through emitter when token estimator is set", () => {
    const { runtime, emitted } = buildRuntime({
      estimateInputTokens: () => 273_000,
    });
    // Force a route to gpt-5.5 by inserting a client_copy rule.
    runtime.routingConfig.rules.unshift({
      name: "client_copy_brand_voice",
      when: "tags contains client_copy",
      use: "gpt-5.5",
      override_blocked: true,
      provenance: "U",
    });
    decide({ prompt: "Draft a newsletter subject line." }, runtime);
    expect(emitted.some((e) => e.kind === "COST_CLIFF_WARN")).toBe(true);
  });

  it("emits PARK_AND_NOTIFY when regulated + primary unreachable", () => {
    const { runtime, emitted } = buildRuntime({
      regulatedClientTag: true,
      isPrimaryUnreachable: () => true,
    });
    const decision = decide({ prompt: "Write a blog post intro." }, runtime);
    expect(decision.modelOverride).toBeNull();
    expect(emitted.some((e) => e.kind === "PARK_AND_NOTIFY")).toBe(true);
  });

  it("falls through to defaults when no rule matches strategy", () => {
    const { runtime } = buildRuntime();
    const decision = decide(
      { prompt: "Recommend an approach for handling the new pricing tiers." },
      runtime,
    );
    expect(decision.taskClass).toBe("strategy");
    // strategy has no rule and no default; null override -> orchestrator default wins
    expect(decision.modelOverride).toBeNull();
  });

  it("logs structured decision line", () => {
    const { runtime, logs } = buildRuntime();
    decide({ prompt: "Open the repo and refactor the auth flow." }, runtime);
    const decisionLog = logs.find((l) => l.includes("decision"));
    expect(decisionLog).toBeDefined();
    expect(decisionLog).toContain("code_agent_loop");
  });
});
