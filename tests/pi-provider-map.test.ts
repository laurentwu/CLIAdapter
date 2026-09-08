import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

type Mapping = {
  kind: "builtin" | "custom";
  provider: string;
  alternatives?: string[];
};

type ProviderMap = {
  schemaVersion: number;
  pi: {
    version: string;
    commit: string;
  };
  mappings: Record<string, Mapping>;
};

type KnownProviders = {
  version: string;
  commit: string;
  providers: string[];
};

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const providerMap = readJson(join(rootDir, "pi-provider-map.json")) as ProviderMap;
const apiCatalog = readJson(join(rootDir, "api.json")) as Record<string, unknown>;
const knownProviders = readJson(
  join(rootDir, "tests", "fixtures", "pi-known-providers.json"),
) as KnownProviders;

const sameNameBuiltinSources = [
  "amazon-bedrock",
  "anthropic",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "opencode",
  "opencode-go",
  "openai",
  "openrouter",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
] as const;

const renamedBuiltinMappings: Record<string, Mapping> = {
  "alibaba-token-plan": {
    kind: "builtin",
    provider: "qwen-token-plan",
    alternatives: ["qwen-token-plan-individual"],
  },
  "alibaba-token-plan-cn": {
    kind: "builtin",
    provider: "qwen-token-plan-cn",
  },
  azure: {
    kind: "builtin",
    provider: "azure-openai-responses",
  },
  "azure-cognitive-services": {
    kind: "builtin",
    provider: "azure-openai-responses",
  },
  "fireworks-ai": {
    kind: "builtin",
    provider: "fireworks",
  },
  "kimi-for-coding": {
    kind: "builtin",
    provider: "kimi-coding",
  },
  togetherai: {
    kind: "builtin",
    provider: "together",
  },
  vercel: {
    kind: "builtin",
    provider: "vercel-ai-gateway",
  },
  "zai-coding-plan": {
    kind: "builtin",
    provider: "zai",
  },
  "zhipuai-coding-plan": {
    kind: "builtin",
    provider: "zai-coding-cn",
  },
};

const customMappings: Record<string, Mapping> = {
  zai: {
    kind: "custom",
    provider: "zai-api",
  },
  zhipuai: {
    kind: "custom",
    provider: "zhipuai",
  },
};

const expectedMappings: Record<string, Mapping> = Object.fromEntries([
  ...sameNameBuiltinSources.map((source) => [
    source,
    { kind: "builtin", provider: source } satisfies Mapping,
  ] as const),
  ...Object.entries(renamedBuiltinMappings),
  ...Object.entries(customMappings),
]);

const expectedKnownProviderIds = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
];

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function validateSemantics(candidate: ProviderMap): string[] {
  const errors: string[] = [];
  const known = new Set(knownProviders.providers);

  if (
    candidate.pi.version !== knownProviders.version ||
    candidate.pi.commit !== knownProviders.commit
  ) {
    errors.push("map and KnownProvider fixture must use the same PI baseline");
  }

  for (const [source, mapping] of Object.entries(candidate.mappings)) {
    if (!(source in apiCatalog)) errors.push(`${source} is not in api.json`);

    if (mapping.kind === "builtin") {
      if (!known.has(mapping.provider)) {
        errors.push(`${source} targets unknown builtin ${mapping.provider}`);
      }
      const alternatives = mapping.alternatives ?? [];
      if (new Set(alternatives).size !== alternatives.length) {
        errors.push(`${source} has duplicate alternatives`);
      }
      if (alternatives.includes(mapping.provider)) {
        errors.push(`${source} repeats its default provider as an alternative`);
      }
      for (const alternative of alternatives) {
        if (!known.has(alternative)) {
          errors.push(`${source} has unknown alternative ${alternative}`);
        }
      }
    } else if (known.has(mapping.provider)) {
      errors.push(`${source} custom provider collides with builtin ${mapping.provider}`);
    }
  }

  for (const [source, expected] of Object.entries(expectedMappings)) {
    if (JSON.stringify(candidate.mappings[source]) !== JSON.stringify(expected)) {
      errors.push(`${source} does not match the verified mapping`);
    }
  }
  for (const source of Object.keys(candidate.mappings)) {
    if (!(source in expectedMappings)) errors.push(`${source} is not a verified mapping`);
  }

  return errors;
}

function resolveTemplate(
  fixtureRoot: string,
  cli: string,
  provider: string,
  model: string,
  fileName: string,
): string {
  const candidates = [
    join(fixtureRoot, cli, provider, model, fileName),
    join(fixtureRoot, cli, provider, fileName),
    join(fixtureRoot, cli, fileName),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`No ${fileName} template found`);
  return match;
}

describe("PI provider map", () => {
  it("matches its strict offline JSON Schema", () => {
    const schema = readJson(
      join(rootDir, "pi", "schemas", "provider-map.schema.json"),
    ) as object;
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

    expect(validate(providerMap), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const invalidCases: ProviderMap[] = [];
    const invalidKind = structuredClone(providerMap);
    invalidKind.mappings.deepseek.kind = "unsupported" as Mapping["kind"];
    invalidCases.push(invalidKind);

    const unknownField = structuredClone(providerMap);
    Object.assign(unknownField.mappings.deepseek, { endpoint: "https://example.com" });
    invalidCases.push(unknownField);

    const missingProvider = structuredClone(providerMap);
    delete (missingProvider.mappings.deepseek as Partial<Mapping>).provider;
    invalidCases.push(missingProvider);

    const customAlternative = structuredClone(providerMap);
    customAlternative.mappings.zai.alternatives = ["openai"];
    invalidCases.push(customAlternative);

    const duplicateAlternative = structuredClone(providerMap);
    duplicateAlternative.mappings["alibaba-token-plan"].alternatives = [
      "qwen-token-plan-individual",
      "qwen-token-plan-individual",
    ];
    invalidCases.push(duplicateAlternative);

    for (const invalid of invalidCases) expect(validate(invalid)).toBe(false);
  });

  it("contains the exact 37 builtin and 2 custom mappings in source-key order", () => {
    const mappingKeys = Object.keys(providerMap.mappings);
    expect(mappingKeys).toEqual([...mappingKeys].sort());
    expect(providerMap.mappings).toEqual(expectedMappings);
    expect(Object.values(providerMap.mappings).filter(({ kind }) => kind === "builtin")).toHaveLength(
      37,
    );
    expect(Object.values(providerMap.mappings).filter(({ kind }) => kind === "custom")).toHaveLength(
      2,
    );
    expect(validateSemantics(providerMap)).toEqual([]);
  });

  it("pins the complete PI v0.85.1 KnownProvider namespace", () => {
    expect(knownProviders).toEqual({
      version: "0.85.1",
      commit: "d981de1229ef899957bbe968bc8dcda02a21f477",
      providers: expectedKnownProviderIds,
    });
    expect(knownProviders.providers).toEqual([...knownProviders.providers].sort());
  });

  it("preserves renamed, alternative, many-to-one, and custom identities", () => {
    expect(providerMap.mappings["alibaba-token-plan"]).toEqual({
      kind: "builtin",
      provider: "qwen-token-plan",
      alternatives: ["qwen-token-plan-individual"],
    });
    expect(providerMap.mappings.azure.provider).toBe("azure-openai-responses");
    expect(providerMap.mappings["azure-cognitive-services"].provider).toBe(
      "azure-openai-responses",
    );
    expect(providerMap.mappings["zai-coding-plan"]).toEqual({
      kind: "builtin",
      provider: "zai",
    });
    expect(providerMap.mappings["zhipuai-coding-plan"]).toEqual({
      kind: "builtin",
      provider: "zai-coding-cn",
    });
    expect(providerMap.mappings.zai).toEqual({
      kind: "custom",
      provider: "zai-api",
    });
    expect(providerMap.mappings.zhipuai).toEqual({
      kind: "custom",
      provider: "zhipuai",
    });
  });

  it("detects package mix-ups, unknown IDs, collisions, and invalid alternatives", () => {
    const cases: ProviderMap[] = [];

    const ordinaryZaiAsPlan = structuredClone(providerMap);
    ordinaryZaiAsPlan.mappings.zai = { kind: "builtin", provider: "zai" };
    cases.push(ordinaryZaiAsPlan);

    const domesticPlanAsOrdinary = structuredClone(providerMap);
    domesticPlanAsOrdinary.mappings["zhipuai-coding-plan"] = {
      kind: "custom",
      provider: "zhipuai",
    };
    cases.push(domesticPlanAsOrdinary);

    const unknownSource = structuredClone(providerMap);
    unknownSource.mappings["not-in-api"] = { kind: "builtin", provider: "openai" };
    cases.push(unknownSource);

    const unknownTarget = structuredClone(providerMap);
    unknownTarget.mappings.deepseek.provider = "not-a-known-provider";
    cases.push(unknownTarget);

    const repeatedDefault = structuredClone(providerMap);
    repeatedDefault.mappings["alibaba-token-plan"].alternatives = ["qwen-token-plan"];
    cases.push(repeatedDefault);

    for (const invalid of cases) expect(validateSemantics(invalid).length).toBeGreaterThan(0);
  });
});

describe("PI per-file template fallback", () => {
  it("lets an empty builtin models template block the CLI custom-provider fallback", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-template-fallback-"));
    try {
      const cliRoot = join(fixtureRoot, "pi");
      const providerRoot = join(cliRoot, "deepseek");
      const modelRoot = join(providerRoot, "example-model");
      mkdirSync(modelRoot, { recursive: true });
      writeFileSync(
        join(cliRoot, "models.json"),
        JSON.stringify({ providers: { "<provider-id>": { custom: true } } }),
      );
      writeFileSync(join(providerRoot, "models.json"), JSON.stringify({ providers: {} }));
      writeFileSync(
        join(providerRoot, "settings.json"),
        JSON.stringify({ defaultProvider: "deepseek" }),
      );

      const modelsPath = resolveTemplate(
        fixtureRoot,
        "pi",
        "deepseek",
        "example-model",
        "models.json",
      );
      const settingsPath = resolveTemplate(
        fixtureRoot,
        "pi",
        "deepseek",
        "example-model",
        "settings.json",
      );

      expect(modelsPath).toBe(join(providerRoot, "models.json"));
      expect(readJson(modelsPath)).toEqual({ providers: {} });
      expect(settingsPath).toBe(join(providerRoot, "settings.json"));

      rmSync(join(providerRoot, "models.json"));
      expect(
        resolveTemplate(
          fixtureRoot,
          "pi",
          "deepseek",
          "example-model",
          "models.json",
        ),
        "without the required provider-level file, resolution would incorrectly reach the CLI fallback",
      ).toBe(join(cliRoot, "models.json"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("prefers model-level files when present", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-template-priority-"));
    try {
      const modelRoot = join(fixtureRoot, "pi", "deepseek", "example-model");
      mkdirSync(modelRoot, { recursive: true });
      writeFileSync(join(fixtureRoot, "pi", "settings.json"), "cli");
      writeFileSync(join(fixtureRoot, "pi", "deepseek", "settings.json"), "provider");
      writeFileSync(join(modelRoot, "settings.json"), "model");

      expect(
        resolveTemplate(
          fixtureRoot,
          "pi",
          "deepseek",
          "example-model",
          "settings.json",
        ),
      ).toBe(join(modelRoot, "settings.json"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
