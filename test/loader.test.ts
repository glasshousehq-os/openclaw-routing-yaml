import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingConfig, resolveRoutingPath } from "../src/loader.js";

function silentLogger() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warnings.push(m),
      error: (m: string) => errors.push(m),
    },
    warnings,
    infos,
    errors,
  };
}

const SAMPLE_YAML = `
provenance:
  version: "1.0.0"
  blueprint_alignment: "test"
  last_updated: "2026-06-01"
  next_review: "2026-12-01"
  locked_decisions: ["test"]
defaults:
  text: opus-4.7
  code_agent_loop: gpt-5.3-codex
  code_one_shot: opus-4.7
  long_context_recall: gemini-3.1-pro
  web_research_fanout: sonar-pro
  image: nano-banana-2
  image_product_colour_critical: imagen-4
  video_hero: veo-3.1-standard
  video_social_bulk: veo-3.1-lite
  voice: gpt-realtime-1.5
  ner_structured_extraction: sonnet-4.6
  vision: opus-4.7
guardrails:
  sonnet_use_requires_approval: true
  haiku_use_requires_approval: true
  quarterly_revaluation_gate: "2026-08-01"
  sonnet_next_version_auto_revaluation: true
  cost_trigger_review_per_category_per_month_usd: 300
  max_concurrent_subagents: 10
  max_subagent_depth: 1
  multi_agent_token_budget_warning_multiplier: 15
  cost_cliff_warn:
    gpt-5.5:
      threshold_tokens: 272000
      note: "test"
degraded_mode:
  trigger: "primary unavailable"
  regulated_clients_action: PARK_AND_NOTIFY
  regulated_clients: ["Sage Clinics"]
  notify_channel: "telegram://blake-direct"
  non_regulated_fallback:
    text_default:
      primary_model: opus-4.7
      fallbacks: [gemini-3.1-pro]
  outage_contract:
    avoid_window_aest: "22:00-02:00"
    avoid_window_reason: "test"
    max_parallel_subagents_per_batch: 3
    stagger_seconds_between_batches: [30, 60]
    brief_must_include_fallback_clause: true
    retry_loop_forbidden: true
rules:
  - name: "ner_structured_extraction"
    when: "ner"
    use: sonnet-4.6
    requires_approval: blake
    fallback_on_decline: opus-4.7
    provenance: U
named_exceptions:
  - name: "Graphiti NER"
    scope: "NER in graphiti"
    why_approved: "narrow"
    approved_by: "Blake"
    approved_date: "2026-05-18"
    bounded_to: "graphiti"
    review_cadence: "weekly"
    logged_in: "memory/sonnet-incidents-2026-05.md"
    model: sonnet-4.6
`;

describe("loader", () => {
  it("resolves explicit path first", () => {
    const path = resolveRoutingPath({ routingYamlPath: "/tmp/x.yaml" });
    expect(path).toBe("/tmp/x.yaml");
  });

  it("uses ROUTING_YAML_PATH env when no explicit path", () => {
    const old = process.env.ROUTING_YAML_PATH;
    process.env.ROUTING_YAML_PATH = "/tmp/env-routing.yaml";
    try {
      const path = resolveRoutingPath({});
      expect(path).toBe("/tmp/env-routing.yaml");
    } finally {
      if (old === undefined) delete process.env.ROUTING_YAML_PATH;
      else process.env.ROUTING_YAML_PATH = old;
    }
  });

  it("returns null + warning when file missing", () => {
    const { logger, warnings } = silentLogger();
    const r = loadRoutingConfig({
      routingYamlPath: "/no/such/file/routing.yaml",
      logger,
    });
    expect(r.config).toBeNull();
    expect(r.fatalError).toBeTruthy();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("parses + validates valid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-yaml-test-"));
    const file = join(dir, "routing.yaml");
    writeFileSync(file, SAMPLE_YAML, "utf8");
    try {
      const { logger } = silentLogger();
      const r = loadRoutingConfig({ routingYamlPath: file, logger });
      expect(r.fatalError).toBeNull();
      expect(r.config).not.toBeNull();
      expect(r.config?.rules.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on schema validation failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-yaml-test-"));
    const file = join(dir, "routing.yaml");
    writeFileSync(file, "provenance: 'oops not an object'\n", "utf8");
    try {
      const { logger, errors } = silentLogger();
      const r = loadRoutingConfig({ routingYamlPath: file, logger });
      expect(r.config).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on broken YAML syntax", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-yaml-test-"));
    const file = join(dir, "routing.yaml");
    writeFileSync(file, "key: [oops unclosed\n", "utf8");
    try {
      const { logger, errors } = silentLogger();
      const r = loadRoutingConfig({ routingYamlPath: file, logger });
      expect(r.config).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
