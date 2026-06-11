# openclaw-routing-yaml

> An OpenClaw plugin that routes each agent turn to a model picked by a declarative `routing.yaml` file.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What it does

OpenClaw lets you set one primary model per agent. That's fine for a hobby
setup, but real agencies and production fleets want **different models for
different task classes** — code-loop work on Codex, long-context recall on
Gemini, reasoning on Opus, web research on Sonar Pro — without forking core
or writing one-off provider switches per agent.

`openclaw-routing-yaml` is a **single drop-in plugin** that does this declaratively:

1. **You write a `routing.yaml`** describing your defaults, guardrails, and
   per-task-class rules (see [`examples/routing.example.yaml`](examples/routing.example.yaml)).
2. **The plugin hooks `before_model_resolve`** — the OpenClaw seam designed
   for this exact use-case ([openclaw/openclaw#91060](https://github.com/openclaw/openclaw/issues/91060)).
3. **For every agent turn**, the plugin classifies the prompt (deterministic
   heuristics — no LLM call), looks up the matching rule, and returns a
   `modelOverride` (and optionally `providerOverride`).

It is **plugin-only** — zero modifications to OpenClaw core, install through
ClawHub or npm.

## Why a YAML file

- **Versioned, lint-able, reviewable.** Routing decisions live in source
  control. Diffs are obvious. PRs can review them.
- **Same shape across all your agents.** One config, every agent on your
  fleet gets consistent routing.
- **Org-policy friendly.** Encode quarantined models, compliance routing
  (TGA/AHPRA/AFSL/etc.), cost-cliff thresholds, and degraded-mode behaviour
  declaratively instead of scattering them across agent prompts.

## Features

| | |
|---|---|
| Hook | `before_model_resolve` (typed plugin hook) |
| Classifier | Deterministic, ~200 LoC, **no LLM calls** |
| Schema | Zod-validated YAML with cross-file invariant checks |
| Quarantine guardrails | Sonnet/Haiku blocked unless rule sets `requires_approval` |
| Cost-cliff warnings | Structured events when projected tokens cross GPT-5.5 272K / Gemini 200K (configurable per model) |
| Degraded mode | Regulated-client tag + primary unreachable → `PARK_AND_NOTIFY` event, no silent fallback |
| Fail-soft | Missing/invalid YAML → log warning, plugin no-ops, orchestrator default wins |
| Runtime cost | One YAML read at gateway start, then pure-CPU classify+lookup per turn |

## Install

```bash
# Via ClawHub (once published).
openclaw plugins install clawhub:@glasshousehq/openclaw-routing-yaml

# Or via npm (pin the version explicitly).
openclaw plugins install npm:@glasshousehq/openclaw-routing-yaml@0.1.1

# Or local development.
openclaw plugins install --link ./openclaw-routing-yaml
```

After install, restart the gateway:

```bash
openclaw gateway restart
```

Verify the runtime registration:

```bash
openclaw plugins inspect routing-yaml --runtime --json
```

You should see `before_model_resolve` listed under registered hooks.

## Configure

### 1. Write `routing.yaml`

Put it at `~/.openclaw/workspace/routing.yaml` (default path) or wherever
you prefer. Start from the sanitised example:

```bash
cp node_modules/openclaw-routing-yaml/examples/routing.example.yaml \
   ~/.openclaw/workspace/routing.yaml
```

Then edit the model ids, regulated clients, and thresholds to match your
fleet. See the [example file](examples/routing.example.yaml) for the full
shape and the comments inside [`src/schema.ts`](src/schema.ts) for the
authoritative Zod schema.

### 2. Enable the plugin

```json5
{
  plugins: {
    entries: {
      "routing-yaml": {
        enabled: true,
        // (Optional) any of these — see configSchema in openclaw.plugin.json.
        config: {
          routingYamlPath: "~/.openclaw/workspace/routing.yaml",
          // Mark this agent as serving a regulated client so degraded-mode
          // park-and-notify fires on primary outage.
          regulatedClientTag: false,
          // Optional family-name -> provider id map; usually unset.
          // providerMap: { "opus-4.7": "anthropic", "gpt-5.3-codex": "openai" },
          // Optional Graphiti-style explicit task class override.
          // callerTaskClass: "ner_structured_extraction",
        },
        hooks: {
          // before_model_resolve is a conversation-access hook, so this is
          // REQUIRED for non-bundled plugins. See OpenClaw plugin docs.
          allowConversationAccess: true,
        },
      },
    },
  },
}
```

### 3. Path resolution order

The plugin resolves `routing.yaml` in this order:

1. `plugins.entries["routing-yaml"].config.routingYamlPath` (explicit)
2. `ROUTING_YAML_PATH` environment variable
3. `~/.openclaw/workspace/routing.yaml` (default)

If none of those exist, the plugin **logs a warning and no-ops** — the
orchestrator's own default model is used.

## Task classifier

The classifier is **deterministic** and **runs zero LLM calls**. Heuristics,
in priority order:

1. `callerTaskClass` (explicit override — used by e.g. Graphiti for NER)
2. `regulatedClientTag: true` OR prompt contains regulated keywords (`tga`, `ahpra`, `afsl`, `asic`, `regulated`, `ndis`, `qsc`, etc.) → `compliance_review`
3. Video/audio attachment OR media keywords (`hero video`, `tiktok`, `voice agent`, `create an image`) → media class
4. Image attachment without code block → `vision`
5. Total estimated input tokens > 100,000 → `long_context_recall`
6. Web research keywords (`search the web`, `research`, `find sources`, etc.) → `web_research_fanout`
7. Code-agent keywords (`open the repo`, `run tests`, `refactor`) → `code_agent_loop`
8. Code block markdown AND prompt ≤ 2,000 chars → `code_one_shot` (else `code_agent_loop`)
9. Copy keywords (`draft`, `write copy`, `headline`, `email`, `subject line`) → `client_copy`
10. Strategy keywords (`strategy`, `plan`, `recommend`, `approach`) → `strategy`
11. Default → `text`

Source: [`src/classifier.ts`](src/classifier.ts).

## Quarantined models

Routes pointing at any model id whose family prefix is `sonnet*` or `haiku*`
are quarantined by default. The plugin will **emit a `QUARANTINE_BLOCKED`
event and skip the override** unless the rule explicitly sets
`requires_approval: blake`. If the rule provides `fallback_on_decline`, the
plugin routes there instead; otherwise the orchestrator's default wins.

Named-exceptions in `routing.yaml` document approved carve-outs (e.g.
Graphiti NER) but **do not by themselves unlock a route at runtime** —
a rule still needs `requires_approval` to take a quarantined model. This
mirrors the Pydantic lint at [glasshouse/os/routing/schema.py](../glasshouse/os/routing/schema.py).

## Cost-cliff warnings

When a model id matches a `guardrails.cost_cliff_warn.<key>` entry AND the
caller-supplied `estimateInputTokens()` returns a value at-or-above the
threshold, the plugin emits a structured `COST_CLIFF_WARN` event with the
threshold, estimated tokens, and the human-readable note from the YAML.

The plugin doesn't ship a default token estimator — it accepts one through
the runtime config. v1.1 will plumb the orchestrator's token-budget signal
into this surface automatically.

## Degraded mode

When `regulatedClientTag: true` AND the runtime signals
`isPrimaryUnreachable: () => true`, the plugin returns a **null override**
(orchestrator default-of-last-resort wins) AND emits a `PARK_AND_NOTIFY`
event carrying `notifyChannel` from the YAML.

Non-regulated agents skip park-and-notify; the orchestrator's own provider
failover stack handles them.

## Events emitted

| Kind | When | Caller should |
|---|---|---|
| `COST_CLIFF_WARN` | Routed model crosses a configured token threshold | Log, optionally surface to operator |
| `QUARANTINE_BLOCKED` | Rule routed to Sonnet/Haiku without approval | Already handled by plugin (fallback applied) — log for audit |
| `APPROVAL_REQUIRED` | Rule routed to Sonnet/Haiku with `requires_approval` | Surface an approval card with `fallback_on_decline` as the alternative |
| `PARK_AND_NOTIFY` | Regulated client + primary unreachable | Stop the turn, message the user via `notifyChannel`, alert Blake |

Wire your handler via `runtime.emit` in your plugin config (the default
emitter logs each event through `api.logger`).

## Development

```bash
pnpm install
pnpm lint   # tsc --noEmit (strict mode, no `any`)
pnpm test   # vitest
pnpm build  # tsc -> dist/
```

60 unit tests covering schema, classifier, router, loader, and the plugin
integration surface.

## Architecture decisions

- **Plugin-only, no core fork** — per maintainer ruling on
  [openclaw/openclaw#91060](https://github.com/openclaw/openclaw/issues/91060).
- **Deterministic classifier** — adding an LLM call inside the hook would
  double-bill every turn. Heuristics + caller-provided overrides are enough.
- **`use:` and `pipeline:` rules** — `pipeline:` returns its FIRST step as
  the override; the orchestrator drives later stages via its own subagent
  spawning (Anthropic enforces depth=1).
- **No silent fallback to Sonnet/Haiku** — anywhere, ever. Lint AND runtime
  refuse.

## Release notes

### v0.1.1 (2026-06-11)

Fix: the v0.1.0 plugin entry used a top-level `await` to lazily resolve the
host SDK. ESM permits top-level await, but the resulting `dist/index.js`
failed to load under the OpenClaw plugin loader with:

```
SyntaxError: await is only valid in async functions and the top level bodies of modules
```

v0.1.1 refactors the entry to a fully synchronous module shape:

- `openclaw` is now declared as an optional `peerDependency` (`>=2026.4.0`)
  so it stays host-provided.
- `definePluginEntry` is resolved synchronously via `createRequire` at
  module-load time. No top-level await.
- Library-mode fallback preserved: if the host SDK isn't installed (unit
  tests, standalone library use), the entry identity-passes the definition.
- All 60 existing tests pass unchanged; public API is identical to v0.1.0.

No behaviour changes — routing.yaml, classifier, hook semantics, and emitted
events are identical to v0.1.0.

### v0.1.0 (2026-06-11)

Initial public release.

## License

[MIT](LICENSE) — © 2026 Glasshouse Group.
