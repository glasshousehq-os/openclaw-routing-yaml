import { describe, expect, it } from "vitest";
import {
  RoutingConfigSchema,
  crossCheck,
  isQuarantinedModel,
} from "../src/schema.js";
import { buildFixtureConfig } from "./fixtures.js";

describe("schema", () => {
  it("accepts the fixture config", () => {
    const result = RoutingConfigSchema.safeParse(buildFixtureConfig());
    expect(result.success).toBe(true);
  });

  it("rejects a rule with both use and pipeline set", () => {
    const cfg = buildFixtureConfig();
    const broken = {
      ...cfg,
      rules: [
        {
          ...cfg.rules[0]!,
          name: "broken",
          use: "opus-4.7",
          pipeline: ["opus-4.7"],
        },
      ],
    };
    const result = RoutingConfigSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a rule with neither use nor pipeline", () => {
    const cfg = buildFixtureConfig();
    const broken = {
      ...cfg,
      rules: [
        {
          name: "empty",
          when: "always",
          provenance: "U",
        },
      ],
    };
    const result = RoutingConfigSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects extra fields", () => {
    const cfg = buildFixtureConfig();
    const broken = { ...cfg, surpriseField: "x" };
    const result = RoutingConfigSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("isQuarantinedModel matches sonnet/haiku prefixes", () => {
    expect(isQuarantinedModel("sonnet-4.6")).toBe(true);
    expect(isQuarantinedModel("Sonnet-Anything")).toBe(true);
    expect(isQuarantinedModel("haiku-4.5")).toBe(true);
    expect(isQuarantinedModel("opus-4.7")).toBe(false);
    expect(isQuarantinedModel(null)).toBe(false);
    expect(isQuarantinedModel(undefined)).toBe(false);
  });

  describe("crossCheck", () => {
    it("returns empty list for clean fixture", () => {
      const problems = crossCheck(buildFixtureConfig());
      expect(problems).toEqual([]);
    });

    it("flags quarantined default in a non-NER field", () => {
      const cfg = buildFixtureConfig();
      cfg.defaults.text = "sonnet-4.6";
      const problems = crossCheck(cfg);
      expect(problems.some((p) => p.includes("defaults.text"))).toBe(true);
    });

    it("flags rule using sonnet without approval", () => {
      const cfg = buildFixtureConfig();
      cfg.rules.push({
        name: "rogue_sonnet",
        when: "tags contains rogue",
        use: "sonnet-4.6",
        provenance: "U",
      });
      const problems = crossCheck(cfg);
      expect(problems.some((p) => p.includes("rogue_sonnet"))).toBe(true);
    });

    it("flags quarantined model in fallback chain", () => {
      const cfg = buildFixtureConfig();
      cfg.degraded_mode.non_regulated_fallback.text_default!.fallbacks.push("sonnet-4.6");
      const problems = crossCheck(cfg);
      expect(problems.some((p) => p.includes("non_regulated_fallback"))).toBe(true);
    });

    it("flags next_review on/before last_updated", () => {
      const cfg = buildFixtureConfig();
      cfg.provenance.next_review = "2026-06-01"; // same as last_updated
      const problems = crossCheck(cfg);
      expect(problems.some((p) => p.includes("next_review"))).toBe(true);
    });
  });
});
