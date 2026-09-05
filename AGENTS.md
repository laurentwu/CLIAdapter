# AGENTS.md

## Overview

Static CLI configuration templates with offline JSON Schema validation tests. No runtime code.

## Rules

- `api.json` is the reference catalog and the single source of truth: `provider_id` must be a top-level key, `model_id` must be listed under that provider.
- Config templates live at three levels; each file resolves by priority (highest first):
  1. `${cli}/${provider}/${model}/`
  2. `${cli}/${provider}/`
  3. `${cli}/`
- Templates may be defined at the CLI, provider, and model levels. The CLI level is a generic fallback and uses provider/model placeholders. Provider-level templates keep real provider values and normally use model placeholders (`<model-id>`, `<model-name>`). Model-level templates, when present, provide concrete model values or overrides; files not present at that level continue to resolve from lower levels. CLI-level templates also use provider placeholders (`<provider-id>`, `<provider-key>`, `<provider-name>`, `<npm-package>`, `<base-url>`).
- Secrets always use the literal placeholder `<your-api-key>`. Never commit real keys.
- `provider.json` `base_url` is the canonical endpoint for its protocol. Every `provider.json` file for the same provider and protocol must use the same value; `openai-compatible` values must exactly match the provider's `api` field in `api.json`.
- OpenCode providers present in `api.json`/models.dev use provider-level `auth.json` for credentials and provider-level `opencode.json` only to select the default model. Only the CLI-level fallback declares a custom provider through `opencode.json.provider`.

## Layout

- `${cli}/schemas/` — local JSON Schemas per config file (crush has none: its `crushrc` is a Bash script validated by text assertions).
- `${cli}/${provider}/provider.json` — provider metadata with a protocol-level canonical endpoint. CLI configuration files may still use a client-specific full request URL (for example, codebuddy and OpenAI-compatible goose configs include `/chat/completions`).
- Per-CLI template files: claude `settings.json`; codex `config.toml` + `models.json`; opencode CLI-level fallback `opencode.json` and provider-level `auth.json` + `opencode.json`; pi `settings.json` + `models.json`; qwen `settings.json`; kimi `config.toml`; codebuddy `models.json`; crush `crushrc`; goose `config.yaml` + `custom-provider.json`. Model-level directories, when present, contain only the files needed for model-specific values or overrides.

## Testing

Run `npm test` (vitest). Tests validate schemas, api.json membership for every directory, and all applicable template levels.
