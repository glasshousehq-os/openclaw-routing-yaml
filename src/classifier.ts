/**
 * Deterministic task classifier.
 *
 * Pure TypeScript — NO LLM calls, NO external API, NO network.
 *
 * Input: prompt text + optional attachments + optional caller config
 *        (regulated tag, explicit task-class override, extra keywords).
 * Output: one task class. First match wins, top-to-bottom.
 *
 * Heuristics taken from GLA-26 spec; tuned to produce the right class
 * with zero ambiguity for the 10 validation prompts in the test suite.
 */

export type TaskClass =
  | "code_agent_loop"
  | "code_one_shot"
  | "long_context_recall"
  | "web_research_fanout"
  | "compliance_review"
  | "client_copy"
  | "strategy"
  | "bulk_classify"
  | "ner_structured_extraction"
  | "image"
  | "video_hero"
  | "video_social_bulk"
  | "voice"
  | "vision"
  | "text";

export interface ClassifyInput {
  prompt: string;
  attachments?: Array<{
    kind: "image" | "video" | "audio" | "document" | "other";
    mimeType?: string;
  }>;
  /** Total estimated input tokens (prompt + prior history). */
  estimatedInputTokens?: number;
  /** Explicit caller override. Skips heuristics when set. */
  callerTaskClass?: TaskClass;
  /** Caller marks the agent as serving a regulated client (TGA/AHPRA/AFSL/etc.). */
  regulatedClientTag?: boolean;
  /** Extra case-insensitive keywords that mark the prompt as compliance_review. */
  extraRegulatedKeywords?: string[];
}

export interface ClassifyResult {
  taskClass: TaskClass;
  /** Short reason for logs/audit. */
  reason: string;
}

// -------------------------------------------------------------------------
// Keyword + threshold constants
// -------------------------------------------------------------------------

const LONG_CONTEXT_TOKEN_THRESHOLD = 100_000;
const ONE_SHOT_MAX_CHARS = 2_000; // ~500 tokens at 4 chars/token

const REGULATED_KEYWORDS = [
  "tga",
  "ahpra",
  "afsl",
  "asic",
  "regulated",
  "schedule 4",
  "schedule 8",
  "scheduled drug",
  "compliance",
  "spam act",
  "privacy act",
  "ndis",
  "qsc",
];

const CODE_AGENT_KEYWORDS = [
  "run the test",
  "run tests",
  "fix this bug",
  "debug",
  "refactor",
  "apply the patch",
  "edit the file",
  "open the repo",
  "build the project",
  "agent loop",
];

const WEB_RESEARCH_KEYWORDS = [
  "search the web",
  "research",
  "find sources",
  "find recent",
  "look up",
  "latest news",
  "web search",
];

const CLIENT_COPY_KEYWORDS = [
  "draft",
  "write copy",
  "headline",
  "email",
  "subject line",
  "ad copy",
  "landing page copy",
  "newsletter",
  "social caption",
];

const STRATEGY_KEYWORDS = [
  "strategy",
  "plan",
  "trade-off",
  "trade off",
  "recommend",
  "decide",
  "architect",
  "options for",
  "approach",
];

const MEDIA_KEYWORDS = {
  video_hero: ["hero video", "tvc", "brand film"],
  video_social_bulk: ["social video", "tiktok", "reel", "bulk video"],
  image: ["generate an image", "create an image", "image of", "thumbnail", "logo concept"],
  voice: ["voice agent", "tts", "speak this", "realtime voice"],
} as const;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function containsAny(text: string, needles: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return n;
  }
  return null;
}

function hasCodeBlockMarkdown(prompt: string): boolean {
  // Triple-backtick fence, with or without a language hint.
  return /```[\s\S]*?```/.test(prompt);
}

function hasImageAttachment(input: ClassifyInput): boolean {
  return (input.attachments ?? []).some((a) => a.kind === "image");
}

function hasVideoOrAudioAttachment(input: ClassifyInput): boolean {
  return (input.attachments ?? []).some((a) => a.kind === "video" || a.kind === "audio");
}

// -------------------------------------------------------------------------
// Classifier
// -------------------------------------------------------------------------

export function classify(input: ClassifyInput): ClassifyResult {
  // 0. Explicit caller override always wins (NER from Graphiti, etc.).
  if (input.callerTaskClass) {
    return {
      taskClass: input.callerTaskClass,
      reason: `caller_task_class=${input.callerTaskClass}`,
    };
  }

  const prompt = input.prompt ?? "";
  const extraRegulated = (input.extraRegulatedKeywords ?? []).map((k) => k.toLowerCase());

  // 1. Compliance review — regulated client tag OR regulated keywords.
  //    Beats everything else because the cost of getting this wrong is
  //    brand-and-licence damage (SOUL.md client-brand HARD RULE).
  if (input.regulatedClientTag) {
    return {
      taskClass: "compliance_review",
      reason: "regulated_client_tag=true",
    };
  }
  const regHit =
    containsAny(prompt, REGULATED_KEYWORDS) ?? containsAny(prompt, extraRegulated);
  if (regHit) {
    return {
      taskClass: "compliance_review",
      reason: `regulated_keyword=${regHit}`,
    };
  }

  // 2. Media routing — attachments and explicit keywords short-circuit before
  //    the long-context / code paths.
  if (hasVideoOrAudioAttachment(input)) {
    // Default to social bulk; callers wanting hero video can pass callerTaskClass.
    const heroHit = containsAny(prompt, MEDIA_KEYWORDS.video_hero);
    if (heroHit) {
      return { taskClass: "video_hero", reason: `media_keyword=${heroHit}` };
    }
    return { taskClass: "video_social_bulk", reason: "video_or_audio_attachment" };
  }
  const videoHeroHit = containsAny(prompt, MEDIA_KEYWORDS.video_hero);
  if (videoHeroHit) {
    return { taskClass: "video_hero", reason: `media_keyword=${videoHeroHit}` };
  }
  const videoSocialHit = containsAny(prompt, MEDIA_KEYWORDS.video_social_bulk);
  if (videoSocialHit) {
    return { taskClass: "video_social_bulk", reason: `media_keyword=${videoSocialHit}` };
  }
  const voiceHit = containsAny(prompt, MEDIA_KEYWORDS.voice);
  if (voiceHit) {
    return { taskClass: "voice", reason: `media_keyword=${voiceHit}` };
  }
  const imageHit = containsAny(prompt, MEDIA_KEYWORDS.image);
  if (imageHit) {
    return { taskClass: "image", reason: `media_keyword=${imageHit}` };
  }
  if (hasImageAttachment(input) && !hasCodeBlockMarkdown(prompt)) {
    // Image understanding (NOT generation). Goes to vision.
    return { taskClass: "vision", reason: "image_attachment_no_code" };
  }

  // 3. Long-context recall — total estimated input above the threshold.
  const tokens = input.estimatedInputTokens ?? 0;
  if (tokens > LONG_CONTEXT_TOKEN_THRESHOLD) {
    return {
      taskClass: "long_context_recall",
      reason: `estimated_input_tokens=${tokens}>${LONG_CONTEXT_TOKEN_THRESHOLD}`,
    };
  }

  // 4. Web research fanout — explicit keywords.
  const webHit = containsAny(prompt, WEB_RESEARCH_KEYWORDS);
  if (webHit) {
    return { taskClass: "web_research_fanout", reason: `web_keyword=${webHit}` };
  }

  // 5. Code routing — code-block markdown + short prompt = one-shot.
  //    Agent-loop keywords short-circuit to code_agent_loop.
  const codeAgentHit = containsAny(prompt, CODE_AGENT_KEYWORDS);
  if (codeAgentHit) {
    return { taskClass: "code_agent_loop", reason: `code_agent_keyword=${codeAgentHit}` };
  }
  if (hasCodeBlockMarkdown(prompt) && prompt.length <= ONE_SHOT_MAX_CHARS) {
    return {
      taskClass: "code_one_shot",
      reason: `code_block_md AND prompt_len=${prompt.length}<=${ONE_SHOT_MAX_CHARS}`,
    };
  }
  if (hasCodeBlockMarkdown(prompt)) {
    return { taskClass: "code_agent_loop", reason: "code_block_md AND prompt_too_long" };
  }

  // 6. Client copy — explicit keywords AND not regulated.
  const copyHit = containsAny(prompt, CLIENT_COPY_KEYWORDS);
  if (copyHit) {
    return { taskClass: "client_copy", reason: `client_copy_keyword=${copyHit}` };
  }

  // 7. Strategy — orchestrator-style prompts.
  const strategyHit = containsAny(prompt, STRATEGY_KEYWORDS);
  if (strategyHit) {
    return { taskClass: "strategy", reason: `strategy_keyword=${strategyHit}` };
  }

  // 8. Default fallback — generic text.
  return { taskClass: "text", reason: "no_heuristic_matched" };
}
