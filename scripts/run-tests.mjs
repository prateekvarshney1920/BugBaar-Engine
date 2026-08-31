#!/usr/bin/env node
// Discovers the test suite and runs it through the Node test runner.
//
// The obvious approach — passing glob patterns straight to `node --test` —
// only works on Node 21 and later, where the runner learned to expand them.
// On Node 20 the pattern is taken literally and the run dies with
// "Could not find '<path>/**/*.test.ts'". The CI matrix covers both versions,
// so the patterns have to be expanded before Node sees them.
//
// Passing directories instead would be worse. Node 20 accepts them and
// silently discovers nothing, because `*.test.ts` is not one of its default
// test-file patterns — CI would report success while running zero tests.
//
// So this walks the tree itself and hands over explicit file paths, which
// every supported version treats the same way.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

/** Workspaces that own tests, and the directory to search in each. */
const SUITES = [
  { workspace: "tools", dir: "tools/src" },
  { workspace: "agents", dir: "agents/src" },
  { workspace: "rag", dir: "rag/src" },
  { workspace: "workflows", dir: "workflows/src" },
  { workspace: "persistence", dir: "persistence/src" },
  { workspace: "queue", dir: "queue/src" },
  { workspace: "backend", dir: "backend/src" },
];

const TEST_FILE = /\.test\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function findTests(directory) {
  const absolute = join(ROOT, directory);

  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...findTests(join(directory, entry.name)));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(join(directory, entry.name));
    }
  }

  // Sorted so the run order is identical everywhere, which makes a failure
  // reproducible from the log alone.
  return found.sort();
}

const files = [];
const empty = [];

for (const suite of SUITES) {
  const found = findTests(suite.dir);
  if (found.length === 0) empty.push(suite);
  files.push(...found);
}

// A suite that quietly finds nothing is indistinguishable from a suite that
// passes. If a workspace stops yielding tests, that is a broken configuration,
// not a green build.
if (empty.length > 0) {
  const names = empty.map((suite) => `${suite.workspace} (${suite.dir})`).join(", ");
  console.error(`No test files found for: ${names}`);
  console.error("Expected files matching *.test.ts. Refusing to report success on an empty run.");
  process.exit(1);
}

const relativeFiles = files.map((file) => relative(ROOT, join(ROOT, file)).split("\\").join("/"));
console.error(`Running ${relativeFiles.length} test files across ${SUITES.length} workspaces`);

// Anything after the script name is forwarded, so `npm test -- --test-only`
// and similar still work.
const passthrough = process.argv.slice(2);

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...passthrough, ...relativeFiles], {
  cwd: ROOT,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start the test runner: ${error.message}`);
  process.exit(1);
});

// Mirror the child's exit so CI sees the real result, including a signal kill.
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
