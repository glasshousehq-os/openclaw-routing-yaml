---
name: openclaw-routing-yaml
description: Route each OpenClaw agent turn to a different model per task class (code, long-context, web research, compliance, copy, strategy, etc.) using a declarative routing.yaml. Use when you want deterministic per-task model selection with cost-cliff warnings, quarantined-model guards, and regulated-client park-and-notify behavior.
---

# OpenClaw Routing YAML

A plugin for [OpenClaw](https://openclaw.ai) that classifies each agent turn and routes it to the model chosen by a declarative `routing.yaml` file. Implements the `before_model_resolve` hook.

## When to use

- You want different models for different task classes (code vs long-context vs strategy vs copy) without hard-coding per-call overrides.
- You need cost-cliff warnings when a turn crosses a context threshold for an expensive model.
- You need quarantined-model approval gates (e.g. block a model unless an explicit named exception applies).
- You run regulated client workloads that need park-and-notify rather than silent fallback.

## Install

```bash
npm install -g @glasshousehq/openclaw-routing-yaml
```

Then register the plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "routing-yaml": {
        "enabled": true,
        "config": {
          "routingYamlPath": "/absolute/path/to/routing.yaml"
        },
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

`allowConversationAccess: true` is required — the hook reads conversation content to classify the turn. Restart the gateway after editing the config.

## routing.yaml shape

See `examples/routing.example.yaml` in the repo for a fully commented example. Minimum shape:

```yaml
version: 1
default_model: anthropic/claude-opus-4-7
rules:
  - task_class: code_agent_loop
    model: anthropic/claude-sonnet-4-6
  - task_class: long_context_recall
    model: google/gemini-2.5-pro
```

The classifier covers: `text`, `code_agent_loop`, `code_one_shot`, `long_context_recall`, `web_research_fanout`, `compliance_review`, `client_copy`, `strategy`, and more — see `src/classifier.ts` for the full list.

## Links

- **npm:** [@glasshousehq/openclaw-routing-yaml](https://www.npmjs.com/package/@glasshousehq/openclaw-routing-yaml)
- **GitHub:** [glasshousehq-os/openclaw-routing-yaml](https://github.com/glasshousehq-os/openclaw-routing-yaml)
- **OpenClaw discussion:** [issue #91060](https://github.com/openclaw/openclaw/issues/91060)

## License

MIT.
