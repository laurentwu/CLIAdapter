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
- `pi-provider-map.json` maps an `api.json` source provider ID to the PI-internal provider ID. Its source keys stay sorted, must exist in `api.json`, and use `kind: "builtin"` only for IDs verified against PI `v0.85.1` (`d981de1229ef899957bbe968bc8dcda02a21f477`). Missing mappings are unknown, not inferred by brand or name. A model placeholder must be replaced with an ID present both in the source provider's `api.json` catalog and the selected PI version; do not invent aliases or custom models when PI lacks that model.
- The seven existing PI provider directories split into five builtin templates (`deepseek`, `opencode`, `opencode-go`, `zai-coding-plan`, `zhipuai-coding-plan`) and two custom templates (`zai`, `zhipuai`). All PI `settings.json` templates only select the default provider and model. Generic and custom `models.json` model entries only declare `id`; other model properties use PI defaults. Builtin templates use the mapped PI ID consistently in `settings.json` and `auth.json`, while their required `models.json` is exactly an empty `providers` object so per-file resolution cannot fall back to the CLI-level custom-provider template. Custom templates keep credentials in `models.json` and have no `auth.json`; ordinary pay-as-you-go `zai` uses the collision-free internal ID `zai-api`, because PI's builtin `zai` means the international Coding Plan.

## Layout

- `${cli}/schemas/` — local JSON Schemas per config file (crush has none: its `crushrc` is a Bash script validated by text assertions).
- `${cli}/${provider}/provider.json` — provider metadata with a protocol-level canonical endpoint. CLI configuration files may still use a client-specific full request URL (for example, codebuddy and OpenAI-compatible goose configs include `/chat/completions`).
- Per-CLI template files: claude `settings.json`; codex `config.toml` + `models.json`; opencode CLI-level fallback `opencode.json` and provider-level `auth.json` + `opencode.json`; pi CLI-level fallback `settings.json` + `models.json`, builtin provider-level `settings.json` + `auth.json` + empty `models.json`, and custom provider-level `settings.json` + `models.json`; qwen `settings.json`; kimi `config.toml`; codebuddy `models.json`; crush `crushrc`; goose `config.yaml` + `custom-provider.json`. Model-level directories, when present, contain only the files needed for model-specific values or overrides.
- PI source directories and every `provider.json.id` always use the models.dev source ID, even when `pi-provider-map.json` selects a differently named PI builtin. External consumers resolve each file independently at `${cli}/${provider}/${model}/`, `${cli}/${provider}/`, then `${cli}/`; the map changes rendered PI-internal references, never lookup paths.

## Publishing

- `scripts/build-dist.mjs` copies templates, `LICENSE`, and `pi-provider-map.json` verbatim into `dist/`, then generates directory indexes and `providers.json`. It does not transform PI configs or add PI fields to `providers.json`.
- `api.json`, schemas, tests, and planning documents are source-only. `dist/` is generated and must not be committed.

## Testing

Run `npm test` (vitest). Tests validate schemas, api.json membership for every directory, and all applicable template levels.
