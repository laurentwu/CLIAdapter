import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
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
  format: "json" | "jsonc" | "toml" | "yaml" | "text";
  schemaPath: string;
};
export type Repository = {
  root: string;
  catalog: Record<string, { api?: string; models?: Record<string, unknown> }>;
  clis: Array<{ id: string; directory: string; declarationPath: string; declaration: JsonObject; schemaPaths: string[] }>;
  providers: Array<{
    cliId: string;
    providerId: string;
    directory: string;
    metadataPath: string;
    metadata: JsonObject;
    mapping?: { kind: "builtin" | "custom"; provider: string };
  }>;
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
      case "jsonc": {
        const errors: ParseError[] = [];
        const value = parseJsonc(text, errors, {
          disallowComments: false,
          allowTrailingComma: true,
          allowEmptyContent: false,
        });
        // The parser can recover a value from malformed input; errors must still fail validation.
        if (errors.length) {
          const first = errors[0];
          throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
        }
        return value;
      }
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
  const credential = asObject(value);
  if (credential?.type === "api" && Object.hasOwn(credential, "key") && credential.key !== "<your-api-key>") {
    throw new Error(`${path}.key: must use <your-api-key>`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(apiKey|api_key|experimental_bearer_token)$/.test(key) || /_(API_KEY|AUTH_TOKEN)$/.test(key)) {
      if (child !== "<your-api-key>") throw new Error(`${path}.${key}: must use <your-api-key>`);
    }
    validatePlaceholders(child, `${path}.${key}`);
  }
}

function stringValues(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) stringValues(child, result);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) stringValues(child, result);
  }
  return result;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function expectedProviderIdentity(provider: Repository["providers"][number]): string {
  return provider.mapping?.provider ?? provider.providerId;
}

function assertProviderEndpoint(value: string, provider: Repository["providers"][number], path: string): void {
  let actual: URL;
  let canonical: URL;
  try {
    actual = new URL(value);
    canonical = new URL(provider.metadata.base_url as string);
  } catch {
    throw new Error(`${path}: invalid endpoint URL ${value}`);
  }
  const canonicalPath = canonical.pathname.replace(/\/+$/, "") || "/";
  const actualPath = actual.pathname.replace(/\/+$/, "") || "/";
  const extendsCanonicalPath = canonicalPath === "/" ||
    actualPath === canonicalPath || actualPath.startsWith(`${canonicalPath}/`);
  if (actual.origin !== canonical.origin || !extendsCanonicalPath) {
    throw new Error(`${path}: endpoint must use provider metadata base_url ${provider.metadata.base_url}`);
  }
}

function validateTemplateEndpoints(
  value: unknown,
  provider: Repository["providers"][number],
  path: string,
  key = "",
): void {
  if (typeof value === "string") {
    if (/^(?:url|base_?url|anthropic_base_url)$/i.test(key) && value !== "<base-url>") {
      assertProviderEndpoint(value, provider, path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateTemplateEndpoints(child, provider, `${path}[${index}]`, key));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      validateTemplateEndpoints(child, provider, `${path}.${childKey}`, childKey);
    }
  }
}

function validateProviderTemplateRelations(
  provider: Repository["providers"][number],
  template: Template,
  value: unknown,
): void {
  const object = asObject(value);
  const expectedIdentity = expectedProviderIdentity(provider);

  if (typeof value === "string") {
    const providerCommand = value.match(/(?:^|\n)provider add (\S+)/)?.[1];
    const modelProvider = value.match(/(?:^|\n)model add ([^/\s]+)\//)?.[1];
    if (providerCommand && providerCommand !== provider.providerId) {
      throw new Error(`${template.sourcePath}: provider command must use ${provider.providerId}`);
    }
    if (modelProvider && modelProvider !== provider.providerId) {
      throw new Error(`${template.sourcePath}: model command must use ${provider.providerId}`);
    }
    const baseUrl = value.match(/--base-url "([^"]+)"/)?.[1];
    if (baseUrl && baseUrl !== "<base-url>") {
      assertProviderEndpoint(baseUrl, provider, `${template.sourcePath} --base-url`);
    }
    return;
  }
  if (!object) return;

  if (typeof object.provider === "string" && typeof object.model === "string" && object.provider !== provider.providerId) {
    throw new Error(`${template.sourcePath}: provider reference must use ${provider.providerId}`);
  }

  if (typeof object.model_provider === "string" && asObject(object.model_providers)) {
    if (!Object.hasOwn(object.model_providers, object.model_provider)) {
      throw new Error(`${template.sourcePath}: model_provider must reference model_providers`);
    }
  }

  if (typeof object.active_provider === "string" && asObject(object.providers)) {
    if (object.active_provider !== provider.providerId || !Object.hasOwn(object.providers, provider.providerId)) {
      throw new Error(`${template.sourcePath}: active_provider must select ${provider.providerId}`);
    }
  }

  if (typeof object.defaultProvider === "string" && object.defaultProvider !== expectedIdentity) {
    throw new Error(`${template.sourcePath}: defaultProvider must use ${expectedIdentity}`);
  }

  if (asObject(object.modelProviders) && asObject(object.providerProtocol)) {
    if (!Object.hasOwn(object.modelProviders, provider.providerId) ||
        !Object.hasOwn(object.providerProtocol, provider.providerId)) {
      throw new Error(`${template.sourcePath}: provider maps must contain ${provider.providerId}`);
    }
    const environment = asObject(object.env) ?? {};
    for (const model of object.modelProviders[provider.providerId] as JsonObject[]) {
      if (!Object.hasOwn(environment, model.envKey)) {
        throw new Error(`${template.sourcePath}: model envKey ${model.envKey} must exist in env`);
      }
    }
  }

  if (asObject(object.providers) && asObject(object.models)) {
    if (!Object.hasOwn(object.providers, provider.providerId)) {
      throw new Error(`${template.sourcePath}: providers must contain ${provider.providerId}`);
    }
    for (const [alias, modelValue] of Object.entries(object.models)) {
      const model = asObject(modelValue);
      if (model && typeof model.provider === "string" &&
          (model.provider !== provider.providerId || !Object.hasOwn(object.providers, model.provider))) {
        throw new Error(`${template.sourcePath}: model ${alias} must reference provider ${provider.providerId}`);
      }
    }
  }

  if (template.fileName === "opencode.jsonc" && typeof object.model === "string" &&
      !object.model.startsWith(`${provider.providerId}/`)) {
    throw new Error(`${template.sourcePath}: model must use provider ${provider.providerId}`);
  }

  if (template.fileName === "auth.json" &&
      Object.values(object).every((credential) => asObject(credential))) {
    const keys = Object.keys(object);
    if (keys.length !== 1 || keys[0] !== expectedIdentity) {
      throw new Error(`${template.sourcePath}: credentials must use provider identity ${expectedIdentity}`);
    }
  }

  if (template.fileName === "custom-provider.json") {
    if (object.name !== provider.providerId) {
      throw new Error(`${template.sourcePath}: name must use provider ${provider.providerId}`);
    }
    if (typeof object.api_key_env === "string" && !provider.metadata.env.includes(object.api_key_env)) {
      throw new Error(`${template.sourcePath}: api_key_env must be declared by provider metadata`);
    }
    const expectedEngine = provider.metadata.protocol === "anthropic-messages" ? "anthropic" :
      provider.metadata.protocol === "openai-compatible" ? "openai" : undefined;
    if (expectedEngine && object.engine !== expectedEngine) {
      throw new Error(`${template.sourcePath}: engine must match provider protocol ${provider.metadata.protocol}`);
    }
  }

  if (template.fileName === "models.json" && asObject(object.providers)) {
    const keys = Object.keys(object.providers);
    if (keys.length && (keys.length !== 1 || keys[0] !== expectedIdentity)) {
      throw new Error(`${template.sourcePath}: providers must use provider identity ${expectedIdentity}`);
    }
  }

  if (Array.isArray(object.models) && Array.isArray(object.availableModels)) {
    const modelIds = new Set(object.models.map((model: JsonObject) => model.id));
    for (const modelId of object.availableModels) {
      if (!modelIds.has(modelId)) {
        throw new Error(`${template.sourcePath}: availableModels entry ${modelId} must reference models`);
      }
    }
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
  const parsedTemplates = new Map<string, unknown>();
  for (const template of repository.templates) {
    const value = parseTemplate(template);
    parsedTemplates.set(template.sourcePath, value);
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

  const providerPlaceholders = [
    "<provider-id>",
    "<provider-key>",
    "<provider-name>",
    "<npm-package>",
    "<base-url>",
  ];
  const modelPlaceholders = ["<model-id>", "<model-name>"];
  for (const cli of repository.clis) {
    const values = repository.templates
      .filter((template) => template.cliId === cli.id && template.level === "cli")
      .flatMap((template) => stringValues(parsedTemplates.get(template.sourcePath)));
    if (!modelPlaceholders.some((placeholder) => values.some((value) => value.includes(placeholder)))) {
      throw new Error(`${cli.directory}: CLI templates must use a model placeholder`);
    }
    if (!providerPlaceholders.some((placeholder) => values.some((value) => value.includes(placeholder)))) {
      throw new Error(`${cli.directory}: CLI templates must use a provider placeholder`);
    }
  }

  for (const provider of repository.providers) {
    const templates = repository.templates.filter((template) =>
      template.cliId === provider.cliId && template.providerId === provider.providerId,
    );
    const providerLevelTemplates = templates.filter((template) => template.level === "provider");
    const providerLevelValues = providerLevelTemplates
      .flatMap((template) => stringValues(parsedTemplates.get(template.sourcePath)));
    if (providerLevelTemplates.length &&
        !modelPlaceholders.some((placeholder) => providerLevelValues.some((value) => value.includes(placeholder)))) {
      throw new Error(`${provider.directory}: provider templates must use a model placeholder`);
    }
    for (const template of templates) {
      const value = parsedTemplates.get(template.sourcePath);
      validateTemplateEndpoints(value, provider, template.sourcePath);
      validateProviderTemplateRelations(provider, template, value);
    }
  }

  const modelGroups = new Map<string, Template[]>();
  for (const template of repository.templates.filter((entry) => entry.level === "model")) {
    const key = JSON.stringify([template.cliId, template.providerId, template.modelId]);
    modelGroups.set(key, [...(modelGroups.get(key) ?? []), template]);
  }
  for (const templates of modelGroups.values()) {
    const modelId = templates[0].modelId as string;
    const values = templates.flatMap((template) => stringValues(parsedTemplates.get(template.sourcePath)));
    const textReference = templates.some((template) => {
      const value = parsedTemplates.get(template.sourcePath);
      return typeof value === "string" && value.includes(`/${modelId}`);
    });
    if (!values.includes(modelId) && !textReference) {
      throw new Error(`${templates[0].sourcePath}: model override must reference concrete model ${modelId}`);
    }
  }
  return repository;
}
