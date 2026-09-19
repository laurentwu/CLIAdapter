import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
// @ts-expect-error Build utilities are dependency-free JavaScript.
import { discoverRepository as discover, readJson, schemaPaths } from "../../scripts/repository.mjs";

export const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export type JsonObject = Record<string, any>;
export type Template = {
  sourcePath: string;
  publishedPath: string;
  fileName: string;
  cliId: string;
  providerId?: string;
  modelId?: string;
  level: "cli" | "provider" | "model";
  format: "json" | "toml" | "yaml" | "text";
  schemaPath: string;
};
export type Repository = {
  root: string;
  catalog: Record<string, { api?: string; models?: Record<string, unknown> }>;
  clis: Array<{ id: string; directory: string; declarationPath: string; declaration: JsonObject; schemaPaths: string[] }>;
  providers: Array<{ cliId: string; providerId: string; directory: string; metadataPath: string; metadata: JsonObject }>;
  templates: Template[];
  artifacts: Array<{ sourcePath: string; publishedPath: string }>;
};

export function assertValid(validate: ValidateFunction, value: unknown, path: string): void {
  if (!validate(value)) throw new Error(`${path}: ${JSON.stringify(validate.errors)}`);
}

function assertLocalRefs(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && /^(?:https?:)?\/\//.test(child)) {
      throw new Error(`${path}: remote $ref is not allowed: ${child}`);
    }
    assertLocalRefs(child, path);
  }
}

export class SchemaRegistry {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(paths: string[]) {
    const draft7 = new Ajv({ allErrors: true, strict: true });
    const draft2020 = new Ajv2020({ allErrors: true, strict: true });
    const ids = new Set<string>();
    const registered = paths.map((path) => {
      const schema = readJson(path) as JsonObject;
      if (!schema || typeof schema.$id !== "string" || !schema.$id || typeof schema.$comment !== "string" || !schema.$comment) {
        throw new Error(`${path}: Schema must define $id and $comment`);
      }
      if (ids.has(schema.$id)) throw new Error(`${path}: duplicate Schema ID ${schema.$id}`);
      ids.add(schema.$id);
      assertLocalRefs(schema, path);
      const ajv = schema.$schema?.includes("2020-12") ? draft2020 : draft7;
      ajv.addSchema(schema as AnySchema);
      return { path, id: schema.$id as string, ajv };
    });
    // Register all local IDs before compilation so local cross-schema references work offline.
    for (const { path, id, ajv } of registered) {
      try {
        const validator = ajv.getSchema(id);
        if (!validator) throw new Error(`unresolved Schema ${id}`);
        this.validators.set(path, validator);
      } catch (error) {
        throw new Error(`${path}: ${String(error)}`);
      }
    }
  }

  validate(path: string, value: unknown, label = path): void {
    const validator = this.validators.get(path);
    if (!validator) throw new Error(`${label}: unregistered Schema ${path}`);
    assertValid(validator, value, `${label} (${path})`);
  }
}

export function discoverRepository(root = rootDir): Repository {
  const declarationValidator = new Ajv({ allErrors: true, strict: true }).compile(
    readJson(join(root, "schemas", "cli.schema.json")),
  );
  return discover(root, {
    validateDeclaration: (path: string, declaration: unknown) => assertValid(declarationValidator, declaration, path),
  }) as Repository;
}

export function parseTemplate(template: Template): unknown {
  const text = readFileSync(template.sourcePath, "utf8");
  try {
    switch (template.format) {
      case "json": return JSON.parse(text);
      case "toml": return parseToml(text);
      case "yaml": return parseYaml(text);
      case "text": return text;
    }
  } catch (error) {
    throw new Error(`${template.sourcePath}: ${String(error)}`);
  }
}

function validatePlaceholders(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(apiKey|api_key|experimental_bearer_token)$/.test(key) || /_(API_KEY|AUTH_TOKEN)$/.test(key)) {
      if (child !== "<your-api-key>") throw new Error(`${path}.${key}: must use <your-api-key>`);
    }
    validatePlaceholders(child, `${path}.${key}`);
  }
}

function endpointHost(value: string, path: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    throw new Error(`${path}: invalid endpoint URL ${value}`);
  }
}

export function validateRepository(root = rootDir): Repository {
  const repository = discoverRepository(root);
  const registry = new SchemaRegistry([
    ...schemaPaths(join(root, "schemas")),
    ...repository.clis.flatMap((cli) => cli.schemaPaths),
  ]);
  const endpoints = new Map<string, string>();
  const identities = new Map<string, string>();
  for (const provider of repository.providers) {
    const { metadata, metadataPath, providerId } = provider;
    registry.validate(join(root, "schemas", "provider.schema.json"), metadata, metadataPath);
    const canonicalApi = repository.catalog[providerId].api;
    if (!canonicalApi || endpointHost(metadata.base_url, metadataPath) !== endpointHost(canonicalApi, `${root}/api.json (${providerId})`)) {
      throw new Error(`${metadataPath}: endpoint host must match api.json`);
    }
    if (metadata.protocol === "openai-compatible" && metadata.base_url !== canonicalApi) {
      throw new Error(`${metadataPath}: endpoint must exactly match api.json`);
    }
    const key = `${providerId}:${metadata.protocol}`;
    if (endpoints.has(key) && endpoints.get(key) !== metadata.base_url) {
      throw new Error(`${metadataPath}: inconsistent canonical endpoint for ${key}`);
    }
    endpoints.set(key, metadata.base_url);
    const identity = JSON.stringify([metadata.name, [...metadata.env].sort()]);
    if (identities.has(providerId) && identities.get(providerId) !== identity) {
      throw new Error(`${metadataPath}: inconsistent provider name or env`);
    }
    identities.set(providerId, identity);
  }
  for (const template of repository.templates) {
    const value = parseTemplate(template);
    registry.validate(template.schemaPath, value, template.sourcePath);
    validatePlaceholders(value, template.sourcePath);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (template.level !== "cli" && /<(provider-id|provider-key|provider-name|npm-package|base-url)>/.test(text)) {
      throw new Error(`${template.sourcePath}: provider placeholders belong at CLI level`);
    }
    if (template.level === "model" && /<(model-id|model-name)>/.test(text)) {
      throw new Error(`${template.sourcePath}: model overrides must contain concrete model values`);
    }
  }
  return repository;
}
