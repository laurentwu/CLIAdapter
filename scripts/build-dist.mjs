import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(projectRoot, "dist");

const cliDirectories = [
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

function isPublishableSource(sourcePath) {
  const sourceRelativePath = relative(projectRoot, sourcePath);
  if (!sourceRelativePath) return true;

  const pathParts = sourceRelativePath.split(sep);
  const basename = pathParts.at(-1);
  return basename !== "api.json" && !pathParts.includes("schemas");
}

function assertExpectedSourceLayout() {
  for (const cli of cliDirectories) {
    const sourceDirectory = join(projectRoot, cli);
    if (!existsSync(sourceDirectory)) {
      throw new Error(`Expected CLI directory is missing: ${cli}`);
    }
  }
  if (!existsSync(join(projectRoot, "LICENSE"))) {
    throw new Error("Expected LICENSE file is missing");
  }
}

function assertPublishedBoundary() {
  if (existsSync(join(distDirectory, "api.json"))) {
    throw new Error("dist must not contain api.json");
  }

  const unexpectedSchemaDirectories = [];
  for (const cli of cliDirectories) {
    const cliDirectory = join(distDirectory, cli);
    if (readdirSync(cliDirectory, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name === "schemas",
    )) {
      unexpectedSchemaDirectories.push(`${cli}/schemas`);
    }
  }
  if (unexpectedSchemaDirectories.length > 0) {
    throw new Error(
      `dist must not contain schema directories: ${unexpectedSchemaDirectories.join(", ")}`,
    );
  }
}

function build() {
  assertExpectedSourceLayout();

  const resolvedDistDirectory = resolve(distDirectory);
  if (resolvedDistDirectory !== join(resolve(projectRoot), "dist")) {
    throw new Error("Refusing to clean an unexpected dist path");
  }
  rmSync(distDirectory, { recursive: true, force: true });
  mkdirSync(distDirectory, { recursive: true });

  for (const cli of cliDirectories) {
    cpSync(join(projectRoot, cli), join(distDirectory, cli), {
      recursive: true,
      filter: isPublishableSource,
    });
  }
  cpSync(join(projectRoot, "LICENSE"), join(distDirectory, "LICENSE"));

  assertPublishedBoundary();
  console.log(`Built ${cliDirectories.length} CLI template trees in dist/`);
}

build();
