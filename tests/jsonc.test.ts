import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCli, addProvider, createSource, readJson, writeJson } from "./support/fixtures.js";
import { discoverRepository, parseTemplate, validateRepository } from "./support/repository.js";

describe("declared JSONC templates", () => {
  let root: string;
  let cli: string;
  let path: string;
  beforeEach(() => {
    root = createSource();
    cli = addCli(root, "commented-tool");
    addProvider(root, "commented-tool");
    path = join(cli, "config.json");
    const declaration = readJson(join(cli, "cli.json"));
    // The declared format controls parsing, independently of the CLI ID or filename suffix.
    declaration.files["config.json"].format = "jsonc";
    writeJson(join(cli, "cli.json"), declaration);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function parse(text: string): unknown {
    writeFileSync(path, text);
    const template = discoverRepository(root).templates.find((entry) => entry.sourcePath === path)!;
    return parseTemplate(template);
  }

  it.each([
    ["plain JSON", '{"value":1}'],
    ["line comments", '// leading\n{"value":1 // trailing\n}'],
    ["block comments", '/* leading */ {"value": /* inline */ 1}'],
    ["object trailing commas", '{"value":1,}'],
  ])("accepts %s", (_label, text) => {
    expect(parse(text)).toEqual({ value: 1 });
  });

  it("accepts array trailing commas together with comments and nested objects", () => {
    expect(parse('/* list */ {"values": [1, // item\n {"value":2,},],}'))
      .toEqual({ values: [1, { value: 2 }] });
  });

  it("preserves comment-like strings, URLs, and escaped quotes", () => {
    const value = { url: "https://alpha.example/v1", text: '/* literal */ // "quoted" \\ tail' };
    expect(parse(`// real comment\n${JSON.stringify(value)}`)).toEqual(value);
  });

  it.each([
    ["empty input", ""],
    ["comments only", "// comment\n/* another */"],
    ["unclosed comment", '{"value":1} /* open'],
    ["unclosed string", '{"value":"open}'],
    ["missing comma", '{"first":1 "second":2}'],
    ["missing colon", '{"value" 1}'],
    ["missing brace", '{"value":1'],
    ["missing bracket", '{"value":[1}'],
    ["extra root value", '{"value":1} {}'],
    ["single quotes", "{'value':1}"],
    ["unquoted keys", '{value:1}'],
    ["illegal symbol", '{"value":@}'],
  ])("rejects %s with the path, error name, and offset", (_label, text) => {
    expect(() => parse(text)).toThrow(path);
    expect(() => parse(text)).toThrow(/[A-Z][A-Za-z]+ at offset \d+/);
  });

  it("reports the zero-based character offset", () => {
    expect(() => parse('{"值": 1} {}')).toThrow(/EndOfFileExpected at offset 9/);
  });

  it("validates a newly discovered CLI with JSONC using its local Schema", () => {
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `// CLI fallback\n${original.replace(/}\s*$/, ",\n}")}`);
    expect(() => validateRepository(root)).not.toThrow();
  });

  it("rejects recoverable syntax errors before accepting a Schema-valid result", () => {
    writeFileSync(path, '{"provider":"<provider-id>" "model":"<model-id>","apiKey":"<your-api-key>"}');
    expect(() => validateRepository(root)).toThrow(/config\.json.*CommaExpected at offset/);
  });

  it.each([
    ["wrong type", { provider: "<provider-id>", model: 1, apiKey: "<your-api-key>" }, /string/],
    ["missing required field", { provider: "<provider-id>", apiKey: "<your-api-key>" }, /required/],
  ])("rejects JSONC with %s through its Schema", (_label, value, error) => {
    writeFileSync(path, `/* valid syntax */ ${JSON.stringify(value)}`);
    expect(() => validateRepository(root)).toThrow(path);
    expect(() => validateRepository(root)).toThrow(error);
  });

  it.each(["comment", "trailing comma"])("still rejects a %s in a strict JSON template", (syntax) => {
    const declaration = readJson(join(cli, "cli.json"));
    declaration.files["config.json"].format = "json";
    writeJson(join(cli, "cli.json"), declaration);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, syntax === "comment" ? `// comment\n${original}` : original.replace(/}\s*$/, ",\n}"));
    expect(() => validateRepository(root)).toThrow(path);
  });

  it.each(["api.json", "cli/commented-tool/cli.json", "cli/commented-tool/alpha/provider.json"])(
    "keeps %s as strict JSON metadata",
    (relativePath) => {
      const metadata = join(root, relativePath);
      const original = readFileSync(metadata, "utf8");
      for (const text of [`// comment\n${original}`, original.replace(/}\s*$/, ",\n}")]) {
        writeFileSync(metadata, text);
        expect(() => validateRepository(root)).toThrow(metadata);
      }
    },
  );
});
