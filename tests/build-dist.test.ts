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
import { generateDirectoryIndexes } from "../scripts/build-dist.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(rootDir, "dist");

function snapshotDirectory(directory: string): unknown {
  if (!existsSync(directory)) return null;

  const directoryStat = statSync(directory);
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, directory: snapshotDirectory(entryPath) };
      }
      const fileStat = statSync(entryPath);
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
