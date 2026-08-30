# AGENTS.md

## Overview

Static CLI configuration templates with offline JSON Schema validation tests. No runtime code.

## Rules

- `api.json` is the reference catalog and the single source of truth: `provider_id` must be a top-level key, `model_id` must be listed under that provider.
- Config templates live at two levels; each file resolves by priority (highest first):
  1. `${cli}/${provider}/`
  2. `${cli}/`
- Templates are normally provider-level; the sole model-level exception is `codex/deepseek/<model-id>/models.json`, which stores concrete Codex model metadata. These model directories contain no `config.toml`; the runtime catalog remains the provider-level `models.json`.
- The cli level is a generic fallback: provider-level templates keep real provider values and normally use model placeholders (`<model-id>`, `<model-name>`). The Codex DeepSeek `config.toml` follows the official concrete default model while its provider-level `models.json` remains wildcard-based. Cli-level templates also use provider placeholders (`<provider-id>`, `<provider-key>`, `<provider-name>`, `<npm-package>`, `<base-url>`).
- Secrets always use the literal placeholder `<Your API Key>`. Never commit real keys.
- `provider.json` `base_url` must stay on the same host as the provider's `api` field in `api.json` (guards against provider mix-ups, e.g. bigmodel.cn vs z.ai).

## Layout

- `${cli}/schemas/` — local JSON Schemas per config file (crush has none: its `crushrc` is a Bash script validated by text assertions).
- `${cli}/${provider}/provider.json` — provider metadata (base URL must exclude the client-appended path; codebuddy and OpenAI-compatible goose configs take the full endpoint URL, so `base_url` includes `/chat/completions`; Anthropic goose configs use the `/api/anthropic` endpoint).
- Per-CLI template files: claude `settings.json`; codex `config.toml` + `models.json` (plus the DeepSeek model-level `models.json` exception); opencode `opencode.json`; pi `settings.json` + `models.json`; qwen `settings.json`; kimi `config.toml`; codebuddy `models.json`; crush `crushrc`; goose `config.yaml` + `custom-provider.json`.

## Testing

Run `npm test` (vitest). Tests validate schemas, api.json membership for every directory, and both template levels.
