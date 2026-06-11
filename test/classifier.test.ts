import { describe, expect, it } from "vitest";
import { classify, type TaskClass } from "../src/classifier.js";

interface Case {
  label: string;
  prompt: string;
  expected: TaskClass;
  attachments?: Array<{ kind: "image" | "video" | "audio" | "document" | "other"; mimeType?: string }>;
  estimatedInputTokens?: number;
  callerTaskClass?: TaskClass;
  regulatedClientTag?: boolean;
}

const cases: Case[] = [
  {
    label: "explicit caller override wins",
    prompt: "anything",
    callerTaskClass: "ner_structured_extraction",
    expected: "ner_structured_extraction",
  },
  {
    label: "regulated client tag forces compliance_review",
    prompt: "Just write me a headline.",
    regulatedClientTag: true,
    expected: "compliance_review",
  },
  {
    label: "TGA keyword in prompt forces compliance_review",
    prompt: "Draft the TGA disclaimer for the new supplement landing page.",
    expected: "compliance_review",
  },
  {
    label: "AHPRA keyword forces compliance_review",
    prompt: "Is this practitioner profile compliant with AHPRA guidelines?",
    expected: "compliance_review",
  },
  {
    label: "long context triggers long_context_recall",
    prompt: "Summarise the attached transcript.",
    estimatedInputTokens: 120_000,
    expected: "long_context_recall",
  },
  {
    label: "web research keywords trigger web_research_fanout",
    prompt: "Please search the web for the latest pricing of Veo 3.1 Standard.",
    expected: "web_research_fanout",
  },
  {
    label: "code agent loop keyword",
    prompt: "Open the repo and refactor the auth flow, then run tests.",
    expected: "code_agent_loop",
  },
  {
    label: "code one-shot — short prompt with code block",
    prompt: "Fix this snippet:\n```ts\nconst x: number = '1';\n```",
    expected: "code_one_shot",
  },
  {
    label: "client copy keyword",
    prompt: "Draft a subject line for the spring newsletter.",
    expected: "client_copy",
  },
  {
    label: "strategy fallback",
    prompt: "Recommend an approach for handling the new pricing tiers.",
    expected: "strategy",
  },
  {
    label: "image generation keyword",
    prompt: "Create an image of a phoenix rising from a circuit board.",
    expected: "image",
  },
  {
    label: "video hero keyword",
    prompt: "We need a hero video for the home page.",
    expected: "video_hero",
  },
  {
    label: "voice agent keyword",
    prompt: "Build a realtime voice flow with our brand greeting.",
    expected: "voice",
  },
  {
    label: "vision via image attachment",
    prompt: "What's in this picture?",
    attachments: [{ kind: "image", mimeType: "image/png" }],
    expected: "vision",
  },
  {
    label: "default fallback when no heuristic matches",
    prompt: "Hello.",
    expected: "text",
  },
];

describe("classifier", () => {
  it.each(cases)("$label", (c) => {
    const result = classify({
      prompt: c.prompt,
      attachments: c.attachments,
      estimatedInputTokens: c.estimatedInputTokens,
      callerTaskClass: c.callerTaskClass,
      regulatedClientTag: c.regulatedClientTag,
    });
    expect(result.taskClass).toBe(c.expected);
  });

  it("respects extra regulated keywords from config", () => {
    const result = classify({
      prompt: "Run a SECRET_REG_TERM compliance pass.",
      extraRegulatedKeywords: ["secret_reg_term"],
    });
    expect(result.taskClass).toBe("compliance_review");
  });
});

// Expose the table for the report — list as `expected → actual`.
export const VALIDATION_TABLE = cases;
