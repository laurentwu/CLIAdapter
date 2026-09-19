import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rootDir, type JsonObject } from "./repository.js";

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

export function createSource(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-config-test-"));
  mkdirSync(join(root, "cli"));
  cpSync(join(rootDir, "schemas"), join(root, "schemas"), { recursive: true });
  writeFileSync(join(root, "LICENSE"), "Fixture license\n");
  writeJson(join(root, "api.json"), {
    alpha: { api: "https://alpha.example/v1", models: { "example-model": {}, "family/vision": {} } },
    beta: { api: "https://beta.example/v1", models: { "example-model": {} } },
  });
  writeJson(join(root, "pi-provider-map.json"), { mappings: { alpha: { kind: "builtin", provider: "internal-alpha" }, beta: { kind: "custom", provider: "custom-beta" } } });
  return root;
}

export function addCli(root: string, id = "sample-tool"): string {
  const directory = join(root, "cli", id);
  writeJson(join(directory, "cli.json"), {
    schemaVersion: 1,
    description: "Independent test CLI",
    files: Object.fromEntries(["config.json", "models.json"].map((fileName) => [fileName, {
      description: fileName === "config.json" ? "Default provider and model" : "Model definitions",
      format: "json",
      schema: `schemas/${fileName.replace(".json", ".schema.json")}`,
      levels: ["cli", "provider", "model"],
      requiredAt: ["cli"],
    }])),
  });
  writeJson(join(directory, "schemas", "config.schema.json"), {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `urn:test:${id}:config`,
    $comment: "Independent test configuration format",
    type: "object",
    additionalProperties: false,
    required: ["provider", "model", "apiKey"],
    properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, apiKey: { type: "string" } },
  });
  writeJson(join(directory, "schemas", "models.schema.json"), {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `urn:test:${id}:models`,
    $comment: "Independent model format",
    type: "object",
    additionalProperties: false,
    required: ["models"],
    properties: { models: { type: "array", minItems: 1, items: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } }, additionalProperties: false } } },
  });
  writeJson(join(directory, "config.json"), { provider: "<provider-id>", model: "<model-id>", apiKey: "<your-api-key>" });
  writeJson(join(directory, "models.json"), { models: [{ id: "<model-id>" }] });
  return directory;
}

export function addProvider(root: string, cli = "sample-tool", id = "alpha", overrides: JsonObject = {}): string {
  const directory = join(root, "cli", cli, id);
  writeJson(join(directory, "provider.json"), {
    id,
    name: id,
    env: [`${id.toUpperCase()}_API_KEY`],
    protocol: "openai-compatible",
    base_url: `https://${id}.example/v1`,
    docs: `https://${id}.example/docs`,
    ...overrides,
  });
  writeJson(join(directory, "config.json"), { provider: id, model: "<model-id>", apiKey: "<your-api-key>" });
  return directory;
}
