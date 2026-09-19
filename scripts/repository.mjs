import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

function entries(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function requireFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(path, "required file is missing");
}

export function schemaPaths(directory) {
  return entries(directory).map((entry) => {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".schema.json")) {
      fail(path, "schemas directories may only contain local *.schema.json files");
    }
    return path;
  });
}

function applies(rule, level, mapping) {
  return !rule.providerKinds || (level !== "cli" && rule.providerKinds.includes(mapping?.kind));
}

/** Discover every directory before validating it; malformed trees are never filtered out. */
export function discoverRepository(sourceRoot, { validateDeclaration = () => {} } = {}) {
  const root = resolve(sourceRoot);
  const cliRoot = join(root, "cli");
  const catalog = readJson(join(root, "api.json"));
  const repository = { root, catalog, clis: [], providers: [], templates: [], artifacts: [] };

  for (const entry of entries(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name !== "cli" && existsSync(join(path, "cli.json"))) {
      fail(path, "CLI source trees must be placed under cli/");
    }
    if (entry.isFile() && ["cli.json", "provider.json"].includes(entry.name)) {
      fail(path, "misplaced CLI/provider metadata");
    }
  }

  for (const cliEntry of entries(cliRoot)) {
    const directory = join(cliRoot, cliEntry.name);
    if (!cliEntry.isDirectory()) fail(directory, "cli/ may only contain CLI directories");
    if (["LICENSE", "pi-provider-map.json", "providers.json", "index.html"].includes(cliEntry.name)) {
      fail(directory, "CLI directory name conflicts with a root publication artifact");
    }
    const declarationPath = join(directory, "cli.json");
    const declaration = readJson(declarationPath);
    validateDeclaration(declarationPath, declaration);
    if (!declaration || !declaration.files || typeof declaration.files !== "object" || Array.isArray(declaration.files)) {
      fail(declarationPath, "files must declare the template files");
    }
    if (!Object.keys(declaration.files).length) fail(declarationPath, "at least one template must be declared");

    let providerMap;
    if (declaration.providerMap !== undefined) {
      if (!/^\.\.\/\.\.\/[^/\\]+\.json$/.test(declaration.providerMap)) {
        fail(declarationPath, "providerMap must reference a root-level JSON file");
      }
      providerMap = readJson(resolve(directory, declaration.providerMap));
      if (!providerMap || !providerMap.mappings || typeof providerMap.mappings !== "object" || Array.isArray(providerMap.mappings)) {
        fail(declarationPath, "providerMap must contain mappings");
      }
    }

    const localSchemas = schemaPaths(join(directory, "schemas"));
    for (const [fileName, rule] of Object.entries(declaration.files)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName) ||
          ["cli.json", "provider.json", "schemas", "index.html"].includes(fileName)) {
        fail(declarationPath, `invalid or reserved template filename ${fileName}`);
      }
      if (!rule || !["json", "toml", "yaml", "text"].includes(rule.format) ||
          !Array.isArray(rule.levels) || !rule.levels.length ||
          rule.levels.some((level) => !["cli", "provider", "model"].includes(level)) ||
          !Array.isArray(rule.requiredAt)) {
        fail(declarationPath, `${fileName} must declare format, levels, and requiredAt`);
      }
      if (rule.requiredAt.some((level) => !rule.levels.includes(level))) {
        fail(declarationPath, `${fileName}.requiredAt must be a subset of levels`);
      }
      if ((rule.providerKinds || rule.schemasByProviderKind) && !providerMap) {
        fail(declarationPath, `${fileName} uses provider kinds without a providerMap`);
      }
      if (rule.providerKinds && (!Array.isArray(rule.providerKinds) || rule.levels.includes("cli"))) {
        fail(declarationPath, `${fileName}.providerKinds applies only to provider/model levels`);
      }
      for (const schema of [rule.schema, ...Object.values(rule.schemasByProviderKind ?? {})]) {
        if (typeof schema !== "string" || !/^schemas\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.schema\.json$/.test(schema)) {
          fail(declarationPath, `${fileName} must reference a local schemas/*.schema.json file`);
        }
        requireFile(join(directory, schema));
      }
    }

    const cli = { id: cliEntry.name, directory, declarationPath, declaration, schemaPaths: localSchemas };
    repository.clis.push(cli);

    function addLevel(levelDirectory, level, context = {}) {
      const children = [];
      const found = new Set();
      for (const entry of entries(levelDirectory)) {
        const path = join(levelDirectory, entry.name);
        if (entry.isDirectory()) {
          if (level === "cli" && entry.name === "schemas") continue;
          children.push(path);
          continue;
        }
        if (!entry.isFile()) fail(path, "only regular files and directories are allowed");
        if (level === "cli" && entry.name === "cli.json") continue;
        if (level === "provider" && entry.name === "provider.json") continue;
        const rule = Object.hasOwn(declaration.files, entry.name) ? declaration.files[entry.name] : undefined;
        if (!rule) fail(path, "undeclared template or misplaced metadata");
        if (!rule.levels.includes(level)) fail(path, `not allowed at ${level} level`);
        if (!applies(rule, level, context.mapping)) fail(path, "not allowed for this provider kind");
        found.add(entry.name);
        const schema = rule.schemasByProviderKind?.[context.mapping?.kind] ?? rule.schema;
        const template = {
          sourcePath: path,
          publishedPath: relative(cliRoot, path),
          fileName: entry.name,
          cliId: cli.id,
          level,
          format: rule.format,
          schemaPath: join(directory, schema),
          ...context,
        };
        repository.templates.push(template);
        repository.artifacts.push(template);
      }
      for (const [fileName, rule] of Object.entries(declaration.files)) {
        if (applies(rule, level, context.mapping) && rule.requiredAt.includes(level) && !found.has(fileName)) {
          fail(join(levelDirectory, fileName), `required ${level}-level template is missing`);
        }
      }
      return { children };
    }

    const { children: providerDirectories } = addLevel(directory, "cli");
    for (const providerDirectory of providerDirectories) {
      const providerId = relative(directory, providerDirectory);
      if (!Object.hasOwn(catalog, providerId)) fail(providerDirectory, "provider ID is not in api.json");
      const metadataPath = join(providerDirectory, "provider.json");
      const metadata = readJson(metadataPath);
      if (!metadata || metadata.id !== providerId) fail(metadataPath, "id must match its provider directory");
      const mapping = providerMap?.mappings[providerId];
      if (providerMap && !Object.hasOwn(providerMap.mappings, providerId)) {
        fail(providerDirectory, "provider has no mapping in the declared providerMap");
      }
      if (providerMap && (!mapping || !["builtin", "custom"].includes(mapping.kind))) {
        fail(providerDirectory, "provider mapping has an invalid kind");
      }
      const context = { providerId, mapping };
      repository.providers.push({ cliId: cli.id, directory: providerDirectory, metadataPath, metadata, ...context });
      repository.artifacts.push({ sourcePath: metadataPath, publishedPath: relative(cliRoot, metadataPath) });
      const { children: modelDirectories } = addLevel(providerDirectory, "provider", context);

      function addModel(modelDirectory) {
        const modelId = relative(providerDirectory, modelDirectory).split("\\").join("/");
        const modelEntries = entries(modelDirectory);
        const hasFiles = modelEntries.some((entry) => !entry.isDirectory());
        const models = catalog[providerId].models ?? {};
        if (hasFiles && !Object.hasOwn(models, modelId)) {
          fail(modelDirectory, `model ID ${modelId} is not in api.json for ${providerId}`);
        }
        if (!hasFiles) {
          if (!modelEntries.length || !Object.keys(models).some((id) => id.startsWith(`${modelId}/`))) {
            fail(modelDirectory, "empty or unsupported model directory");
          }
          for (const entry of modelEntries) addModel(join(modelDirectory, entry.name));
          return;
        }
        const { children } = addLevel(modelDirectory, "model", { ...context, modelId });
        for (const child of children) addModel(child);
      }
      for (const modelDirectory of modelDirectories) addModel(modelDirectory);
    }
  }
  return repository;
}

/** Resolve one declared file, not an entire directory, including partial model overrides. */
export function resolveTemplate(repository, cliId, providerId, modelId, fileName) {
  const candidates = [
    join(repository.root, "cli", cliId, providerId, modelId, fileName),
    join(repository.root, "cli", cliId, providerId, fileName),
    join(repository.root, "cli", cliId, fileName),
  ];
  for (const path of candidates) {
    const template = repository.templates.find((entry) => entry.sourcePath === path);
    if (template) return template;
  }
  return undefined;
}
