import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Build utilities are dependency-free JavaScript.
import { resolveTemplate } from "../scripts/repository.mjs";
import { addCli, addProvider, createSource, readJson, writeJson } from "./support/fixtures.js";
import { parseTemplate, SchemaRegistry, validateRepository, type JsonObject } from "./support/repository.js";

function assertSeparateCredentials(config: JsonObject, auth: JsonObject): void {
  expect(Object.keys(auth).sort()).toEqual(Object.keys(config.provider).sort());
  for (const provider of Object.values(config.provider) as JsonObject[]) {
    expect(provider.options).not.toHaveProperty("apiKey");
  }
  for (const credential of Object.values(auth) as JsonObject[]) {
    expect(credential.type).toBe("api");
    expect(credential.key).toBe("<your-api-key>");
  }
}

it("validates every discovered repository template, declaration, metadata file, and local Schema offline", () => {
  expect(() => validateRepository()).not.toThrow();
});

it("pairs discovered OpenCode-format generic templates with separate credentials", () => {
  const repository = validateRepository();
  for (const cli of repository.clis) {
    const files = cli.declaration.files;
    if (!files["opencode.jsonc"] || !files["auth.json"]) continue;
    const templates = repository.templates.filter((entry) => entry.cliId === cli.id && entry.level === "cli");
    const config = templates.find((entry) => entry.fileName === "opencode.jsonc")!;
    const auth = templates.find((entry) => entry.fileName === "auth.json")!;
    expect(config, cli.directory).toBeDefined();
    expect(auth, cli.directory).toBeDefined();
    expect(config.format).toBe("jsonc");
    expect(auth.format).toBe("json");
    for (const name of ["opencode.jsonc", "auth.json"]) {
      expect(files[name].levels).toEqual(expect.arrayContaining(["cli", "provider", "model"]));
      expect(files[name].requiredAt).toEqual(expect.arrayContaining(["cli", "provider"]));
    }
    assertSeparateCredentials(parseTemplate(config) as JsonObject, parseTemplate(auth) as JsonObject);

    const registry = new SchemaRegistry(cli.schemaPaths);
    expect(() => registry.validate(config.schemaPath, { model: "alpha/example-model" })).not.toThrow();
    expect(() => registry.validate(config.schemaPath, { model: 42 })).toThrow(/string/);
    expect(() => registry.validate(auth.schemaPath, { alpha: { type: "api", key: "<your-api-key>" } })).not.toThrow();
    expect(() => registry.validate(auth.schemaPath, { alpha: { type: "api" } })).toThrow(/required/);
    expect(() => registry.validate(auth.schemaPath, { alpha: { type: "oauth", key: "<your-api-key>" } })).toThrow(/constant/);
  }
});

it("detects mismatched generic credential identities and inline credentials", () => {
  const config = { provider: { example: { options: {} } } };
  const credential = { type: "api", key: "<your-api-key>" };
  expect(() => assertSeparateCredentials(config, { example: credential })).not.toThrow();
  expect(() => assertSeparateCredentials(config, { other: credential })).toThrow();
  expect(() => assertSeparateCredentials({ provider: { example: { options: { apiKey: "<your-api-key>" } } } }, { example: credential })).toThrow();
});

describe("separate JSONC configurations and API credentials", () => {
  let root: string;
  let cli: string;
  let provider: string;
  beforeEach(() => {
    root = createSource();
    cli = addCli(root);
    provider = addProvider(root);
    const declaration = readJson(join(cli, "cli.json"));
    declaration.files["opencode.jsonc"] = {
      ...declaration.files["config.json"], format: "jsonc", requiredAt: ["cli", "provider"],
    };
    delete declaration.files["config.json"];
    declaration.files["auth.json"] = {
      description: "Independent API credentials", format: "json", schema: "schemas/auth.schema.json",
      levels: ["cli", "provider", "model"], requiredAt: ["cli", "provider"],
    };
    writeJson(join(cli, "cli.json"), declaration);
    writeJson(join(cli, "schemas", "config.schema.json"), {
      $id: "urn:test:separate:config", $comment: "Independent model selection format",
      type: "object", additionalProperties: false, required: ["model"],
      properties: { model: { type: "string" }, key: { type: "string" }, type: { type: "string" } },
    });
    writeJson(join(cli, "schemas", "auth.schema.json"), {
      $id: "urn:test:separate:auth", $comment: "Independent API credential format",
      type: "object", minProperties: 1,
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["type", "key"],
        properties: { type: { const: "api" }, key: { type: "string" } },
      },
    });
    for (const [directory, identity] of [[cli, "<provider-id>"], [provider, "alpha"]]) {
      rmSync(join(directory, "config.json"));
      writeJson(join(directory, "opencode.jsonc"), { model: `${identity}/<model-id>` });
      writeJson(join(directory, "auth.json"), { [identity]: { type: "api", key: "<your-api-key>" } });
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(["cli", "provider"])("requires physical credentials at %s level", (level) => {
    expect(() => validateRepository(root)).not.toThrow();
    const path = join(level === "cli" ? cli : provider, "auth.json");
    rmSync(path);
    expect(() => validateRepository(root)).toThrow(path);
    expect(() => validateRepository(root)).toThrow(/required/);
  });

  it.each(["cli", "provider"])("rejects a missing or obsolete configuration at %s level", (level) => {
    const directory = level === "cli" ? cli : provider;
    rmSync(join(directory, "opencode.jsonc"));
    expect(() => validateRepository(root)).toThrow(/opencode\.jsonc.*required/);
    writeJson(join(directory, "opencode.json"), {});
    expect(() => validateRepository(root)).toThrow(/opencode\.json.*undeclared/);
  });

  it.each(["provider", "model"])("checks configuration and credential identities at %s level", (level) => {
    const directory = level === "provider" ? provider : join(provider, "example-model");
    const modelId = level === "provider" ? "<model-id>" : "example-model";
    if (level === "model") writeJson(join(directory, "models.json"), { models: [{ id: modelId }] });
    writeJson(join(directory, "opencode.jsonc"), { model: `beta/${modelId}` });
    expect(() => validateRepository(root)).toThrow(/opencode\.jsonc.*model must use provider alpha/);
    writeJson(join(directory, "opencode.jsonc"), { model: `alpha/${modelId}` });
    writeJson(join(directory, "auth.json"), { beta: { type: "api", key: "<your-api-key>" } });
    expect(() => validateRepository(root)).toThrow(/auth\.json.*credentials must use provider identity alpha/);
    writeJson(join(directory, "auth.json"), { alpha: { type: "api", key: "<your-api-key>" } });
    expect(() => validateRepository(root)).not.toThrow();
  });

  it.each(["", "not-the-placeholder"])("rejects the API credential key %j", (key) => {
    for (const [directory, identity] of [[cli, "<provider-id>"], [provider, "alpha"]]) {
      const path = join(directory, "auth.json");
      writeJson(path, { [identity]: { type: "api", key } });
      expect(() => validateRepository(root)).toThrow(path);
      expect(() => validateRepository(root)).toThrow(/\.key: must use <your-api-key>/);
      writeJson(path, { [identity]: { type: "api", key: "<your-api-key>" } });
    }
  });

  it("does not treat ordinary key fields as API credentials", () => {
    writeJson(join(provider, "opencode.jsonc"), { model: "alpha/<model-id>", type: "setting", key: "ordinary-name" });
    expect(() => validateRepository(root)).not.toThrow();
  });

  it("resolves partial configuration and credential overrides independently", () => {
    const model = join(provider, "example-model");
    writeJson(join(model, "models.json"), { models: [{ id: "example-model" }] });
    writeJson(join(model, "opencode.jsonc"), { model: "alpha/example-model" });
    let repository = validateRepository(root);
    const resolveFile = (name: string) => resolveTemplate(repository, "sample-tool", "alpha", "example-model", name);
    expect(resolveFile("opencode.jsonc").level).toBe("model");
    expect(resolveFile("auth.json").level).toBe("provider");
    rmSync(join(model, "opencode.jsonc"));
    writeJson(join(model, "auth.json"), { alpha: { type: "api", key: "<your-api-key>" } });
    repository = validateRepository(root);
    expect(resolveFile("opencode.jsonc").level).toBe("provider");
    expect(resolveFile("auth.json").level).toBe("model");

    // Only this synthetic declaration permits provider files to be absent.
    const declaration = readJson(join(cli, "cli.json"));
    for (const name of ["opencode.jsonc", "auth.json"]) {
      declaration.files[name].requiredAt = ["cli"];
      rmSync(join(provider, name));
    }
    writeJson(join(cli, "cli.json"), declaration);
    repository = validateRepository(root);
    expect(resolveFile("opencode.jsonc").level).toBe("cli");
    expect(resolveFile("auth.json").level).toBe("model");
    rmSync(join(model, "auth.json"));
    repository = validateRepository(root);
    expect(resolveFile("auth.json").level).toBe("cli");
  });
});

describe("declarative repository layout", () => {
  let root: string;
  let cli: string;
  let provider: string;
  beforeEach(() => {
    root = createSource();
    cli = addCli(root);
    provider = addProvider(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("discovers new CLIs and different provider subsets without a supported-ID list", () => {
    addCli(root, "another-tool");
    addProvider(root, "another-tool", "beta");
    writeJson(join(provider, "family", "vision", "models.json"), { models: [{ id: "family/vision" }] });
    const repository = validateRepository(root);
    expect(repository.clis.map((entry) => entry.id)).toEqual(["another-tool", "sample-tool"]);
    expect(repository.providers.map((entry) => [entry.cliId, entry.providerId])).toEqual([
      ["another-tool", "beta"],
      ["sample-tool", "alpha"],
    ]);
    expect(repository.templates.some((entry) => entry.modelId === "family/vision")).toBe(true);
    rmSync(cli, { recursive: true });
    expect(() => validateRepository(root)).not.toThrow();
    rmSync(join(root, "cli", "another-tool", "beta"), { recursive: true });
    expect(() => validateRepository(root)).not.toThrow();
  });

  it.each([
    ["missing declaration", (path: string) => rmSync(join(path, "cli.json")), /cli\.json/],
    ["undeclared file", (path: string) => writeFileSync(join(path, "notes.txt"), "extra"), /notes\.txt.*undeclared/],
    ["misplaced provider metadata", (path: string) => writeJson(join(path, "provider.json"), {}), /provider\.json.*misplaced/],
    ["missing required template", (path: string) => rmSync(join(path, "config.json")), /config\.json.*required/],
    ["missing Schema", (path: string) => rmSync(join(path, "schemas", "config.schema.json")), /config\.schema\.json.*missing/],
    ["invalid Schema directory entry", (path: string) => writeFileSync(join(path, "schemas", "notes.txt"), "extra"), /notes\.txt.*schemas/],
  ] as const)("rejects %s with its path", (_label, mutate, error) => {
    mutate(cli);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it.each([
    ["unsupported manifest field", (d: any) => { d.supportedProviders = ["alpha"]; }, /additional properties/],
    ["empty file declarations", (d: any) => { d.files = {}; }, /properties/],
    ["required but disallowed level", (d: any) => { d.files["config.json"].requiredAt = ["other"]; }, /enum/],
    ["requiredAt outside levels", (d: any) => { d.files["config.json"].levels = ["provider"]; }, /requiredAt.*subset/],
    ["Schema outside local directory", (d: any) => { d.files["config.json"].schema = "../../outside.json"; }, /pattern/],
    ["reserved filename", (d: any) => { d.files["provider.json"] = d.files["config.json"]; }, /property name|NOT be valid/],
    ["kind rule without map", (d: any) => { d.files["config.json"].providerKinds = ["builtin"]; }, /without a providerMap/],
  ] as const)("rejects %s in cli.json", (_label, mutate, error) => {
    const declaration = readJson(join(cli, "cli.json"));
    mutate(declaration);
    writeJson(join(cli, "cli.json"), declaration);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it("does not silently skip an undeclared CLI or a provider missing metadata", () => {
    mkdirSync(join(root, "cli", "unregistered-tool"));
    expect(() => validateRepository(root)).toThrow(/unregistered-tool.*cli\.json/);
    rmSync(join(root, "cli", "unregistered-tool"), { recursive: true });
    rmSync(join(provider, "provider.json"));
    expect(() => validateRepository(root)).toThrow(/alpha.*provider\.json/);
  });

  it("rejects a CLI tree placed outside cli/ and metadata at the repository root", () => {
    const misplaced = join(root, "sample-tool");
    renameSync(cli, misplaced);
    expect(() => validateRepository(root)).toThrow(/sample-tool.*under cli\//);
    renameSync(misplaced, cli);
    writeJson(join(root, "provider.json"), {});
    expect(() => validateRepository(root)).toThrow(/provider\.json.*misplaced/);
  });

  it("rejects a CLI name that would overwrite a generated root artifact", () => {
    renameSync(cli, join(root, "cli", "providers.json"));
    expect(() => validateRepository(root)).toThrow(/providers\.json.*publication artifact/);
  });

  it("rejects loose files in cli/ and unknown provider IDs", () => {
    writeFileSync(join(root, "cli", "loose.json"), "{}");
    expect(() => validateRepository(root)).toThrow(/loose\.json.*CLI directories/);
    rmSync(join(root, "cli", "loose.json"));
    mkdirSync(join(cli, "unknown-provider"));
    expect(() => validateRepository(root)).toThrow(/unknown-provider.*api\.json/);
  });

  it.each([
    ["wrong provider ID", (path: string) => {
      const metadata = readJson(join(path, "provider.json"));
      metadata.id = "beta";
      writeJson(join(path, "provider.json"), metadata);
    }, /provider\.json.*directory/],
    ["invalid model ID", (path: string) => writeJson(join(path, "missing-model", "models.json"), { models: [{ id: "missing-model" }] }), /missing-model.*api\.json/],
    ["empty model directory", (path: string) => mkdirSync(join(path, "example-model")), /empty or unsupported/],
    ["extra model nesting", (path: string) => writeJson(join(path, "example-model", "extra", "models.json"), {}), /example-model.*unsupported model directory/],
    ["model metadata", (path: string) => writeJson(join(path, "example-model", "provider.json"), {}), /provider\.json.*misplaced/],
  ] as const)("rejects %s", (_label, mutate, error) => {
    mutate(provider);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it("enforces declared levels even when a file has valid contents", () => {
    const declaration = readJson(join(cli, "cli.json"));
    declaration.files["models.json"].levels = ["cli", "provider"];
    writeJson(join(cli, "cli.json"), declaration);
    writeJson(join(provider, "example-model", "models.json"), { models: [{ id: "example-model" }] });
    expect(() => validateRepository(root)).toThrow(/models\.json.*model level/);
  });

  it.each([
    ["missing field", { provider: "alpha", apiKey: "<your-api-key>" }, /required/],
    ["wrong type", { provider: "alpha", model: 5, apiKey: "<your-api-key>" }, /string/],
    ["unknown field", { provider: "alpha", model: "example-model", apiKey: "<your-api-key>", unexpected: true }, /additional properties/],
    ["credential value", { provider: "alpha", model: "example-model", apiKey: "not-the-placeholder" }, /<your-api-key>/],
    ["provider placeholder", { provider: "<provider-id>", model: "example-model", apiKey: "<your-api-key>" }, /provider placeholders/],
  ] as const)("rejects %s using the declared format, Schema, or shared rule", (_label, config, error) => {
    writeJson(join(provider, "config.json"), config);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it("rejects a provider template that references a different provider", () => {
    writeJson(join(provider, "config.json"), {
      provider: "beta",
      model: "<model-id>",
      apiKey: "<your-api-key>",
    });
    expect(() => validateRepository(root)).toThrow(/config\.json.*provider reference.*alpha/);
  });

  it("rejects a template endpoint outside the provider metadata base URL", () => {
    const schemaPath = join(cli, "schemas", "config.schema.json");
    const schema = readJson(schemaPath);
    schema.properties.baseUrl = { type: "string", pattern: "^https://" };
    writeJson(schemaPath, schema);
    writeJson(join(provider, "config.json"), {
      provider: "alpha",
      model: "<model-id>",
      apiKey: "<your-api-key>",
      baseUrl: "https://beta.example/v1",
    });
    expect(() => validateRepository(root)).toThrow(/config\.json.*endpoint.*provider metadata/);
  });

  it.each([
    ["provider", (config: any, models: any) => {
      config.provider = "alpha";
      models.models[0].id = "<model-id>";
    }, /CLI templates.*provider placeholder/],
    ["model", (config: any, models: any) => {
      config.model = "example-model";
      models.models[0].id = "example-model";
    }, /CLI templates.*model placeholder/],
  ] as const)("rejects a CLI fallback without a %s placeholder", (_label, mutate, error) => {
    const configPath = join(cli, "config.json");
    const modelsPath = join(cli, "models.json");
    const config = readJson(configPath);
    const models = readJson(modelsPath);
    mutate(config, models);
    writeJson(configPath, config);
    writeJson(modelsPath, models);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it("reports parsing errors with the template path", () => {
    writeFileSync(join(provider, "config.json"), "{invalid JSON");
    expect(() => validateRepository(root)).toThrow(/alpha.*config\.json/);
  });

  it("rejects unresolved model placeholders in a model override", () => {
    writeJson(join(provider, "example-model", "models.json"), { models: [{ id: "<model-id>" }] });
    expect(() => validateRepository(root)).toThrow(/models\.json.*concrete model/);
  });

  it("rejects a model override whose concrete ID differs from its directory", () => {
    writeJson(join(provider, "example-model", "models.json"), { models: [{ id: "different-model" }] });
    expect(() => validateRepository(root)).toThrow(/models\.json.*concrete model example-model/);
  });

  it("rejects canonical endpoint and metadata mismatches across discovered CLIs", () => {
    const metadata = readJson(join(provider, "provider.json"));
    metadata.base_url = "https://alpha.example/v2";
    writeJson(join(provider, "provider.json"), metadata);
    expect(() => validateRepository(root)).toThrow(/provider\.json.*exactly match api\.json/);
    metadata.base_url = "https://alpha.example/v1";
    writeJson(join(provider, "provider.json"), metadata);
    addCli(root, "another-tool");
    const other = addProvider(root, "another-tool", "alpha", { name: "Different name" });
    expect(() => validateRepository(root)).toThrow(/provider\.json.*inconsistent provider/);
    const otherMetadata = readJson(join(other, "provider.json"));
    Object.assign(otherMetadata, { name: "alpha", protocol: "messages", base_url: "https://alpha.example/a" });
    Object.assign(metadata, { protocol: "messages", base_url: "https://alpha.example/b" });
    writeJson(join(other, "provider.json"), otherMetadata);
    writeJson(join(provider, "provider.json"), metadata);
    expect(() => validateRepository(root)).toThrow(/provider\.json.*inconsistent canonical endpoint/);
  });

  it("reports an invalid metadata URL with its file path", () => {
    const path = join(provider, "provider.json");
    writeJson(path, { ...readJson(path), base_url: "https://?" });
    expect(() => validateRepository(root)).toThrow(/provider\.json.*invalid endpoint URL/);
  });

  it("resolves each file independently across partial model and provider overrides", () => {
    writeJson(join(provider, "example-model", "models.json"), { models: [{ id: "example-model" }] });
    let repository = validateRepository(root);
    expect(resolveTemplate(repository, "sample-tool", "alpha", "example-model", "models.json").level).toBe("model");
    expect(resolveTemplate(repository, "sample-tool", "alpha", "example-model", "config.json").level).toBe("provider");
    expect(resolveTemplate(repository, "sample-tool", "alpha", "family/vision", "models.json").level).toBe("cli");
    rmSync(join(provider, "config.json"));
    repository = validateRepository(root);
    expect(resolveTemplate(repository, "sample-tool", "alpha", "example-model", "config.json").level).toBe("cli");
    expect(resolveTemplate(repository, "sample-tool", "alpha", "example-model", "unknown.json")).toBeUndefined();
  });

  it("requires mapped-provider files and selects kind-specific Schemas without provider-name branches", () => {
    const declaration = readJson(join(cli, "cli.json"));
    declaration.providerMap = "../../pi-provider-map.json";
    declaration.files["models.json"].requiredAt = ["cli", "provider"];
    declaration.files["models.json"].schemasByProviderKind = { builtin: "schemas/empty.schema.json" };
    declaration.files["auth.json"] = {
      description: "Builtin credentials", format: "json", schema: "schemas/auth.schema.json",
      levels: ["provider", "model"], requiredAt: ["provider"], providerKinds: ["builtin"],
    };
    writeJson(join(cli, "cli.json"), declaration);
    writeJson(join(cli, "schemas", "empty.schema.json"), {
      $id: "urn:test:empty", $comment: "Stops generic fallback", type: "object",
      required: ["providers"], additionalProperties: false, properties: { providers: { type: "object", maxProperties: 0 } },
    });
    writeJson(join(cli, "schemas", "auth.schema.json"), {
      $id: "urn:test:auth", $comment: "Credential shape", type: "object",
      required: ["apiKey"], additionalProperties: false, properties: { apiKey: { const: "<your-api-key>" } },
    });
    writeJson(join(provider, "models.json"), { providers: {} });
    writeJson(join(provider, "auth.json"), { apiKey: "<your-api-key>" });
    const custom = addProvider(root, "sample-tool", "beta");
    writeJson(join(custom, "models.json"), { models: [{ id: "<model-id>" }] });
    const repository = validateRepository(root);
    expect(resolveTemplate(repository, "sample-tool", "alpha", "example-model", "models.json").level).toBe("provider");

    writeJson(join(custom, "auth.json"), { apiKey: "<your-api-key>" });
    expect(() => validateRepository(root)).toThrow(/auth\.json.*provider kind/);
    rmSync(join(custom, "auth.json"));
    writeJson(join(provider, "models.json"), { providers: { unexpected: {} } });
    expect(() => validateRepository(root)).toThrow(/models\.json.*properties/);
    writeJson(join(provider, "models.json"), { providers: {} });
    rmSync(join(provider, "models.json"));
    expect(() => validateRepository(root)).toThrow(/models\.json.*required/);
    writeJson(join(provider, "models.json"), { providers: {} });
    rmSync(join(provider, "auth.json"));
    expect(() => validateRepository(root)).toThrow(/auth\.json.*required/);
  });

  it("rejects missing provider mappings instead of inferring them by name", () => {
    const declaration = readJson(join(cli, "cli.json"));
    declaration.providerMap = "../../pi-provider-map.json";
    writeJson(join(cli, "cli.json"), declaration);
    writeJson(join(root, "pi-provider-map.json"), { mappings: {} });
    expect(() => validateRepository(root)).toThrow(/alpha.*no mapping/);
  });

  it("compiles every local Schema, including unreferenced ones, and rejects remote refs", () => {
    writeJson(join(cli, "schemas", "unused.schema.json"), {
      $id: "urn:test:unused", $comment: "Must still be checked", $ref: "https://example.com/remote.json",
    });
    expect(() => validateRepository(root)).toThrow(/unused\.schema\.json.*remote \$ref/);
  });

  it("rejects unresolved local refs and duplicate Schema IDs", () => {
    const path = join(cli, "schemas", "models.schema.json");
    const schema = readJson(path);
    writeJson(path, { ...schema, $ref: "urn:test:missing" });
    expect(() => validateRepository(root)).toThrow(/models\.schema\.json/);
    writeJson(path, { ...schema, $id: "urn:test:sample-tool:config" });
    expect(() => validateRepository(root)).toThrow(/duplicate Schema ID/);
  });
});
