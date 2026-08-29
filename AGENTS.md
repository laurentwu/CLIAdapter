# AGENTS.md

## Overview

Static CLI configuration templates with offline JSON Schema validation tests. No runtime code.

## Rules

- `api.json` is the reference catalog and the single source of truth: `provider_id` must be a top-level key, `model_id` must be listed under that provider.
- Config templates live at two levels; each file resolves by priority (highest first):
  1. `${cli}/${provider}/`
  2. `${cli}/`
- There are no model-level directories: available models are read from `api.json` per provider.
- The cli level is a generic fallback: provider-level templates keep real provider values and use model placeholders (`<model-id>`, `<model-name>`); cli-level templates also use provider placeholders (`<provider-id>`, `<provider-key>`, `<provider-name>`, `<npm-package>`, `<base-url>`).
- Secrets always use the literal placeholder `<Your API Key>`. Never commit real keys.
- `provider.json` `base_url` must stay on the same host as the provider's `api` field in `api.json` (guards against provider mix-ups, e.g. bigmodel.cn vs z.ai).

## Layout

- `${cli}/schemas/` — local JSON Schemas per config file.
- `${cli}/${provider}/provider.json` — provider metadata (base URL must exclude the client-appended path).
- Per-CLI template files: claude `settings.json`; codex `config.toml` + `models.json`; opencode `opencode.json`; pi `settings.json` + `models.json`.

## Testing

Run `npm test` (vitest). Tests validate schemas, api.json membership for every directory, and both template levels.
