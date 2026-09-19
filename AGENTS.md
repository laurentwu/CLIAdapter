# AGENTS.md

## Overview

Static CLI configuration templates with offline validation and a publishing script. There is no application runtime.

## Repository layout

- `cli/` contains the CLI source trees. Every direct child directory is a CLI; there is no supported-CLI allowlist in tests or build code.
- `cli/<cli>/cli.json` describes that CLI's template files: purpose, format, local Schema, allowed levels, and required locations. It does not list supported providers/models or duplicate template values.
- `cli/<cli>/schemas/` contains local Schemas. JSON, TOML, and YAML templates are parsed before validation; text templates are validated as strings.
- `cli/<cli>/<file>` is a generic CLI-level fallback template declared by `cli.json`.
- `cli/<cli>/<provider>/provider.json` is required provider metadata, not a client configuration file. Its ID must match its directory and a top-level key in `api.json`.
- `cli/<cli>/<provider>/<file>` contains provider-level templates declared by `cli.json`.
- `cli/<cli>/<provider>/<model>/<file>` contains optional model-specific overrides. Model IDs must belong to that provider in `api.json`; IDs containing `/` use their relative path as the full ID. Intermediate directories are allowed only on the way to an existing model template.
- `schemas/` contains shared repository Schemas, including CLI declarations, provider metadata, and provider maps.
- `api.json` is the reference catalog and single source of truth for source provider/model IDs and OpenAI-compatible endpoints.
- `pi-provider-map.json` maps source provider IDs to PI-internal identities. It never changes source directory names or published lookup paths.
- `tests/` contains generic validation tests, independent fixtures, and versioned offline compatibility data. `scripts/` contains discovery and publishing utilities.
- `dist/` is generated and must not be committed. Do not create planning documents as part of implementation.

## File declarations and placement

- Discover CLI IDs from `cli/`, and providers/models within each CLI. Different CLIs may contain different providers and models. Adding or removing a whole CLI/provider must not require editing test or build allowlists.
- Every CLI must have a valid `cli.json`. Discover all directories before checking declarations: missing or invalid declarations must fail, not silently exclude a directory.
- Template filenames are single path components. `cli.json`, `provider.json`, and `schemas` are reserved. Undeclared files, misplaced metadata, and unsupported nesting fail validation.
- CLI trees belong under `cli/`; their directory names must not conflict with published root artifacts such as `providers.json` or `index.html`.
- A declaration's `levels` controls where a file may physically appear; `requiredAt` controls where it must physically exist. Model directories may override any permitted subset of files.
- A CLI can optionally reference a provider map. File declarations may use generic provider kinds to restrict applicability or select a Schema; do not enumerate provider IDs in these rules. Missing required mappings are errors, never inferred from names.
- Schema paths must resolve locally under the CLI's `schemas/` directory. All Schemas must compile offline, define `$id` and `$comment`, and have no remote `$ref` dependencies.
- Resolve each template file independently, highest priority first:
  1. `cli/<cli>/<provider>/<model>/<file>`
  2. `cli/<cli>/<provider>/<file>`
  3. `cli/<cli>/<file>`
- CLI-level templates use provider/model placeholders. Provider-level templates use real provider identities and normally model placeholders. Model-level overrides use concrete model values; absent files resolve from lower levels.
- Secrets use the literal `<your-api-key>`. Never commit real keys.

## Metadata and compatibility

- `provider.json.base_url` is the canonical endpoint for its protocol. The same provider and protocol must use the same endpoint everywhere. For `openai-compatible`, it must exactly match the provider's `api` field in `api.json`.
- Client configurations may use full request URLs where their format requires them. Metadata continues to hold the canonical protocol endpoint.
- PI map source keys are sorted and must exist in `api.json`. Builtin targets and alternatives must be present in versioned offline KnownProvider data; custom identities must not collide with builtin IDs. The map and compatibility data must identify the same version and commit.
- KnownProvider data is an upstream compatibility reference, not a list of providers this repository must support. Do not duplicate it as expected arrays or require a fixed mapping count.
- PI builtin credentials belong in `auth.json`. A provider-level empty `models.json` blocks fallback to the generic custom-provider template. Custom providers keep credentials in `models.json` and have no `auth.json`. Declare these file/kind rules and Schema differences in `cli.json`, rather than branching on provider names in tests.
- Concrete PI models must be available in both the source catalog and selected PI version; do not invent aliases to fill catalog gaps.

## Publishing

- Discover CLI trees from `cli/` and publish them as `dist/<cli>/...`. The source-only `cli/` parent must not appear in published URLs.
- Copy declared templates, provider metadata, `LICENSE`, and `pi-provider-map.json` verbatim. Generate directory indexes and `providers.json` from discovered data without transforming client configurations.
- `cli.json`, `api.json`, Schemas, tests, scripts, and documentation are source-only. Publish only the declared templates and provider metadata, explicitly named root artifacts, and generated indexes/catalog.
- Preserve existing published paths and index presentation when changing source organization.

## Testing

- Run `npm test` for offline validation and `npm run build` to verify publishing.
- Validate declarations, placement, required files, local Schemas, catalog membership, metadata/reference consistency, independent per-file fallback, and published output.
- Do not assert fixed supported CLI/provider/model lists, provider counts, protocol counts, complete configuration snapshots, chosen model/tuning defaults, JSON key order, or review dates. Schema constraints describe valid formats, not copies of today's template values.
- Use independent synthetic fixtures to show that new CLI/provider directories are discovered without test changes and that malformed layouts, unknown IDs, missing required files, invalid configurations, and conflicting metadata fail with useful paths.
- Test schema acceptance/rejection and build behavior with small meaningful fixtures. Expected results for synthetic examples are appropriate; duplicating the real catalog or templates as expected results is not.
