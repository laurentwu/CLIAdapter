export type Mapping = { kind: "builtin" | "custom"; provider: string; alternatives?: string[] };
export type ProviderMap = { schemaVersion: number; pi: { version: string; commit: string }; mappings: Record<string, Mapping> };
export type KnownProviders = { version: string; commit: string; providers: string[] };

export function mappingErrors(candidate: ProviderMap, catalog: Record<string, unknown>, baseline: KnownProviders): string[] {
  const errors: string[] = [];
  const known = new Set(baseline.providers);
  if (candidate.pi.version !== baseline.version || candidate.pi.commit !== baseline.commit) {
    errors.push("map and compatibility data must identify the same version and commit");
  }
  const sources = Object.keys(candidate.mappings);
  if (sources.join("\n") !== [...sources].sort().join("\n")) errors.push("source keys must be sorted");
  for (const [source, mapping] of Object.entries(candidate.mappings)) {
    if (!Object.hasOwn(catalog, source)) errors.push(source + " is not in api.json");
    if (mapping.kind === "builtin") {
      if (!known.has(mapping.provider)) errors.push(source + " targets an unknown builtin");
      const alternatives = mapping.alternatives ?? [];
      if (new Set(alternatives).size !== alternatives.length) errors.push(source + " has duplicate alternatives");
      if (alternatives.includes(mapping.provider)) errors.push(source + " repeats its default as an alternative");
      if (alternatives.some((id) => !known.has(id))) errors.push(source + " has an unknown alternative");
    } else if (known.has(mapping.provider)) {
      errors.push(source + " custom identity collides with a builtin");
    }
  }
  return errors;
}
