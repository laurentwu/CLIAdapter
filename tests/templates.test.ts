import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;
type CliId =
  | "claude"
  | "codex"
  | "opencode"
  | "pi"
  | "qwen"
  | "kimi"
  | "codebuddy"
  | "crush"
  | "goose";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

type ApiCatalog = Record<string, { api?: string; models?: Record<string, unknown> }>;
const apiCatalog = readJson(join(rootDir, "api.json")) as ApiCatalog;

type PiProviderMapping = {
  kind: "builtin" | "custom";
  provider: string;
  alternatives?: string[];
};
type PiProviderMap = {
  mappings: Record<string, PiProviderMapping>;
};
const piProviderMap = readJson(join(rootDir, "pi-provider-map.json")) as PiProviderMap;

const allProviders = [
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
  "deepseek",
  "opencode",
  "opencode-go",
];

const claudeProviderIds = [
  "deepseek",
  "opencode",
  "opencode-go",
  "zai",
  "zai-coding-plan",
  "zhipuai",
  "zhipuai-coding-plan",
] as const;
type ClaudeProviderId = (typeof claudeProviderIds)[number];
type ClaudeTemplateId = "cli" | ClaudeProviderId;

const claudeEnvOrder = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "API_TIMEOUT_MS",
] as const;

const claudeExpectedEnv: Record<ClaudeTemplateId, JsonObject> = {
  cli: {
    ANTHROPIC_BASE_URL: "<base-url>",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>",
    CLAUDE_CODE_SUBAGENT_MODEL: "<model-id>",
  },
  deepseek: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "<model-id>",
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
  },
  opencode: {
    ANTHROPIC_BASE_URL: "https://opencode.ai/zen",
    ANTHROPIC_API_KEY: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
  },
  "opencode-go": {
    ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
    ANTHROPIC_API_KEY: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
  },
  zai: {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
  },
  "zai-coding-plan": {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
  },
  zhipuai: {
    ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
  },
  "zhipuai-coding-plan": {
    ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
    ANTHROPIC_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "<model-id>",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "<model-id>",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
  },
};

const codexDeepSeekModelIds = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
].sort();

const anthropicProviders = new Set([
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
]);

const coverage: Record<CliId, readonly string[]> = {
  claude: [...allProviders],
  codex: [...allProviders],
  opencode: [...allProviders],
  pi: [...allProviders],
  qwen: [...allProviders],
  kimi: [...allProviders],
  codebuddy: [...allProviders],
  crush: [...allProviders],
  goose: [...allProviders],
};

const cliLevelFileSchemas: Partial<Record<CliId, Record<string, string>>> = {
  claude: {
    "settings.json": "claude/schemas/settings.schema.json",
  },
  codex: {
    "config.toml": "codex/schemas/config.schema.json",
    "models.json": "codex/schemas/models.schema.json",
  },
  opencode: {
    "opencode.json": "opencode/schemas/opencode.schema.json",
  },
  pi: {
    "models.json": "pi/schemas/models.schema.json",
    "settings.json": "pi/schemas/settings.schema.json",
  },
  qwen: {
    "settings.json": "qwen/schemas/settings.schema.json",
  },
  kimi: {
    "config.toml": "kimi/schemas/config.schema.json",
  },
  codebuddy: {
    "models.json": "codebuddy/schemas/models.schema.json",
  },
  goose: {
    "config.yaml": "goose/schemas/config.schema.json",
    "custom-provider.json": "goose/schemas/custom-provider.schema.json",
  },
};

const providerLevelFileSchemas: Partial<Record<CliId, Record<string, string>>> = {
  ...cliLevelFileSchemas,
  opencode: {
    "auth.json": "opencode/schemas/auth.schema.json",
    "opencode.json": "opencode/schemas/opencode.schema.json",
  },
};

const requiredFiles: Record<CliId, readonly string[]> = {
  claude: ["settings.json"],
  codex: ["config.toml", "models.json"],
  opencode: ["auth.json", "opencode.json"],
  pi: ["models.json", "settings.json"],
  qwen: ["settings.json"],
  kimi: ["config.toml"],
  codebuddy: ["models.json"],
  crush: ["crushrc"],
  goose: ["config.yaml", "custom-provider.json"],
};

function schemasForProvider(cliId: CliId, providerId: string): Record<string, string> {
  const schemas = providerLevelFileSchemas[cliId] ?? {};
  if (cliId === "pi" && piProviderMap.mappings[providerId]?.kind === "builtin") {
    return {
      ...schemas,
      "auth.json": "pi/schemas/auth.schema.json",
    };
  }
  return schemas;
}

function filesForProvider(cliId: CliId, providerId: string): readonly string[] {
  if (cliId === "pi" && piProviderMap.mappings[providerId]?.kind === "builtin") {
    return [...requiredFiles.pi, "auth.json"];
  }
  return requiredFiles[cliId];
}

const clientAppendedSuffix: Record<CliId, string> = {
  claude: "/v1/messages",
  codex: "/responses",
  opencode: "/chat/completions",
  pi: "/chat/completions",
  qwen: "/chat/completions",
  kimi: "/chat/completions",
  codebuddy: "",
  crush: "/chat/completions",
  goose: "",
};

const ajvDraft7 = new Ajv({ allErrors: true, strict: true });
const ajv2020 = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map<string, ValidateFunction>();

function readJson(filePath: string): JsonObject {
  return JSON.parse(readFileSync(filePath, "utf8")) as JsonObject;
}

function listDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function findRemoteRefs(value: unknown, path = "$", result: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRemoteRefs(item, `${path}[${index}]`, result));
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "$ref" && typeof child === "string" && /^https?:\/\//.test(child)) {
        result.push(`${childPath}=${child}`);
      }
      findRemoteRefs(child, childPath, result);
    }
  }
  return result;
}

function getValidator(schemaPath: string): ValidateFunction {
  const cached = validators.get(schemaPath);
  if (cached) return cached;

  const schema = readJson(join(rootDir, schemaPath)) as AnySchema & JsonObject;
  expect(typeof schema.$id, `${schemaPath} must define $id`).toBe("string");
  expect(typeof schema.$comment, `${schemaPath} must define $comment`).toBe("string");
  expect(findRemoteRefs(schema), `${schemaPath} contains a remote $ref`).toEqual([]);

  const schemaDialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const ajv = schemaDialect.includes("2020-12") ? ajv2020 : ajvDraft7;
  const validator = ajv.compile(schema);
  validators.set(schemaPath, validator);
  return validator;
}

function parseTemplate(filePath: string): JsonObject {
  if (filePath.endsWith(".toml")) {
    return parseToml(readFileSync(filePath, "utf8")) as JsonObject;
  }
  if (filePath.endsWith(".yaml")) {
    return parseYaml(readFileSync(filePath, "utf8")) as JsonObject;
  }
  return readJson(filePath);
}

function validateTemplate(filePath: string, schemaPath: string): JsonObject {
  const value = parseTemplate(filePath);
  const validator = getValidator(schemaPath);
  if (!validator(value)) {
    throw new Error(
      `${filePath} failed ${schemaPath}: ${JSON.stringify(validator.errors, null, 2)}`,
    );
  }
  return value;
}

function assertBaseUrlWithoutAppendedSuffix(
  value: unknown,
  suffix: string,
  label: string,
): void {
  if (!suffix) return;
  expect(typeof value, `${label} must be a URL string`).toBe("string");
  if (typeof value !== "string") return;

  const normalized = value.replace(/\/+$/, "");
  expect(
    normalized.endsWith(suffix),
    `${label} must stop before the client-appended ${suffix} path`,
  ).toBe(false);
}

function assertNoUnexpectedSecret(value: unknown, path = "$", key?: string): void {
  const secretKeys = new Set([
    "apiKey",
    "api_key",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "experimental_bearer_token",
  ]);
  if (key && secretKeys.has(key)) {
    expect(value, `${path} must keep the manual placeholder`).toBe("<your-api-key>");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnexpectedSecret(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertNoUnexpectedSecret(childValue, `${path}.${childKey}`, childKey);
    }
  }
}

function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

function assertBaseUrlHost(value: unknown, expectedHost: string, label: string): void {
  expect(typeof value, `${label} must be a URL string`).toBe("string");
  if (typeof value !== "string") return;
  expect(
    hostnameOf(value),
    `${label} must stay on the ${expectedHost} host to avoid provider mix-ups`,
  ).toBe(expectedHost);
}

function assertUrlUsesCanonicalBase(
  value: unknown,
  canonicalBase: unknown,
  label: string,
): void {
  expect(typeof value, `${label} must be a URL string`).toBe("string");
  expect(typeof canonicalBase, `${label} canonical base must be a URL string`).toBe("string");
  if (typeof value !== "string" || typeof canonicalBase !== "string") return;

  const normalizedValue = value.replace(/\/+$/, "");
  const normalizedBase = canonicalBase.replace(/\/+$/, "");
  expect(
    normalizedValue === normalizedBase || normalizedValue.startsWith(`${normalizedBase}/`),
    `${label} must use the provider.json canonical base`,
  ).toBe(true);
}

function assertClaudeSettingsPolicy(
  templateId: ClaudeTemplateId,
  settings: JsonObject,
  providerInfo?: JsonObject,
): void {
  const label = templateId === "cli" ? "claude/settings.json" : `claude/${templateId}/settings.json`;
  const expectedEnv = claudeExpectedEnv[templateId];
  const expectedEnvKeys = claudeEnvOrder.filter((key) =>
    Object.prototype.hasOwnProperty.call(expectedEnv, key),
  );

  expect(Object.keys(settings), `${label} root key order must remain stable`).toEqual([
    "$schema",
    "model",
    "env",
  ]);
  expect(settings.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
  expect(settings.model).toBe("<model-id>");
  expect(Object.keys(settings.env ?? {}), `${label} env key order must remain stable`).toEqual(
    expectedEnvKeys,
  );
  expect(settings.env, `${label} must retain its reviewed provider policy`).toEqual(expectedEnv);

  const authenticationKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter(
    (key) => Object.prototype.hasOwnProperty.call(settings.env ?? {}, key),
  );
  expect(authenticationKeys, `${label} must use exactly one authentication mechanism`).toHaveLength(
    1,
  );
  expect(settings.env[authenticationKeys[0]], `${label} must keep the secret placeholder`).toBe(
    "<your-api-key>",
  );

  if (templateId === "cli") {
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("<base-url>");
    return;
  }

  expect(providerInfo, `${label} must have provider metadata`).toBeTruthy();
  if (!providerInfo) return;
  expect(providerInfo.protocol, `${label} must use Anthropic Messages metadata`).toBe(
    "anthropic-messages",
  );
  expect(
    settings.env.ANTHROPIC_BASE_URL,
    `${label} endpoint must exactly match provider.json.base_url`,
  ).toBe(providerInfo.base_url);
  expect(settings.env.ANTHROPIC_BASE_URL.endsWith("/"), `${label} endpoint has a trailing slash`).toBe(
    false,
  );
  assertBaseUrlWithoutAppendedSuffix(
    settings.env.ANTHROPIC_BASE_URL,
    "/v1/messages",
    `${label}.env.ANTHROPIC_BASE_URL`,
  );
  assertBaseUrlHost(
    settings.env.ANTHROPIC_BASE_URL,
    hostnameOf(apiCatalog[templateId]?.api as string),
    `${label}.env.ANTHROPIC_BASE_URL`,
  );
}

function assertProviderTemplateIdentity(
  cli: CliId,
  providerId: string,
  parsedByFile: Record<string, JsonObject>,
): void {
  const apiHost = hostnameOf(apiCatalog[providerId]?.api as string);

  if (cli === "claude") {
    const settings = parsedByFile["settings.json"];
    const providerInfo = readJson(join(rootDir, cli, providerId, "provider.json"));
    assertClaudeSettingsPolicy(
      providerId as ClaudeProviderId,
      settings,
      providerInfo,
    );
    return;
  }

  if (cli === "codex") {
    const config = parsedByFile["config.toml"];
    if (providerId === "deepseek") {
      expect(config.model).toBe("deepseek-v4-flash");
      expect(config.model_provider).toBe("deepseek");
      expect(config.preferred_auth_method).toBe("apikey");
      expect(config.forced_login_method).toBe("api");
      expect(config.model_reasoning_effort).toBe("high");
      expect(config.model_catalog_json).toBe("~/.codex/models.json");
      expect(config.model_providers.deepseek.name).toBe("deepseek");
      expect(config.model_providers.deepseek.base_url).toBe("https://api.deepseek.com/");
      expect(config.model_providers.deepseek.wire_api).toBe("responses");
    }
    expect(
      Object.keys(config.model_providers as JsonObject),
      `${cli}/${providerId}/config.toml.model_provider must be a declared model_providers key`,
    ).toContain(config.model_provider);
    for (const [providerKey, provider] of Object.entries(config.model_providers as JsonObject)) {
      assertBaseUrlHost(
        (provider as JsonObject).base_url,
        apiHost,
        `${cli}/${providerId}/config.toml.model_providers.${providerKey}.base_url`,
      );
    }
    return;
  }

  if (cli === "opencode") {
    const config = parsedByFile["opencode.json"];
    const auth = parsedByFile["auth.json"];
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: `${providerId}/<model-id>`,
    });
    expect(config.provider).toBeUndefined();
    expect(Object.keys(auth)).toEqual([providerId]);
    expect(auth[providerId]).toEqual({
      type: "api",
      key: "<your-api-key>",
    });
    return;
  }

  if (cli === "pi") {
    const mapping = piProviderMap.mappings[providerId];
    const settings = parsedByFile["settings.json"];
    const models = parsedByFile["models.json"];
    const providerInfo = readJson(join(rootDir, cli, providerId, "provider.json"));

    expect(mapping, `${cli}/${providerId} must have a provider mapping`).toBeTruthy();
    expect(settings).toEqual({
      defaultProvider: mapping.provider,
      defaultModel: "<model-id>",
    });

    if (mapping.kind === "builtin") {
      const auth = parsedByFile["auth.json"];
      expect(models).toEqual({ providers: {} });
      expect(Object.keys(auth)).toEqual([mapping.provider]);
      expect(auth[mapping.provider]).toEqual({
        type: "api_key",
        key: "<your-api-key>",
      });
      expect(
        auth[mapping.provider].key,
        `${cli}/${providerId}/auth.json must keep the manual placeholder`,
      ).toBe("<your-api-key>");
    } else {
      expect(Object.keys(models.providers)).toEqual([mapping.provider]);
      const customProvider = models.providers[mapping.provider];
      expect(customProvider).toEqual({
        baseUrl: providerInfo.base_url,
        api: "openai-completions",
        apiKey: "<your-api-key>",
        models: [{ id: "<model-id>" }],
      });
      assertBaseUrlHost(
        customProvider.baseUrl,
        apiHost,
        `${cli}/${providerId}/models.json.providers.${mapping.provider}.baseUrl`,
      );
      assertUrlUsesCanonicalBase(
        customProvider.baseUrl,
        providerInfo.base_url,
        `${cli}/${providerId}/models.json.providers.${mapping.provider}.baseUrl`,
      );
      expect(customProvider.baseUrl).toBe(providerInfo.base_url);
      expect(customProvider.api).toBe("openai-completions");
      expect(customProvider.apiKey).toBe("<your-api-key>");
      expect(customProvider.models).toHaveLength(1);
      expect(customProvider.models[0]).toEqual({ id: "<model-id>" });
    }
    return;
  }

  if (cli === "qwen") {
    const settings = parsedByFile["settings.json"];
    expect(
      settings.providerProtocol?.[providerId],
      `${cli}/${providerId}/settings.json.providerProtocol.${providerId} must map to the openai protocol`,
    ).toBe("openai");
    const models = settings.modelProviders?.[providerId];
    expect(
      Array.isArray(models),
      `${cli}/${providerId}/settings.json.modelProviders.${providerId} must be a model array`,
    ).toBe(true);
    for (const [index, model] of (models ?? []).entries()) {
      assertBaseUrlHost(
        model.baseUrl,
        apiHost,
        `${cli}/${providerId}/settings.json.modelProviders.${providerId}[${index}].baseUrl`,
      );
      expect(
        Object.keys(settings.env ?? {}),
        `${cli}/${providerId}/settings.json.modelProviders.${providerId}[${index}].envKey must have a matching settings.json.env entry`,
      ).toContain(model.envKey);
    }
    for (const [envKey, envValue] of Object.entries(settings.env ?? {})) {
      expect(
        envValue,
        `${cli}/${providerId}/settings.json.env.${envKey} must keep the manual placeholder`,
      ).toBe("<your-api-key>");
    }
    return;
  }

  if (cli === "kimi") {
    const config = parsedByFile["config.toml"];
    const provider = config.providers?.[providerId];
    expect(
      provider?.type,
      `${cli}/${providerId}/config.toml.providers.${providerId}.type must use the OpenAI-compatible protocol`,
    ).toBe("openai");
    assertBaseUrlHost(
      provider?.base_url,
      apiHost,
      `${cli}/${providerId}/config.toml.providers.${providerId}.base_url`,
    );
    const modelEntries = Object.entries<JsonObject>(config.models ?? {});
    expect(
      modelEntries.length,
      `${cli}/${providerId}/config.toml.models must declare at least one model alias`,
    ).toBeGreaterThan(0);
    for (const [alias, model] of modelEntries) {
      expect(
        model.provider,
        `${cli}/${providerId}/config.toml.models.${alias}.provider must reference the provider`,
      ).toBe(providerId);
    }
    return;
  }

  if (cli === "codebuddy") {
    const config = parsedByFile["models.json"];
    const providerInfo = readJson(join(rootDir, cli, providerId, "provider.json"));
    expect(
      Array.isArray(config.models),
      `${cli}/${providerId}/models.json.models must be an array`,
    ).toBe(true);
    for (const [index, model] of (config.models ?? []).entries()) {
      assertBaseUrlHost(
        model.url,
        apiHost,
        `${cli}/${providerId}/models.json.models[${index}].url`,
      );
      expect(
        model.url.replace(/\/+$/, "").endsWith("/chat/completions"),
        `${cli}/${providerId}/models.json.models[${index}].url must be the full chat completions endpoint`,
      ).toBe(true);
      assertUrlUsesCanonicalBase(
        model.url,
        providerInfo.base_url,
        `${cli}/${providerId}/models.json.models[${index}].url`,
      );
    }
    if (providerId === "deepseek") {
      expect(config.availableModels).toEqual(["<model-id>"]);
      for (const model of config.models ?? []) {
        expect(model.url).toBe("https://api.deepseek.com/v1/chat/completions");
        expect(model.maxInputTokens).toBe(128000);
        expect(model.maxOutputTokens).toBe(8192);
      }
    }
    return;
  }

  if (cli === "goose") {
    const config = parsedByFile["config.yaml"];
    const provider = parsedByFile["custom-provider.json"];
    const providerInfo = readJson(join(rootDir, cli, providerId, "provider.json"));
    expect(
      config.active_provider,
      `${cli}/${providerId}/config.yaml.active_provider must select the provider`,
    ).toBe(providerId);
    expect(
      config.providers?.[providerId]?.model,
      `${cli}/${providerId}/config.yaml.providers.${providerId}.model must use a model placeholder`,
    ).toBe("<model-id>");
    expect(
      provider.name,
      `${cli}/${providerId}/custom-provider.json.name must be the provider id`,
    ).toBe(providerId);
    const usesAnthropic = anthropicProviders.has(providerId);
    expect(
      provider.engine,
      `${cli}/${providerId}/custom-provider.json.engine must use the documented protocol engine`,
    ).toBe(usesAnthropic ? "anthropic" : "openai");
    expect(
      providerInfo.protocol,
      `${cli}/${providerId}/provider.json.protocol must match the documented protocol`,
    ).toBe(usesAnthropic ? "anthropic-messages" : "openai-compatible");
    assertBaseUrlHost(
      provider.base_url,
      apiHost,
      `${cli}/${providerId}/custom-provider.json.base_url`,
    );
    const normalizedBaseUrl = provider.base_url.replace(/\/+$/, "");
    if (usesAnthropic) {
      expect(
        normalizedBaseUrl.endsWith("/api/anthropic"),
        `${cli}/${providerId}/custom-provider.json.base_url must be the Anthropic endpoint`,
      ).toBe(true);
    } else {
      expect(
        normalizedBaseUrl.endsWith("/chat/completions"),
        `${cli}/${providerId}/custom-provider.json.base_url must be the full chat completions endpoint`,
      ).toBe(true);
    }
    assertUrlUsesCanonicalBase(
      provider.base_url,
      providerInfo.base_url,
      `${cli}/${providerId}/custom-provider.json.base_url`,
    );
    return;
  }

  expect(parsedByFile["settings.json"]?.defaultProvider).toBe(providerId);
  assertBaseUrlHost(
    parsedByFile["models.json"]?.providers?.[providerId]?.baseUrl,
    apiHost,
    `${cli}/${providerId}/models.json.providers.${providerId}.baseUrl`,
  );
}

describe("repository schemas", () => {
  it("contains the nine planned CLI roots and all local schemas compile offline", () => {
    const cliIds: CliId[] = [
      "claude",
      "codex",
      "opencode",
      "pi",
      "qwen",
      "kimi",
      "codebuddy",
      "crush",
      "goose",
    ];
    for (const cliId of cliIds) {
      expect(existsSync(join(rootDir, cliId)), `${cliId} CLI root must exist`).toBe(true);
    }
    for (const cliId of Object.keys(cliLevelFileSchemas) as CliId[]) {
      expect(listDirectories(join(rootDir, cliId))).toContain("schemas");
      const schemaPaths = new Set([
        ...Object.values(cliLevelFileSchemas[cliId] ?? {}),
        ...Object.values(providerLevelFileSchemas[cliId] ?? {}),
      ]);
      if (cliId === "pi") {
        schemaPaths.add("pi/schemas/auth.schema.json");
        schemaPaths.add("pi/schemas/provider-map.schema.json");
      }
      for (const schemaPath of schemaPaths) {
        getValidator(schemaPath);
      }
    }
  });

  it("keeps the declared CLI/provider coverage and provider assets", () => {
    const canonicalEndpoints = new Map<string, string>();

    for (const cliId of Object.keys(coverage) as CliId[]) {
      const cliRoot = join(rootDir, cliId);
      const actualProviders = listDirectories(cliRoot).filter((name) => name !== "schemas");
      expect(actualProviders).toEqual([...coverage[cliId]].sort());

      for (const providerId of actualProviders) {
        const apiEntry = apiCatalog[providerId];
        expect(
          apiEntry,
          `${cliId}/${providerId} must be a provider id in api.json`,
        ).toBeTruthy();

        const providerRoot = join(cliRoot, providerId);
        const modelDirectories = listDirectories(providerRoot);
        const expectedModelDirectories =
          cliId === "codex" && providerId === "deepseek"
            ? codexDeepSeekModelIds
            : [];
        expect(
          modelDirectories,
          `${cliId}/${providerId} must only contain the explicitly supported model-level directories`,
        ).toEqual(expectedModelDirectories);
        expect(listFiles(providerRoot)).toEqual(
          [...filesForProvider(cliId, providerId), "provider.json"].sort(),
        );

        for (const modelId of modelDirectories) {
          const modelRoot = join(providerRoot, modelId);
          expect(
            listFiles(modelRoot),
            `${cliId}/${providerId}/${modelId} must contain only models.json`,
          ).toEqual(["models.json"]);
          const modelCatalog = validateTemplate(
            join(modelRoot, "models.json"),
            "codex/schemas/models.schema.json",
          );
          assertNoUnexpectedSecret(modelCatalog);
          expect(modelCatalog.models).toHaveLength(1);
          const model = modelCatalog.models[0] as JsonObject;
          expect(model.slug).toBe(modelId);
          expect(apiEntry.models).toHaveProperty(modelId);
          expect(JSON.stringify(model)).not.toContain("<model-id>");
          expect(JSON.stringify(model)).not.toContain("<model-name>");
          if (modelId === "deepseek-v4-flash-vision-exp") {
            expect(model.input_modalities).toContain("image");
            expect(model.supports_image_detail_original).toBe(true);
          }
        }

        const providerInfo = readJson(join(providerRoot, "provider.json"));
        expect(providerInfo.id).toBe(providerId);
        expect(typeof providerInfo.protocol).toBe("string");
        assertBaseUrlWithoutAppendedSuffix(
          providerInfo.base_url,
          clientAppendedSuffix[cliId],
          `${cliId}/${providerId}/provider.json.base_url`,
        );
        expect(
          apiEntry?.api,
          `${cliId}/${providerId} must define a valid api url in api.json`,
        ).toBeTruthy();
        expect(
          hostnameOf(providerInfo.base_url),
          `${cliId}/${providerId}/provider.json.base_url must stay on the api.json host to avoid provider mix-ups`,
        ).toBe(hostnameOf(apiEntry?.api as string));
        if (providerInfo.protocol === "openai-compatible") {
          expect(
            providerInfo.base_url,
            `${cliId}/${providerId}/provider.json.base_url must use the canonical api.json endpoint`,
          ).toBe(apiEntry.api);
        }

        const endpointKey = `${providerId}:${providerInfo.protocol}`;
        const existingEndpoint = canonicalEndpoints.get(endpointKey);
        if (existingEndpoint) {
          expect(
            providerInfo.base_url,
            `${endpointKey} must use one canonical endpoint across all provider.json files`,
          ).toBe(existingEndpoint);
        } else {
          canonicalEndpoints.set(endpointKey, providerInfo.base_url);
        }
      }
    }
  });
});

describe("Claude settings templates", () => {
  const settingsSchemaPath = "claude/schemas/settings.schema.json";

  function settingsPath(templateId: ClaudeTemplateId): string {
    return templateId === "cli"
      ? join(rootDir, "claude", "settings.json")
      : join(rootDir, "claude", templateId, "settings.json");
  }

  function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function minimalSettings(env: JsonObject, extra: JsonObject = {}): JsonObject {
    return {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      model: "<model-id>",
      env,
      ...extra,
    };
  }

  function resolveTemplateFile(
    cliId: string,
    providerId: string,
    modelId: string,
    fileName: string,
    pathExists: (path: string) => boolean = existsSync,
  ): string | undefined {
    return [
      join(rootDir, cliId, providerId, modelId, fileName),
      join(rootDir, cliId, providerId, fileName),
      join(rootDir, cliId, fileName),
    ].find(pathExists);
  }

  it("keeps every reviewed template policy, key order, and JSON formatting exact", () => {
    const templateIds: ClaudeTemplateId[] = ["cli", ...claudeProviderIds];

    for (const templateId of templateIds) {
      const filePath = settingsPath(templateId);
      const text = readFileSync(filePath, "utf8");
      const settings = readJson(filePath);
      const providerInfo =
        templateId === "cli"
          ? undefined
          : readJson(join(rootDir, "claude", templateId, "provider.json"));

      assertClaudeSettingsPolicy(templateId, settings, providerInfo);
      expect(text, `${filePath} must use two-space JSON, LF, and one final newline`).toBe(
        `${JSON.stringify(settings, null, 2)}\n`,
      );
      expect(text, `${filePath} must not contain CRLF line endings`).not.toContain("\r");
    }

    for (const providerId of claudeProviderIds) {
      const providerPath = join(rootDir, "claude", providerId, "provider.json");
      const providerInfo = readJson(providerPath);
      expect(
        Object.keys(providerInfo),
        `claude/${providerId}/provider.json metadata key order must remain stable`,
      ).toEqual(["id", "name", "env", "protocol", "base_url", "docs"]);
      expect(listDirectories(join(rootDir, "claude", providerId))).toEqual([]);
    }

    const deepSeek = readJson(settingsPath("deepseek"));
    expect(deepSeek.model).toBe("<model-id>");
    expect(deepSeek.env.ANTHROPIC_MODEL).toBe("<model-id>[1m]");
    expect(deepSeek.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("<model-id>");
    expect(deepSeek.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("<model-id>[1m]");
    expect(deepSeek.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("<model-id>[1m]");
    expect(deepSeek.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("<model-id>");

    const schemaText = readFileSync(join(rootDir, settingsSchemaPath), "utf8");
    expect(schemaText).toBe(
      `${JSON.stringify(readJson(join(rootDir, settingsSchemaPath)), null, 2)}\n`,
    );
    expect(schemaText).not.toContain("\r");
  });

  it("rejects provider-policy regressions through the shared semantic assertion", () => {
    const openCode = readJson(settingsPath("opencode"));
    const openCodeProvider = readJson(join(rootDir, "claude", "opencode", "provider.json"));

    // Both official Messages routes read x-api-key at this pinned revision:
    // https://github.com/anomalyco/opencode/blob/3dd1b3053979971d8eb03ef37b29de07b892d95c/packages/console/app/src/routes/zen/v1/messages.ts#L9
    // https://github.com/anomalyco/opencode/blob/3dd1b3053979971d8eb03ef37b29de07b892d95c/packages/console/app/src/routes/zen/go/v1/messages.ts#L9
    const bearerOpenCode = cloneJson(openCode);
    delete bearerOpenCode.env.ANTHROPIC_API_KEY;
    bearerOpenCode.env.ANTHROPIC_AUTH_TOKEN = "<your-api-key>";
    expect(() =>
      assertClaudeSettingsPolicy("opencode", bearerOpenCode, openCodeProvider),
    ).toThrow();

    for (const wrongEndpoint of [
      "https://opencode.ai/not-zen",
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/zen/v1/messages/v1/messages",
    ]) {
      const changedEndpoint = cloneJson(openCode);
      changedEndpoint.env.ANTHROPIC_BASE_URL = wrongEndpoint;
      expect(
        () => assertClaudeSettingsPolicy("opencode", changedEndpoint, openCodeProvider),
        `${wrongEndpoint} must not pass the Claude endpoint policy`,
      ).toThrow();
    }

    const deepSeek = readJson(settingsPath("deepseek"));
    const deepSeekProvider = readJson(join(rootDir, "claude", "deepseek", "provider.json"));
    for (const [field, wrongValue] of [
      ["ANTHROPIC_MODEL", "<model-id>"],
      ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "<model-id>[1m]"],
      ["CLAUDE_CODE_SUBAGENT_MODEL", "<model-id>[1m]"],
    ] as const) {
      const changedModel = cloneJson(deepSeek);
      changedModel.env[field] = wrongValue;
      expect(
        () => assertClaudeSettingsPolicy("deepseek", changedModel, deepSeekProvider),
        `DeepSeek ${field} regression must fail`,
      ).toThrow();
    }

    const glmProviders = ["zai", "zai-coding-plan", "zhipuai", "zhipuai-coding-plan"] as const;
    const glmRuntimeFields = [
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "API_TIMEOUT_MS",
    ] as const;
    for (const providerId of glmProviders) {
      const settings = readJson(settingsPath(providerId));
      const providerInfo = readJson(join(rootDir, "claude", providerId, "provider.json"));
      for (const field of glmRuntimeFields) {
        const missingParameter = cloneJson(settings);
        delete missingParameter.env[field];
        expect(
          () => assertClaudeSettingsPolicy(providerId, missingParameter, providerInfo),
          `${providerId} must retain ${field}`,
        ).toThrow();
      }
    }

    const reorderedRoot = {
      model: deepSeek.model,
      $schema: deepSeek.$schema,
      env: deepSeek.env,
    };
    expect(() =>
      assertClaudeSettingsPolicy("deepseek", reorderedRoot, deepSeekProvider),
    ).toThrow();

    const reorderedEnv = cloneJson(deepSeek);
    reorderedEnv.env = Object.fromEntries(Object.entries(reorderedEnv.env).reverse());
    expect(() =>
      assertClaudeSettingsPolicy("deepseek", reorderedEnv, deepSeekProvider),
    ).toThrow();
  });

  it("accepts both authentication modes, compression boundaries, URLs, and overrides", () => {
    const validator = getValidator(settingsSchemaPath);
    const schema = readJson(join(rootDir, settingsSchemaPath));

    expect(schema.$id).toBe("urn:cli-config:claude:settings:v2");
    expect(schema.$comment).toContain("2026-09-18");
    expect(schema.$comment).toContain("https://code.claude.com/docs/en/settings");
    expect(schema.$comment).toContain("https://code.claude.com/docs/en/model-config");
    expect(schema.$comment).toContain("https://code.claude.com/docs/en/env-vars");

    expect(
      validator(
        minimalSettings(
          {
            ANTHROPIC_BASE_URL: "<base-url>",
            ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
            ANTHROPIC_MODEL: "example-model",
            CLAUDE_CODE_EFFORT_LEVEL: "auto",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "enabled",
            API_TIMEOUT_MS: "1",
          },
          { modelOverrides: { sonnet: "example-sonnet" } },
        ),
      ),
    ).toBe(true);
    expect(
      validator(
        minimalSettings({
          ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
          ANTHROPIC_API_KEY: "<your-api-key>",
          ANTHROPIC_MODEL: "example-model",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "example-haiku",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "example-sonnet",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "example-opus",
          CLAUDE_CODE_SUBAGENT_MODEL: "example-subagent",
          CLAUDE_CODE_EFFORT_LEVEL: "max",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
          API_TIMEOUT_MS: "3000000",
        }),
      ),
    ).toBe(true);
  });

  it("rejects invalid authentication, fields, types, URLs, and tuning values", () => {
    const validator = getValidator(settingsSchemaPath);
    const validEnv = {
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "<your-api-key>",
      ANTHROPIC_MODEL: "example-model",
    };
    const invalidSettings: Array<[string, JsonObject]> = [
      [
        "missing authentication",
        minimalSettings({
          ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
          ANTHROPIC_MODEL: "example-model",
        }),
      ],
      [
        "duplicate authentication",
        minimalSettings({ ...validEnv, ANTHROPIC_API_KEY: "<your-api-key>" }),
      ],
      [
        "wrong API key placeholder",
        minimalSettings({
          ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
          ANTHROPIC_API_KEY: "real-or-fake-key",
          ANTHROPIC_MODEL: "example-model",
        }),
      ],
      [
        "wrong token placeholder",
        minimalSettings({ ...validEnv, ANTHROPIC_AUTH_TOKEN: "real-or-fake-key" }),
      ],
      ["unknown root field", { ...minimalSettings(validEnv), unknown: true }],
      ["unknown env field", minimalSettings({ ...validEnv, UNKNOWN: "value" })],
      [
        "misspelled env field",
        minimalSettings({ ...validEnv, ANTHROPIC_MODELL: "example-model" }),
      ],
      ["non-object env", minimalSettings("not-an-object" as unknown as JsonObject)],
      ["non-string env value", minimalSettings({ ...validEnv, ANTHROPIC_MODEL: 1 })],
      ["empty top-level model", { ...minimalSettings(validEnv), model: "" }],
      ["empty env model", minimalSettings({ ...validEnv, ANTHROPIC_MODEL: "" })],
      ["invalid URL scheme", minimalSettings({ ...validEnv, ANTHROPIC_BASE_URL: "ftp://api.example.com" })],
      ["URL containing whitespace", minimalSettings({ ...validEnv, ANTHROPIC_BASE_URL: "https://api.example.com/a b" })],
      ["invalid effort", minimalSettings({ ...validEnv, CLAUDE_CODE_EFFORT_LEVEL: "extreme" })],
      ["compression below range", minimalSettings({ ...validEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "99999" })],
      ["compression above range", minimalSettings({ ...validEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000001" })],
      ["compression with unit", minimalSettings({ ...validEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000ms" })],
      ["numeric compression", minimalSettings({ ...validEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 100000 })],
      ["zero timeout", minimalSettings({ ...validEnv, API_TIMEOUT_MS: "0" })],
      ["decimal timeout", minimalSettings({ ...validEnv, API_TIMEOUT_MS: "1.5" })],
      ["numeric timeout", minimalSettings({ ...validEnv, API_TIMEOUT_MS: 1 })],
      ["empty override", minimalSettings(validEnv, { modelOverrides: { sonnet: "" } })],
    ];

    for (const [label, settings] of invalidSettings) {
      expect(validator(settings), label).toBe(false);
    }
  });

  it("resolves each settings or provider file by model, provider, then CLI fallback", () => {
    const deepSeekModelId = Object.keys(apiCatalog.deepseek.models ?? {})[0];
    expect(deepSeekModelId).toBeTruthy();
    if (!deepSeekModelId) return;

    expect(
      resolveTemplateFile("claude", "deepseek", deepSeekModelId, "settings.json"),
    ).toBe(join(rootDir, "claude", "deepseek", "settings.json"));
    expect(
      resolveTemplateFile("claude", "deepseek", deepSeekModelId, "provider.json"),
    ).toBe(join(rootDir, "claude", "deepseek", "provider.json"));

    const modelSettings = join(
      rootDir,
      "claude",
      "deepseek",
      deepSeekModelId,
      "settings.json",
    );
    const providerSettings = join(rootDir, "claude", "deepseek", "settings.json");
    const cliSettings = join(rootDir, "claude", "settings.json");
    const allSettingsLevels = new Set([modelSettings, providerSettings, cliSettings]);
    expect(
      resolveTemplateFile(
        "claude",
        "deepseek",
        deepSeekModelId,
        "settings.json",
        (path) => allSettingsLevels.has(path),
      ),
    ).toBe(modelSettings);

    const cliOnly = new Set([cliSettings]);
    expect(
      resolveTemplateFile("claude", "missing", "missing", "settings.json", (path) =>
        cliOnly.has(path),
      ),
    ).toBe(cliSettings);

    const cliProvider = join(rootDir, "claude", "provider.json");
    const providerFallbackOnly = new Set([cliProvider]);
    expect(
      resolveTemplateFile("claude", "missing", "missing", "provider.json", (path) =>
        providerFallbackOnly.has(path),
      ),
    ).toBe(cliProvider);
  });
});

describe("fallback configuration templates", () => {
  const providerPlaceholders = [
    "<provider-id>",
    "<provider-key>",
    "<provider-name>",
    "<npm-package>",
    "<base-url>",
  ];

  function collectStringValues(value: unknown, result: string[] = []): string[] {
    if (typeof value === "string") {
      result.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => collectStringValues(item, result));
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) collectStringValues(child, result);
    }
    return result;
  }

  function validateLevelTemplate(
    filePath: string,
    schemaPath: string,
    values: string[],
  ): JsonObject {
    const parsed = validateTemplate(filePath, schemaPath);
    assertNoUnexpectedSecret(parsed);
    collectStringValues(parsed, values);
    return parsed;
  }

  for (const cliId of Object.keys(cliLevelFileSchemas) as CliId[]) {
    it(`validates every ${cliId} provider-level and cli-level template`, () => {
      for (const providerId of coverage[cliId]) {
        const values: string[] = [];
        const parsedByFile: Record<string, JsonObject> = {};
        for (const [fileName, schemaPath] of Object.entries(
          schemasForProvider(cliId, providerId),
        )) {
          parsedByFile[fileName] = validateLevelTemplate(
            join(rootDir, cliId, providerId, fileName),
            schemaPath,
            values,
          );
        }
        assertProviderTemplateIdentity(cliId, providerId, parsedByFile);
        expect(
          values.some((value) => value.includes("<model-id>") || value.includes("<model-name>")),
          `${cliId}/${providerId} templates must use model placeholders`,
        ).toBe(true);
        for (const placeholder of providerPlaceholders) {
          expect(
            values.some((value) => value.includes(placeholder)),
            `${cliId}/${providerId} templates must keep real provider values (unexpected ${placeholder})`,
          ).toBe(false);
        }
      }

      const cliValues: string[] = [];
      const cliParsedByFile: Record<string, JsonObject> = {};
      for (const [fileName, schemaPath] of Object.entries(
        cliLevelFileSchemas[cliId] ?? {},
      )) {
        cliParsedByFile[fileName] = validateLevelTemplate(
          join(rootDir, cliId, fileName),
          schemaPath,
          cliValues,
        );
      }
      expect(
        cliValues.some((value) => value.includes("<model-id>")),
        `${cliId} templates must use model placeholders`,
      ).toBe(true);
      expect(
        cliValues.some((value) =>
          providerPlaceholders.some((placeholder) => value.includes(placeholder)),
        ),
        `${cliId} templates must use provider placeholders`,
      ).toBe(true);

      if (cliId === "opencode") {
        expect(cliParsedByFile["opencode.json"]).toEqual({
          $schema: "https://opencode.ai/config.json",
          model: "<provider-id>/<model-id>",
          provider: {
            "<provider-id>": {
              npm: "<npm-package>",
              name: "<provider-name>",
              options: {
                baseURL: "<base-url>",
                apiKey: "<your-api-key>",
              },
              models: {
                "<model-id>": {
                  name: "<model-name>",
                  reasoning: true,
                },
              },
            },
          },
        });
        expect(existsSync(join(rootDir, "opencode", "auth.json"))).toBe(false);
      }

      if (cliId === "pi") {
        expect(cliParsedByFile["settings.json"]).toEqual({
          defaultProvider: "<provider-id>",
          defaultModel: "<model-id>",
        });
        expect(cliParsedByFile["models.json"]).toEqual({
          providers: {
            "<provider-id>": {
              baseUrl: "<base-url>",
              api: "openai-completions",
              apiKey: "<your-api-key>",
              models: [{ id: "<model-id>" }],
            },
          },
        });
        expect(existsSync(join(rootDir, "pi", "auth.json"))).toBe(false);
      }
    });
  }
});

describe("crush text templates", () => {
  const providerPlaceholders = [
    "<provider-id>",
    "<provider-key>",
    "<provider-name>",
    "<npm-package>",
    "<base-url>",
  ];

  function readCrushrc(relativePath: string): string {
    return readFileSync(join(rootDir, relativePath), "utf8");
  }

  function extractFlagValue(text: string, flag: string): string | undefined {
    return text.match(new RegExp(`${flag} "([^"]+)"`))?.[1];
  }

  it("validates every crush provider-level crushrc", () => {
    for (const providerId of coverage.crush) {
      const text = readCrushrc(`crush/${providerId}/crushrc`);
      const apiHost = hostnameOf(apiCatalog[providerId]?.api as string);
      const providerInfo = readJson(join(rootDir, "crush", providerId, "provider.json"));

      expect(
        text.includes(`provider add ${providerId} --name "${providerInfo.name}" --type openai-compat`),
        `crush/${providerId}/crushrc must register the provider with its display name`,
      ).toBe(true);
      expect(
        text.includes(`model add ${providerId}/<model-id>`),
        `crush/${providerId}/crushrc must register a model placeholder`,
      ).toBe(true);
      expect(
        text.includes("<model-name>"),
        `crush/${providerId}/crushrc must use a model name placeholder`,
      ).toBe(true);
      expect(
        text.includes("<your-api-key>"),
        `crush/${providerId}/crushrc must keep the manual API key placeholder`,
      ).toBe(true);

      const baseUrl = extractFlagValue(text, "--base-url");
      expect(
        baseUrl,
        `crush/${providerId}/crushrc must declare a --base-url value`,
      ).toBeTruthy();
      if (baseUrl) {
        assertBaseUrlHost(baseUrl, apiHost, `crush/${providerId}/crushrc --base-url`);
        expect(
          baseUrl.replace(/\/+$/, "").endsWith("/chat/completions"),
          `crush/${providerId}/crushrc --base-url must stop before the client-appended path`,
        ).toBe(false);
        expect(
          baseUrl,
          `crush/${providerId}/crushrc --base-url must match provider.json base_url`,
        ).toBe(providerInfo.base_url);
      }

      for (const placeholder of providerPlaceholders) {
        expect(
          text.includes(placeholder),
          `crush/${providerId}/crushrc keeps real provider values (unexpected ${placeholder})`,
        ).toBe(false);
      }
    }
  });

  it("validates the crush cli-level crushrc", () => {
    const text = readCrushrc("crush/crushrc");
    expect(
      text.includes('provider add <provider-id> --name "<provider-name>" --type openai-compat'),
      "crush/crushrc must register a provider placeholder",
    ).toBe(true);
    expect(
      text.includes("--base-url \"<base-url>\""),
      "crush/crushrc must use a base-url placeholder",
    ).toBe(true);
    expect(
      text.includes("<provider-name>"),
      "crush/crushrc must use a provider name placeholder",
    ).toBe(true);
    expect(
      text.includes("<your-api-key>"),
      "crush/crushrc must keep the manual API key placeholder",
    ).toBe(true);
    expect(
      text.includes("model add <provider-id>/<model-id>"),
      "crush/crushrc must register a model placeholder",
    ).toBe(true);
    expect(
      text.includes("<model-name>"),
      "crush/crushrc must use a model name placeholder",
    ).toBe(true);
  });
});

describe("negative validation fixture", () => {
  it("rejects a structurally incomplete OpenCode config", () => {
    const fixture = readJson(join(rootDir, "tests/fixtures/invalid-opencode.json"));
    const validator = getValidator("opencode/schemas/opencode.schema.json");
    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
  });

  it("rejects an incomplete OpenCode API credential", () => {
    const fixture = readJson(join(rootDir, "tests/fixtures/invalid-opencode-auth.json"));
    const validator = getValidator("opencode/schemas/auth.schema.json");
    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
  });

  it("accepts minimal PI settings and rejects missing, empty, mistyped, or extra fields", () => {
    const validator = getValidator("pi/schemas/settings.schema.json");
    expect(
      validator({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      }),
    ).toBe(true);

    const invalidSettings = [
      { defaultModel: "deepseek-chat" },
      { defaultProvider: "deepseek" },
      { defaultProvider: "", defaultModel: "deepseek-chat" },
      { defaultProvider: "deepseek", defaultModel: "" },
      { defaultProvider: 1, defaultModel: "deepseek-chat" },
      { defaultProvider: "deepseek", defaultModel: false },
      { defaultProvider: "deepseek", defaultModel: "deepseek-chat", extra: true },
      {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        defaultThinkingLevel: "high",
      },
    ];
    for (const settings of invalidSettings) expect(validator(settings)).toBe(false);
  });

  it("accepts minimal PI models and rejects incomplete providers or model ids", () => {
    const validator = getValidator("pi/schemas/models.schema.json");
    const minimalModels = {
      providers: {
        custom: {
          baseUrl: "https://api.example.com",
          api: "openai-completions",
          apiKey: "<your-api-key>",
          models: [{ id: "example-model" }],
        },
      },
    };

    expect(validator({ providers: {} })).toBe(true);
    expect(validator(minimalModels)).toBe(true);
    expect(validator({})).toBe(false);
    expect(validator({ providers: null })).toBe(false);
    expect(validator({ providers: [] })).toBe(false);
    for (const requiredField of ["baseUrl", "api", "apiKey", "models"]) {
      const incomplete = JSON.parse(JSON.stringify(minimalModels)) as JsonObject;
      delete incomplete.providers.custom[requiredField];
      expect(validator(incomplete), `PI provider without ${requiredField} must fail`).toBe(
        false,
      );
    }
    expect(
      validator({
        providers: {
          broken: {
            baseUrl: "https://api.example.com",
            api: "openai-completions",
            apiKey: "<your-api-key>",
            models: [],
          },
        },
      }),
    ).toBe(false);
    expect(
      validator({
        providers: {
          broken: {
            baseUrl: "https://api.example.com",
            api: "openai-completions",
            apiKey: "<your-api-key>",
            models: [{}],
          },
        },
      }),
    ).toBe(false);
    expect(
      validator({
        providers: {
          broken: {
            baseUrl: "https://api.example.com",
            api: "openai-completions",
            apiKey: "<your-api-key>",
            models: [{ id: "" }],
          },
        },
      }),
    ).toBe(false);
    expect(
      validator({
        providers: {
          broken: {
            baseUrl: "https://api.example.com",
            api: "openai-completions",
            apiKey: "<your-api-key>",
            models: [{ id: "example-model", unknown: true }],
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps optional PI model property constraints", () => {
    const validator = getValidator("pi/schemas/models.schema.json");
    const modelsWith = (model: JsonObject) => ({
      providers: {
        custom: {
          baseUrl: "https://api.example.com",
          api: "openai-completions",
          apiKey: "<your-api-key>",
          models: [model],
        },
      },
    });

    expect(
      validator(modelsWith({ id: "example-model", reasoning: true, contextWindow: 128000 })),
    ).toBe(true);
    expect(validator(modelsWith({ id: "example-model", reasoning: "yes" }))).toBe(false);
    expect(validator(modelsWith({ id: "example-model", contextWindow: 0 }))).toBe(false);
  });

  it("rejects invalid PI API credentials", () => {
    const validator = getValidator("pi/schemas/auth.schema.json");
    expect(
      validator({
        deepseek: {
          type: "api_key",
          key: "<your-api-key>",
        },
      }),
    ).toBe(true);
    expect(
      validator({
        deepseek: {
          type: "api",
          key: "<your-api-key>",
        },
      }),
    ).toBe(false);
    expect(
      validator({
        deepseek: {
          type: "api_key",
          key: "not-a-placeholder",
        },
      }),
    ).toBe(false);
    expect(validator({ deepseek: { type: "api_key" } })).toBe(false);
  });

  it("rejects a Goose custom provider with an unsupported endpoint path", () => {
    const fixture = readJson(join(rootDir, "tests/fixtures/invalid-goose-custom-provider.json"));
    const validator = getValidator("goose/schemas/custom-provider.schema.json");
    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
  });
});
