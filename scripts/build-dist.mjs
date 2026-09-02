import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function collectProviders(sourceRoot = projectRoot) {
  const apiCatalog = readJson(join(sourceRoot, "api.json"));
  const providers = new Map();

  for (const cli of cliDirectories) {
    const cliDirectory = join(sourceRoot, cli);
    const providerDirectories = readdirSync(cliDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(cliDirectory, entry.name, "provider.json")),
      )
      .sort((left, right) => compareStrings(left.name, right.name));

    for (const providerDirectory of providerDirectories) {
      const providerPath = join(
        cliDirectory,
        providerDirectory.name,
        "provider.json",
      );
      const provider = readJson(providerPath);

      if (provider.id !== providerDirectory.name) {
        throw new Error(
          `${relative(sourceRoot, providerPath)} id must match its directory name`,
        );
      }
      if (!apiCatalog[provider.id]) {
        throw new Error(`${provider.id} must be a provider id in api.json`);
      }
      if (
        typeof provider.name !== "string" ||
        !Array.isArray(provider.env) ||
        !provider.env.every((value) => typeof value === "string") ||
        typeof provider.protocol !== "string" ||
        typeof provider.base_url !== "string"
      ) {
        throw new Error(
          `${relative(sourceRoot, providerPath)} has invalid provider metadata`,
        );
      }
      if (
        provider.protocol === "openai-compatible" &&
        provider.base_url !== apiCatalog[provider.id].api
      ) {
        throw new Error(
          `${relative(sourceRoot, providerPath)} must use the canonical api.json endpoint`,
        );
      }

      const existing = providers.get(provider.id);
      if (!existing) {
        providers.set(provider.id, {
          id: provider.id,
          name: provider.name,
          env: [...provider.env].sort(compareStrings),
          endpoints: new Map([[provider.protocol, provider.base_url]]),
        });
        continue;
      }

      const normalizedEnv = [...provider.env].sort(compareStrings);
      if (
        existing.name !== provider.name ||
        JSON.stringify(existing.env) !== JSON.stringify(normalizedEnv)
      ) {
        throw new Error(`${provider.id} has inconsistent name or env metadata`);
      }

      const existingUrl = existing.endpoints.get(provider.protocol);
      if (existingUrl && existingUrl !== provider.base_url) {
        throw new Error(
          `${provider.id} has multiple ${provider.protocol} endpoints: ${existingUrl}, ${provider.base_url}`,
        );
      }
      existing.endpoints.set(provider.protocol, provider.base_url);
    }
  }

  return [...providers.values()]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      env: provider.env,
      endpoints: [...provider.endpoints]
        .map(([protocol, url]) => ({ protocol, url }))
        .sort(
          (left, right) =>
            compareStrings(left.protocol, right.protocol) ||
            compareStrings(left.url, right.url),
        ),
    }));
}

function isPublishableSource(sourcePath) {
  const sourceRelativePath = relative(projectRoot, sourcePath);
  if (!sourceRelativePath) return true;

  const pathParts = sourceRelativePath.split(sep);
  const basename = pathParts.at(-1);
  return basename !== "api.json" && !pathParts.includes("schemas");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function collectDirectories(directory) {
  const directories = [directory];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(...collectDirectories(join(directory, entry.name)));
    }
  }
  return directories;
}

function renderBreadcrumbs(relativeDirectory) {
  const segments = relativeDirectory ? relativeDirectory.split(sep) : [];
  const rootHref = "../".repeat(segments.length);
  const breadcrumbs = [
    segments.length > 0
      ? `<a href="${rootHref}">Root</a>`
      : "<span aria-current=\"page\">Root</span>",
  ];

  segments.forEach((segment, index) => {
    const isCurrent = index === segments.length - 1;
    const label = escapeHtml(segment);
    if (isCurrent) {
      breadcrumbs.push(`<span aria-current="page">${label}</span>`);
    } else {
      const href = "../".repeat(segments.length - index - 1);
      breadcrumbs.push(`<a href="${href}">${label}</a>`);
    }
  });

  return breadcrumbs.join('<span class="separator" aria-hidden="true">/</span>');
}

function renderDirectoryIndex(rootDirectory, directory) {
  const relativeDirectory = relative(rootDirectory, directory);
  const displayPath = relativeDirectory ? `/${relativeDirectory.split(sep).join("/")}` : "/";
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.name !== "index.html" && (entry.isDirectory() || entry.isFile()),
    )
    .sort((left, right) => {
      const leftIsDirectory = left.isDirectory() ? 0 : 1;
      const rightIsDirectory = right.isDirectory() ? 0 : 1;
      return leftIsDirectory - rightIsDirectory || left.name.localeCompare(right.name);
    });

  const rows = [];
  if (relativeDirectory) {
    rows.push(
      '<li class="entry parent"><span class="icon" aria-hidden="true">↩</span><a href="../">Parent directory</a></li>',
    );
  }
  for (const entry of entries) {
    const isDirectory = entry.isDirectory();
    const href = `${encodeURIComponent(entry.name)}${isDirectory ? "/" : ""}`;
    const icon = isDirectory ? "📁" : "📄";
    const kind = isDirectory ? "directory" : "file";
    rows.push(
      `<li class="entry ${kind}"><span class="icon" aria-hidden="true">${icon}</span><a href="${href}">${escapeHtml(entry.name)}${isDirectory ? "/" : ""}</a></li>`,
    );
  }

  const listing = rows.length
    ? `<ul class="entries">${rows.join("")}</ul>`
    : '<p class="empty">This directory is empty.</p>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Directory listing — ${escapeHtml(displayPath)}</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem 1rem; background: Canvas; color: CanvasText; }
      main { width: min(56rem, 100%); margin: 0 auto; }
      h1 { margin: 0 0 1rem; font-size: 1.6rem; overflow-wrap: anywhere; }
      nav { display: flex; flex-wrap: wrap; gap: .45rem; margin-bottom: 1.5rem; color: GrayText; }
      nav a, nav span { overflow-wrap: anywhere; }
      .separator { margin: 0 .1rem; }
      .entries { list-style: none; padding: 0; margin: 0; border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
      .entry { display: flex; align-items: baseline; gap: .55rem; padding: .65rem .4rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
      .entry a { color: LinkText; overflow-wrap: anywhere; }
      .icon { width: 1.3rem; text-align: center; flex: 0 0 1.3rem; }
      .parent { margin-bottom: .25rem; }
      .empty { color: GrayText; }
      @media (prefers-color-scheme: dark) {
        .entry a { color: #8ab4f8; }
      }
    </style>
  </head>
  <body>
    <main>
      <nav aria-label="Breadcrumb">${renderBreadcrumbs(relativeDirectory)}</nav>
      <h1>${escapeHtml(displayPath)}</h1>
      ${listing}
    </main>
  </body>
</html>
`;
}

function generateDirectoryIndexes(distRoot) {
  for (const directory of collectDirectories(distRoot)) {
    writeFileSync(join(directory, "index.html"), renderDirectoryIndex(distRoot, directory));
  }
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
  const unexpectedPaths = [];
  for (const directory of collectDirectories(distDirectory)) {
    const relativeDirectory = relative(distDirectory, directory);
    if (relativeDirectory.split(sep).includes("schemas")) {
      unexpectedPaths.push(relativeDirectory);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === "api.json") {
        unexpectedPaths.push(join(relativeDirectory, entry.name));
      }
    }
  }
  if (unexpectedPaths.length > 0) {
    throw new Error(`dist contains forbidden published paths: ${unexpectedPaths.join(", ")}`);
  }

  const missingIndexes = collectDirectories(distDirectory).filter(
    (directory) => !existsSync(join(directory, "index.html")),
  );
  if (missingIndexes.length > 0) {
    throw new Error(
      `Every published directory must contain index.html: ${missingIndexes.join(", ")}`,
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
  const providers = collectProviders();
  writeFileSync(
    join(distDirectory, "providers.json"),
    `${JSON.stringify(providers, null, 2)}\n`,
  );

  generateDirectoryIndexes(distDirectory);
  assertPublishedBoundary();
  console.log(
    `Built ${cliDirectories.length} CLI template trees and ${providers.length} providers in dist/`,
  );
}

export {
  collectDirectories,
  collectProviders,
  escapeHtml,
  generateDirectoryIndexes,
  renderDirectoryIndex,
};

const invokedScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedScript) build();
