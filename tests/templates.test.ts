import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;
type CliId = "claude" | "codex" | "opencode" | "pi";

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

const coverage: Record<CliId, readonly string[]> = {
  claude: [...allProviders],
  codex: allProviders.filter((providerId) => providerId !== "deepseek"),
  opencode: [...allProviders],
  pi: [...allProviders],
};

const fileSchemas: Record<CliId, Record<string, string>> = {
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
};

const requiredFiles: Record<CliId, readonly string[]> = {
  claude: ["settings.json"],
  codex: ["config.toml", "models.json"],
  opencode: ["opencode.json"],
  pi: ["models.json", "settings.json"],
};

const clientAppendedSuffix: Record<CliId, string> = {
  claude: "/v1/messages",
  codex: "/responses",
  opencode: "/chat/completions",
  pi: "/chat/completions",
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

function assertProviderTemplateIdentity(
  cli: CliId,
  providerId: string,
  parsedByFile: Record<string, JsonObject>,
): void {
  const apiHost = hostnameOf(apiCatalog[providerId]?.api as string);

  if (cli === "claude") {
    assertBaseUrlHost(
      parsedByFile["settings.json"]?.env?.ANTHROPIC_BASE_URL,
      apiHost,
      `${cli}/${providerId}/settings.json.env.ANTHROPIC_BASE_URL`,
    );
    return;
  }

  if (cli === "codex") {
    const config = parsedByFile["config.toml"];
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

  expect(parsedByFile["settings.json"]?.defaultProvider).toBe(providerId);
  assertBaseUrlHost(
    parsedByFile["models.json"]?.providers?.[providerId]?.baseUrl,
    apiHost,
    `${cli}/${providerId}/models.json.providers.${providerId}.baseUrl`,
  );
}

describe("repository schemas", () => {
  it("contains the four planned CLI roots and all local schemas compile offline", () => {
    const cliIds: CliId[] = ["claude", "codex", "opencode", "pi"];
    for (const cliId of cliIds) {
      expect(listDirectories(join(rootDir, cliId))).toContain("schemas");
      for (const schemaPath of Object.values(fileSchemas[cliId])) {
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
        expect(
          listDirectories(providerRoot),
          `${cliId}/${providerId} must not contain model directories; only provider-level templates exist`,
        ).toEqual([]);
        expect(listFiles(providerRoot)).toEqual(
          [...requiredFiles[cliId], "provider.json"].sort(),
        );

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
        for (const [fileName, schemaPath] of Object.entries(fileSchemas[cliId])) {
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
      for (const [fileName, schemaPath] of Object.entries(fileSchemas[cliId])) {
        validateLevelTemplate(join(rootDir, cliId, fileName), schemaPath, cliValues);
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

describe("negative validation fixture", () => {
  it("rejects a structurally incomplete OpenCode config", () => {
    const fixture = readJson(join(rootDir, "tests/fixtures/invalid-opencode.json"));
    const validator = getValidator("opencode/schemas/opencode.schema.json");
    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
  });
});
