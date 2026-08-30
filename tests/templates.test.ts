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

const allProviders = [
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
  "deepseek",
  "opencode",
  "opencode-go",
];

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

const fileSchemas: Partial<Record<CliId, Record<string, string>>> = {
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

const requiredFiles: Record<CliId, readonly string[]> = {
  claude: ["settings.json"],
  codex: ["config.toml", "models.json"],
  opencode: ["opencode.json"],
  pi: ["models.json", "settings.json"],
  qwen: ["settings.json"],
  kimi: ["config.toml"],
  codebuddy: ["models.json"],
  crush: ["crushrc"],
  goose: ["config.yaml", "custom-provider.json"],
};

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
    expect(value, `${path} must keep the manual placeholder`).toBe("<Your API Key>");
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

function assertClaudeRecommendedEnvironment(
  settings: JsonObject,
  label: string,
): void {
  const env = settings.env as JsonObject | undefined;
  expect(env, `${label}.env must be present`).toBeTruthy();
  if (!env) return;

  for (const variable of [
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    expect(env[variable], `${label}.env.${variable} must use the model placeholder`).toBe(
      "<model-id>",
    );
  }
  expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, `${label}.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`).toBe(
    "1000000",
  );
  expect(
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    `${label}.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  ).toBe("1");
  expect(env.API_TIMEOUT_MS, `${label}.env.API_TIMEOUT_MS`).toBe("3000000");
}

function assertProviderTemplateIdentity(
  cli: CliId,
  providerId: string,
  parsedByFile: Record<string, JsonObject>,
): void {
  const apiHost = hostnameOf(apiCatalog[providerId]?.api as string);

  if (cli === "claude") {
    const settings = parsedByFile["settings.json"];
    if (providerId === "deepseek") {
      const env = parsedByFile["settings.json"]?.env ?? {};
      expect(env.ANTHROPIC_MODEL).toBe("<model-id>[1m]");
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("<model-id>[1m]");
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("<model-id>[1m]");
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("<model-id>");
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("<model-id>");
      expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("786432");
    }
    assertBaseUrlHost(
      settings?.env?.ANTHROPIC_BASE_URL,
      apiHost,
      `${cli}/${providerId}/settings.json.env.ANTHROPIC_BASE_URL`,
    );
    if (anthropicProviders.has(providerId)) {
      assertClaudeRecommendedEnvironment(
        settings,
        `${cli}/${providerId}/settings.json`,
      );
    }
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
    expect(config.model).toBe(`${providerId}/<model-id>`);
    assertBaseUrlHost(
      config.provider?.[providerId]?.options?.baseURL,
      apiHost,
      `${cli}/${providerId}/opencode.json.provider.${providerId}.options.baseURL`,
    );
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
      ).toBe("<Your API Key>");
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
      expect(
        model.url,
        `${cli}/${providerId}/models.json.models[${index}].url must match provider.json base_url`,
      ).toBe(providerInfo.base_url);
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
    expect(
      provider.base_url,
      `${cli}/${providerId}/custom-provider.json.base_url must match provider.json base_url`,
    ).toBe(providerInfo.base_url);
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
    for (const cliId of Object.keys(fileSchemas) as CliId[]) {
      expect(listDirectories(join(rootDir, cliId))).toContain("schemas");
      for (const schemaPath of Object.values(fileSchemas[cliId] ?? {})) {
        getValidator(schemaPath);
      }
    }
  });

  it("keeps the declared CLI/provider coverage and provider assets", () => {
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
          [...requiredFiles[cliId], "provider.json"].sort(),
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
      }
    }
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

  for (const cliId of Object.keys(fileSchemas) as CliId[]) {
    it(`validates every ${cliId} provider-level and cli-level template`, () => {
      for (const providerId of coverage[cliId]) {
        const values: string[] = [];
        const parsedByFile: Record<string, JsonObject> = {};
        for (const [fileName, schemaPath] of Object.entries(fileSchemas[cliId] ?? {})) {
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
      for (const [fileName, schemaPath] of Object.entries(fileSchemas[cliId] ?? {})) {
        cliParsedByFile[fileName] = validateLevelTemplate(
          join(rootDir, cliId, fileName),
          schemaPath,
          cliValues,
        );
      }
      if (cliId === "claude") {
        assertClaudeRecommendedEnvironment(
          cliParsedByFile["settings.json"],
          `${cliId}/settings.json`,
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
        text.includes("<Your API Key>"),
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
      text.includes("<Your API Key>"),
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

  it("rejects a Goose custom provider with an unsupported endpoint path", () => {
    const fixture = readJson(join(rootDir, "tests/fixtures/invalid-goose-custom-provider.json"));
    const validator = getValidator("goose/schemas/custom-provider.schema.json");
    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
  });
});
