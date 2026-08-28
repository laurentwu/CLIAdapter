import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, any>;
type CliId = "claude" | "codex" | "opencode" | "pi";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const providers = [
  "zhipuai",
  "zhipuai-coding-plan",
  "deepseek",
  "opencode",
  "opencode-go",
] as const;

const coverage: Record<CliId, readonly string[]> = {
  claude: ["zhipuai-coding-plan", "deepseek", "opencode", "opencode-go"],
  codex: ["zhipuai-coding-plan", "opencode", "opencode-go"],
  opencode: [...providers],
  pi: [...providers],
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

function assertTemplateIdentity(
  cli: CliId,
  providerId: string,
  modelId: string,
  parsed: Record<string, JsonObject>,
): void {
  assertNoUnexpectedSecret(parsed);

  if (cli === "claude") {
    const settings = parsed["settings.json"];
    expect(settings.model).toBe(modelId);
    assertBaseUrlWithoutAppendedSuffix(
      settings.env?.ANTHROPIC_BASE_URL,
      clientAppendedSuffix.claude,
      "settings.json.env.ANTHROPIC_BASE_URL",
    );
    return;
  }

  if (cli === "codex") {
    const config = parsed["config.toml"];
    const catalog = parsed["models.json"];
    expect(config.model).toBe(modelId);
    expect(config.model_catalog_json).toBe("~/.codex/models.json");
    expect(config.model_providers).toBeTruthy();
    expect(Object.keys(config.model_providers)).toContain(config.model_provider);
    for (const [providerKey, provider] of Object.entries(config.model_providers as JsonObject)) {
      assertBaseUrlWithoutAppendedSuffix(
        (provider as JsonObject).base_url,
        clientAppendedSuffix.codex,
        `config.toml.model_providers.${providerKey}.base_url`,
      );
    }
    expect(
      (catalog.models as JsonObject[]).some((model) => model.slug === modelId),
    ).toBe(true);
    return;
  }

  if (cli === "opencode") {
    const config = parsed["opencode.json"];
    expect(config.model).toBe(`${providerId}/${modelId}`);
    const provider = config.provider[providerId];
    assertBaseUrlWithoutAppendedSuffix(
      provider.options?.baseURL,
      clientAppendedSuffix.opencode,
      `opencode.json.provider.${providerId}.options.baseURL`,
    );
    expect(provider.models[modelId]).toBeTruthy();
    return;
  }

  const settings = parsed["settings.json"];
  const models = parsed["models.json"];
  expect(settings.defaultProvider).toBe(providerId);
  expect(settings.defaultModel).toBe(modelId);
  const provider = models.providers[providerId];
  assertBaseUrlWithoutAppendedSuffix(
    provider.baseUrl,
    clientAppendedSuffix.pi,
    `models.json.providers.${providerId}.baseUrl`,
  );
  expect(provider.models.some((model: JsonObject) => model.id === modelId)).toBe(true);
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
    const seenProviders = new Set<string>();

    for (const cliId of Object.keys(coverage) as CliId[]) {
      const cliRoot = join(rootDir, cliId);
      const actualProviders = listDirectories(cliRoot).filter((name) => name !== "schemas");
      expect(actualProviders).toEqual([...coverage[cliId]].sort());

      for (const providerId of actualProviders) {
        expect(providers).toContain(providerId as (typeof providers)[number]);
        seenProviders.add(providerId);
        const providerRoot = join(cliRoot, providerId);
        expect(statSync(join(providerRoot, "provider.json")).isFile()).toBe(true);
        expect(statSync(join(providerRoot, "logo.svg")).isFile()).toBe(true);
        const providerInfo = readJson(join(providerRoot, "provider.json"));
        assertBaseUrlWithoutAppendedSuffix(
          providerInfo.base_url,
          clientAppendedSuffix[cliId],
          `${cliId}/${providerId}/provider.json.base_url`,
        );

        const models = listDirectories(providerRoot);
        expect(models.length, `${cliId}/${providerId} must contain a model`).toBeGreaterThan(0);
        for (const modelId of models) {
          expect(modelId).not.toMatch(/[\\/]/);
          expect(modelId).not.toBe("model.json");
        }
      }
    }

    expect([...seenProviders].sort()).toEqual([...providers].sort());
  });
});

describe("configuration templates", () => {
  for (const cliId of Object.keys(fileSchemas) as CliId[]) {
    it(`validates every ${cliId} template`, () => {
      for (const providerId of coverage[cliId]) {
        const providerRoot = join(rootDir, cliId, providerId);
        for (const modelId of listDirectories(providerRoot)) {
          const modelRoot = join(providerRoot, modelId);
          expect(listFiles(modelRoot)).toEqual([...requiredFiles[cliId]].sort());

          const parsed: Record<string, JsonObject> = {};
          for (const [fileName, schemaPath] of Object.entries(fileSchemas[cliId])) {
            parsed[fileName] = validateTemplate(join(modelRoot, fileName), schemaPath);
          }
          assertTemplateIdentity(cliId, providerId, modelId, parsed);
        }
      }
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
