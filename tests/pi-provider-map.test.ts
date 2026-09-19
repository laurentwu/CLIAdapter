import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson } from "./support/fixtures.js";
import { rootDir, SchemaRegistry } from "./support/repository.js";
import { mappingErrors, type KnownProviders, type ProviderMap } from "./support/provider-map.js";

const schemaPath = join(rootDir, "schemas", "provider-map.schema.json");
const registry = new SchemaRegistry([schemaPath]);
const baseline = readJson(join(rootDir, "tests", "fixtures", "pi-known-providers.json")) as KnownProviders;

describe("provider-map format and reference consistency", () => {
  it("validates the real map against its Schema, source catalog, and offline compatibility data", () => {
    const candidate = readJson(join(rootDir, "pi-provider-map.json")) as ProviderMap;
    expect(() => registry.validate(schemaPath, candidate)).not.toThrow();
    expect(mappingErrors(candidate, readJson(join(rootDir, "api.json")), baseline)).toEqual([]);
  });

  it("keeps compatibility data well formed without duplicating its upstream ID list", () => {
    expect(baseline.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseline.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.providers.length).toBeGreaterThan(0);
    expect(baseline.providers.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(baseline.providers).toEqual([...new Set(baseline.providers)].sort());
  });

  it.each([
    ["invalid kind", (map: any) => { map.mappings.alpha.kind = "unsupported"; }],
    ["extra field", (map: any) => { map.mappings.alpha.endpoint = "https://example.com"; }],
    ["missing target", (map: any) => { delete map.mappings.alpha.provider; }],
    ["custom alternatives", (map: any) => { map.mappings.beta.alternatives = ["another"]; }],
    ["duplicate alternatives", (map: any) => { map.mappings.alpha.alternatives = ["another", "another"]; }],
  ] as const)("rejects %s through the map Schema", (_label, mutate) => {
    const candidate = {
      schemaVersion: 1,
      pi: { version: baseline.version, commit: baseline.commit },
      mappings: {
        alpha: { kind: "builtin", provider: "fixture-builtin" },
        beta: { kind: "custom", provider: "fixture-custom" },
      },
    };
    expect(() => registry.validate(schemaPath, candidate)).not.toThrow();
    mutate(candidate);
    expect(() => registry.validate(schemaPath, candidate)).toThrow();
  });
});

describe("generic mapping semantics", () => {
  const catalog = { alpha: {}, beta: {}, gamma: {} };
  const known: KnownProviders = { version: "test-version", commit: "test-commit", providers: ["engine-a", "engine-b"] };
  function validMap(): ProviderMap {
    return {
      schemaVersion: 1,
      pi: { version: known.version, commit: known.commit },
      mappings: {
        alpha: { kind: "builtin", provider: "engine-a", alternatives: ["engine-b"] },
        beta: { kind: "builtin", provider: "engine-a" },
        gamma: { kind: "custom", provider: "custom-engine" },
      },
    };
  }

  it("accepts renamed, alternative, many-to-one, and custom mappings without prescribed source IDs", () => {
    expect(mappingErrors(validMap(), catalog, known)).toEqual([]);
    const smaller = validMap();
    delete smaller.mappings.beta;
    expect(mappingErrors(smaller, catalog, known)).toEqual([]);
    const larger = validMap();
    larger.mappings.zeta = { kind: "builtin", provider: "engine-b" };
    expect(mappingErrors(larger, { ...catalog, zeta: {} }, known)).toEqual([]);
  });

  it.each([
    ["version mismatch", (map: ProviderMap) => { map.pi.version = "other"; }, /same version/],
    ["commit mismatch", (map: ProviderMap) => { map.pi.commit = "other"; }, /same version and commit/],
    ["unknown source", (map: ProviderMap) => { map.mappings.unknown = { kind: "builtin", provider: "engine-a" }; }, /not in api.json/],
    ["unknown builtin", (map: ProviderMap) => { map.mappings.alpha.provider = "missing-engine"; }, /unknown builtin/],
    ["custom collision", (map: ProviderMap) => { map.mappings.gamma.provider = "engine-a"; }, /collides/],
    ["unknown alternative", (map: ProviderMap) => { map.mappings.alpha.alternatives = ["missing-engine"]; }, /unknown alternative/],
    ["duplicate alternatives", (map: ProviderMap) => { map.mappings.alpha.alternatives = ["engine-b", "engine-b"]; }, /duplicate alternatives/],
    ["default as alternative", (map: ProviderMap) => { map.mappings.alpha.alternatives = ["engine-a"]; }, /repeats its default/],
    ["unordered sources", (map: ProviderMap) => { map.mappings = Object.fromEntries(Object.entries(map.mappings).reverse()); }, /sorted/],
  ] as const)("rejects %s", (_label, mutate, error) => {
    const candidate = validMap();
    mutate(candidate);
    expect(mappingErrors(candidate, catalog, known).join("\n")).toMatch(error);
  });
});
