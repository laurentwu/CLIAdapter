import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The production build utilities intentionally use plain JavaScript.
import { build, collectProviders, generateDirectoryIndexes } from "../scripts/build-dist.mjs";
import { addCli, addProvider, createSource, readJson, writeJson } from "./support/fixtures.js";
import { rootDir } from "./support/repository.js";

function listFiles(directory: string, base = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)];
  }).sort();
}

function contents(directory: string): Record<string, string> {
  return Object.fromEntries(listFiles(directory).map((path) => [path, readFileSync(join(directory, path), "utf8")]));
}

function snapshotDirectory(directory: string): unknown {
  if (!existsSync(directory)) return null;
  const stats = statSync(directory, { bigint: true });
  return {
    inode: String(stats.ino), modified: String(stats.mtimeNs),
    entries: readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return { name: entry.name, directory: snapshotDirectory(path) };
      const file = statSync(path, { bigint: true });
      return { name: entry.name, size: file.size, inode: String(file.ino), modified: String(file.mtimeNs) };
    }),
  };
}

describe("directory indexes and publishing", () => {
  let root: string;
  beforeEach(() => { root = createSource(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("generates navigable indexes with breadcrumbs, encoded URLs, and escaped labels", () => {
    const output = join(root, "preview");
    mkdirSync(join(output, "folder", "nested"), { recursive: true });
    writeFileSync(join(output, "README & notes.md"), "notes");
    writeFileSync(join(output, "folder", "config.toml"), "config");
    generateDirectoryIndexes(output);
    const rootIndex = readFileSync(join(output, "index.html"), "utf8");
    expect(rootIndex).toContain('href="folder/"');
    expect(rootIndex).toContain('href="README%20%26%20notes.md"');
    expect(rootIndex).toContain("README &amp; notes.md");
    expect(rootIndex).not.toContain(">index.html<");
    const folderIndex = readFileSync(join(output, "folder", "index.html"), "utf8");
    expect(folderIndex).toContain('href="../"');
    expect(folderIndex).toContain('href="nested/"');
    expect(folderIndex).toContain('href="config.toml"');
    const nestedIndex = readFileSync(join(output, "folder", "nested", "index.html"), "utf8");
    expect(nestedIndex).toContain('<a href="../../">Root</a>');
    expect(nestedIndex).toContain('<a href="../">folder</a>');
    expect(nestedIndex).toContain('<span aria-current="page">nested</span>');
  });

  it("does not build or change existing output when imported", () => {
    const output = join(rootDir, "dist");
    const before = snapshotDirectory(output);
    const script = pathToFileURL(join(rootDir, "scripts", "build-dist.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(" + JSON.stringify(script) + ");"], { cwd: rootDir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(snapshotDirectory(output)).toEqual(before);
  });

  it("aggregates arbitrary providers with different protocol counts, removes duplicates, and sorts output", () => {
    addCli(root, "z-tool");
    addProvider(root, "z-tool", "beta");
    addProvider(root, "z-tool", "alpha", { env: ["Z_KEY", "A_KEY"] });
    addCli(root, "a-tool");
    addProvider(root, "a-tool", "alpha", {
      env: ["A_KEY", "Z_KEY"], protocol: "messages", base_url: "https://alpha.example/messages",
    });
    addCli(root, "duplicate-tool");
    addProvider(root, "duplicate-tool", "alpha", { env: ["A_KEY", "Z_KEY"] });
    expect(collectProviders(root)).toEqual([
      {
        id: "alpha", name: "alpha", env: ["A_KEY", "Z_KEY"],
        endpoints: [
          { protocol: "messages", url: "https://alpha.example/messages" },
          { protocol: "openai-compatible", url: "https://alpha.example/v1" },
        ],
      },
      { id: "beta", name: "beta", env: ["BETA_API_KEY"], endpoints: [{ protocol: "openai-compatible", url: "https://beta.example/v1" }] },
    ]);
  });

  it("publishes every real source template verbatim at its original URL and excludes source-only files", () => {
    for (const directory of ["cli", "schemas"]) {
      cpSync(join(rootDir, directory), join(root, directory), { recursive: true });
    }
    for (const file of ["api.json", "pi-provider-map.json", "LICENSE"]) cpSync(join(rootDir, file), join(root, file));
    writeFileSync(join(root, "notes.md"), "Source-only documentation");
    writeFileSync(join(root, "Plan.md"), "Source-only implementation plan");
    const result = build(root);
    const output = result.directory as string;
    // This independent source walk does not use the builder's discovered artifact list.
    const sourceFiles = listFiles(join(root, "cli")).filter((path) =>
      !path.split("/").includes("schemas") && !path.endsWith("/cli.json"),
    );
    const expectedFiles = new Set([...sourceFiles, "LICENSE", "pi-provider-map.json", "providers.json", "index.html"]);
    for (const path of sourceFiles) {
      expect(readFileSync(join(output, path)), path).toEqual(readFileSync(join(root, "cli", path)));
      if (path.endsWith("/opencode.jsonc")) {
        expect(existsSync(join(output, path.slice(0, -1))), path).toBe(false);
      }
      let parent = dirname(path);
      while (parent !== ".") {
        expectedFiles.add(join(parent, "index.html"));
        parent = dirname(parent);
      }
    }
    expect(listFiles(output)).toEqual([...expectedFiles].sort());
    for (const file of ["LICENSE", "pi-provider-map.json"]) {
      expect(readFileSync(join(output, file))).toEqual(readFileSync(join(root, file)));
    }
    const metadata = sourceFiles.filter((path) => path.endsWith("/provider.json"))
      .map((path) => readJson(join(root, "cli", path)));
    const providers = readJson(join(output, "providers.json")) as unknown as Array<{ id: string; endpoints: Array<{ protocol: string; url: string }> }>;
    expect(providers.map((provider) => provider.id)).toEqual([...new Set(metadata.map((entry) => entry.id))].sort());
    for (const provider of providers) {
      const expectedEndpoints = new Set(metadata.filter((entry) => entry.id === provider.id).map((entry) => entry.protocol + "\n" + entry.base_url));
      expect(provider.endpoints.map((entry) => entry.protocol + "\n" + entry.url).sort()).toEqual([...expectedEndpoints].sort());
    }
    const index = readFileSync(join(output, "index.html"), "utf8");
    expect(index).toContain('href="providers.json"');
    expect(index).toContain('href="pi-provider-map.json"');
    const first = contents(output);
    build(root);
    expect(contents(output)).toEqual(first);
  });

  it("publishes a newly added CLI and accepts removing a provider without allowlist changes", () => {
    addCli(root, "brand-new-tool");
    const provider = addProvider(root, "brand-new-tool", "beta");
    writeJson(join(provider, "example-model", "models.json"), { models: [{ id: "example-model" }] });
    const result = build(root);
    expect(existsSync(join(result.directory, "brand-new-tool", "beta", "example-model", "models.json"))).toBe(true);
    expect(existsSync(join(result.directory, "cli"))).toBe(false);
    expect(existsSync(join(result.directory, "brand-new-tool", "cli.json"))).toBe(false);
    rmSync(provider, { recursive: true });
    build(root);
    expect(existsSync(join(result.directory, "brand-new-tool", "beta"))).toBe(false);
    expect(readJson(join(result.directory, "providers.json"))).toEqual([]);
  });

  it("publishes JSONC verbatim and removes obsolete JSON files and links after migration", () => {
    const cli = addCli(root, "commented-tool");
    const provider = addProvider(root, "commented-tool");
    const model = join(provider, "example-model");
    writeJson(join(model, "config.json"), { provider: "alpha", model: "example-model", apiKey: "<your-api-key>" });
    const declaration = readJson(join(cli, "cli.json"));
    declaration.files["opencode.json"] = declaration.files["config.json"];
    delete declaration.files["config.json"];
    writeJson(join(cli, "cli.json"), declaration);
    const directories = [cli, provider, model];
    for (const directory of directories) {
      renameSync(join(directory, "config.json"), join(directory, "opencode.json"));
    }
    const output = build(root).directory;
    for (const directory of directories) {
      const published = join(output, relative(join(root, "cli"), directory));
      expect(existsSync(join(published, "opencode.json"))).toBe(true);
    }

    declaration.files["opencode.jsonc"] = { ...declaration.files["opencode.json"], format: "jsonc" };
    delete declaration.files["opencode.json"];
    writeJson(join(cli, "cli.json"), declaration);
    for (const directory of directories) {
      const previous = join(directory, "opencode.json");
      const text = readFileSync(previous, "utf8");
      rmSync(previous);
      writeFileSync(join(directory, "opencode.jsonc"), `// Preserve this comment and whitespace.\n${text.replace(/}\s*$/, ",\n}\n")}`);
    }
    build(root);
    for (const directory of directories) {
      const published = join(output, relative(join(root, "cli"), directory));
      expect(readFileSync(join(published, "opencode.jsonc"))).toEqual(readFileSync(join(directory, "opencode.jsonc")));
      expect(existsSync(join(published, "opencode.json"))).toBe(false);
      const index = readFileSync(join(published, "index.html"), "utf8");
      expect(index).toContain('href="opencode.jsonc"');
      expect(index).not.toContain('href="opencode.json"');
    }
  });

  it.each(["LICENSE", "pi-provider-map.json"])("rejects missing root artifact %s before touching previous output", (file) => {
    addCli(root);
    const output = join(root, "dist");
    mkdirSync(output);
    writeFileSync(join(output, "keep.txt"), "previous output");
    rmSync(join(root, file));
    expect(() => build(root)).toThrow(file);
    expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("previous output");
  });

  it("rejects undeclared source files before cleaning previous output", () => {
    const cli = addCli(root);
    const output = build(root).directory;
    const first = contents(output);
    writeFileSync(join(cli, "unexpected.json"), "{}");
    expect(() => build(root)).toThrow(/unexpected\.json.*undeclared/);
    expect(contents(output)).toEqual(first);
  });

  it.each([
    ["noncanonical endpoint", { base_url: "https://alpha.example/v2" }, /canonical api.json endpoint/],
    ["inconsistent environment", { env: ["OTHER_KEY"] }, /inconsistent name or env/],
    ["conflicting protocol endpoint", { protocol: "messages", base_url: "https://alpha.example/other" }, /multiple messages endpoints/],
  ] as const)("rejects %s", (_label, overrides, error) => {
    addCli(root, "a-tool");
    addProvider(root, "a-tool", "alpha", _label === "conflicting protocol endpoint" ? { protocol: "messages", base_url: "https://alpha.example/messages" } : {});
    addCli(root, "b-tool");
    addProvider(root, "b-tool", "alpha", overrides);
    expect(() => collectProviders(root)).toThrow(error);
  });
});
