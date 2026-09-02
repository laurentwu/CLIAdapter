import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The production build script is intentionally plain JavaScript.
import { collectProviders, generateDirectoryIndexes } from "../scripts/build-dist.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(rootDir, "dist");

type ProviderArtifact = {
  id: string;
  name: string;
  env: string[];
  endpoints: Array<{ protocol: string; url: string }>;
};

type ProviderFixture = {
  cli: string;
  metadata: {
    id: string;
    name: string;
    env: string[];
    protocol: string;
    base_url: string;
  };
};

const fixtureCliDirectories = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "qwen",
  "kimi",
  "codebuddy",
  "crush",
  "goose",
];

function createProviderSourceFixture(providers: ProviderFixture[]): string {
  const root = mkdtempSync(join(tmpdir(), "cli-config-providers-"));
  writeFileSync(
    join(root, "api.json"),
    JSON.stringify({ fixture: { api: "https://api.example.com/v1" } }),
  );
  for (const cli of fixtureCliDirectories) {
    mkdirSync(join(root, cli), { recursive: true });
  }
  for (const provider of providers) {
    const providerDirectory = join(root, provider.cli, provider.metadata.id);
    mkdirSync(providerDirectory, { recursive: true });
    writeFileSync(
      join(providerDirectory, "provider.json"),
      JSON.stringify(provider.metadata),
    );
  }
  return root;
}

function snapshotDirectory(directory: string): unknown {
  if (!existsSync(directory)) return null;

  const directoryStat = statSync(directory, { bigint: true });
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, directory: snapshotDirectory(entryPath) };
      }
      const fileStat = statSync(entryPath, { bigint: true });
      return {
        name: entry.name,
        size: fileStat.size,
        inode: String(fileStat.ino),
        modified: String(fileStat.mtimeNs),
      };
    });

  return {
    inode: String(directoryStat.ino),
    modified: String(directoryStat.mtimeNs),
    entries,
  };
}

describe("Pages directory indexes", () => {
  it("generates a navigable index for every published directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-config-pages-"));
    try {
      mkdirSync(join(root, "folder", "nested"), { recursive: true });
      writeFileSync(join(root, "README & notes.md"), "notes");
      writeFileSync(join(root, "folder", "config.toml"), "config");

      generateDirectoryIndexes(root);

      expect(existsSync(join(root, "index.html"))).toBe(true);
      expect(existsSync(join(root, "folder", "index.html"))).toBe(true);
      expect(existsSync(join(root, "folder", "nested", "index.html"))).toBe(true);

      const rootIndex = readFileSync(join(root, "index.html"), "utf8");
      expect(rootIndex).toContain('href="folder/"');
      expect(rootIndex).toContain('href="README%20%26%20notes.md"');
      expect(rootIndex).toContain("README &amp; notes.md");
      expect(rootIndex).not.toContain(">index.html<");

      const folderIndex = readFileSync(join(root, "folder", "index.html"), "utf8");
      expect(folderIndex).toContain('href="../"');
      expect(folderIndex).toContain('href="nested/"');
      expect(folderIndex).toContain('href="config.toml"');

      const nestedIndex = readFileSync(join(root, "folder", "nested", "index.html"), "utf8");
      expect(nestedIndex).toContain('<a href="../../">Root</a>');
      expect(nestedIndex).toContain('<a href="../">folder</a>');
      expect(nestedIndex).toContain('<span aria-current="page">nested</span>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not run the destructive build when imported", () => {
    const scriptUrl = pathToFileURL(join(rootDir, "scripts", "build-dist.mjs")).href;
    const beforeImport = snapshotDirectory(distDirectory);
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(scriptUrl)});`],
      { cwd: rootDir, encoding: "utf8" },
    );
    const afterImport = snapshotDirectory(distDirectory);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(afterImport).toEqual(beforeImport);
  });
});

describe("providers artifact", () => {
  it("aggregates each configured provider and its canonical protocol endpoints", () => {
    const providers = collectProviders(rootDir) as ProviderArtifact[];

    expect(providers.map((provider) => provider.id)).toEqual([
      "deepseek",
      "opencode",
      "opencode-go",
      "zai",
      "zai-coding-plan",
      "zhipuai",
      "zhipuai-coding-plan",
    ]);
    expect(providers.find((provider) => provider.id === "deepseek")).toEqual({
      id: "deepseek",
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      endpoints: [
        {
          protocol: "anthropic-messages",
          url: "https://api.deepseek.com/anthropic",
        },
        {
          protocol: "openai-compatible",
          url: "https://api.deepseek.com",
        },
        {
          protocol: "responses",
          url: "https://api.deepseek.com",
        },
      ],
    });

    for (const provider of providers) {
      expect(provider.endpoints).toHaveLength(3);
      expect(new Set(provider.endpoints.map(({ protocol }) => protocol)).size).toBe(3);
    }
  });

  it("writes a deterministic root-level providers.json linked from the index", () => {
    const buildScript = join(rootDir, "scripts", "build-dist.mjs");
    const firstBuild = spawnSync(process.execPath, [buildScript], {
      cwd: rootDir,
      encoding: "utf8",
    });

    expect(firstBuild.status).toBe(0);
    expect(firstBuild.stderr).toBe("");
    const firstOutput = readFileSync(join(distDirectory, "providers.json"), "utf8");
    expect(JSON.parse(firstOutput)).toEqual(collectProviders(rootDir));
    expect(readFileSync(join(distDirectory, "index.html"), "utf8")).toContain(
      'href="providers.json"',
    );

    const secondBuild = spawnSync(process.execPath, [buildScript], {
      cwd: rootDir,
      encoding: "utf8",
    });
    expect(secondBuild.status).toBe(0);
    expect(secondBuild.stderr).toBe("");
    expect(readFileSync(join(distDirectory, "providers.json"), "utf8")).toBe(
      firstOutput,
    );
  });

  it("rejects an OpenAI-compatible endpoint that differs from api.json", () => {
    const root = createProviderSourceFixture([
      {
        cli: "claude",
        metadata: {
          id: "fixture",
          name: "Fixture",
          env: ["FIXTURE_API_KEY"],
          protocol: "openai-compatible",
          base_url: "https://api.example.com/v2",
        },
      },
    ]);

    try {
      expect(() => collectProviders(root)).toThrow(
        "must use the canonical api.json endpoint",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects inconsistent provider environment metadata", () => {
    const root = createProviderSourceFixture([
      {
        cli: "claude",
        metadata: {
          id: "fixture",
          name: "Fixture",
          env: ["FIXTURE_API_KEY"],
          protocol: "anthropic-messages",
          base_url: "https://api.example.com/anthropic",
        },
      },
      {
        cli: "codex",
        metadata: {
          id: "fixture",
          name: "Fixture",
          env: ["OTHER_API_KEY"],
          protocol: "responses",
          base_url: "https://api.example.com/v1",
        },
      },
    ]);

    try {
      expect(() => collectProviders(root)).toThrow(
        "has inconsistent name or env metadata",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
