import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Static guard: Tauri bundle resources vs. actual backend import graph
//
// Bug this catches: a module imported by the backend (transitively via
// server.js) is missing from src-tauri/tauri.conf.json bundle.resources, so
// the bundled Node sidecar crashes at runtime with ERR_MODULE_NOT_FOUND.
//
// Strategy: pure static analysis — no server boot, no network, no child
// process. Walk local relative imports starting from server.js, then assert
// every discovered file appears in bundle.resources.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Load and parse tauri.conf.json
// ---------------------------------------------------------------------------

const tauriConfPath = join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));

// Keys are paths relative to src-tauri/, e.g. "../server.js"
const bundledKeys = new Set(Object.keys(tauriConf.bundle.resources));

// ---------------------------------------------------------------------------
// 2. Transitive BFS walk of local relative imports starting from server.js
//
// Regex captures quoted specifiers in:
//   static:  from './foo.js'   or   from "./foo.js"
//   dynamic: import('./foo.js') or import("./foo.js")
//
// Only follows specifiers starting with './' (local files). Skips node built-
// ins ('node:fs') and npm packages ('express') which don't start with './'.
// ---------------------------------------------------------------------------

const LOCAL_IMPORT_RE = /(?:from\s+|import\s*\()(['"])(\.\/[^'"]+\.js)\1/g;

/**
 * Walks all local relative imports reachable from entryPath.
 * Returns a Set of POSIX paths relative to REPO_ROOT (e.g. "websearch.js").
 */
function walkImports(entryPath) {
  const visited = new Set();   // absolute paths already walked
  const queue = [entryPath];
  const neededRelToRoot = new Set();

  while (queue.length > 0) {
    const absPath = queue.shift();
    if (visited.has(absPath)) continue;
    visited.add(absPath);

    if (!existsSync(absPath)) continue;

    // Only walk files that live inside REPO_ROOT
    const relToRoot = relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    if (relToRoot.startsWith('..')) continue;

    // Don't add the entry file itself to neededRelToRoot — the assertion
    // about server.js in the bundle is covered separately below via the
    // general check (server.js IS in bundledKeys as "../server.js").
    // But we do add it so the walk includes its imports.
    neededRelToRoot.add(relToRoot);

    let source;
    try {
      source = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    LOCAL_IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = LOCAL_IMPORT_RE.exec(source)) !== null) {
      const specifier = match[2]; // e.g. './websearch.js'
      const absImported = resolve(dirname(absPath), specifier);
      if (!visited.has(absImported)) {
        queue.push(absImported);
      }
    }
  }

  return neededRelToRoot;
}

const ENTRY = join(REPO_ROOT, 'server.js');
const neededRelToRoot = walkImports(ENTRY);

// ---------------------------------------------------------------------------
// 3. Test: sanity check — the walk found a reasonable number of modules
// ---------------------------------------------------------------------------

test('import walk discovers a reasonable number of local modules (sanity guard against a broken regex finding nothing)', () => {
  assert.ok(
    neededRelToRoot.size >= 5,
    `Expected walk to discover at least 5 local modules; got ${neededRelToRoot.size}. ` +
    `Check LOCAL_IMPORT_RE or the entry file path. Discovered: ${[...neededRelToRoot].join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// 4a. Test: every discovered module exists on disk
// ---------------------------------------------------------------------------

test('every local module imported by the backend exists on disk', () => {
  const missing = [];
  for (const relPath of neededRelToRoot) {
    const absPath = join(REPO_ROOT, relPath);
    if (!existsSync(absPath)) {
      missing.push(relPath);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `The following files are imported by the backend but do not exist on disk:\n` +
    missing.map(p => `  ${p}`).join('\n')
  );
});

// ---------------------------------------------------------------------------
// 4b. Test: every discovered module is listed in tauri.conf.json bundle.resources
// ---------------------------------------------------------------------------

test('every local module the backend imports is listed in tauri.conf.json bundle.resources', () => {
  const missing = [];
  for (const relPath of neededRelToRoot) {
    // Keys in bundle.resources are relative to src-tauri/, so repo-root
    // "websearch.js" becomes the key "../websearch.js".
    const expectedKey = '../' + relPath;
    if (!bundledKeys.has(expectedKey)) {
      missing.push(relPath);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `The following files are imported by the backend but are MISSING from ` +
    `src-tauri/tauri.conf.json bundle.resources:\n` +
    missing.map(p => `  ${p}  (add key: "../${p}")`).join('\n') + '\n\n' +
    `Add each missing file to the "bundle.resources" object in src-tauri/tauri.conf.json ` +
    `to prevent ERR_MODULE_NOT_FOUND crashes in the bundled Tauri desktop app.`
  );
});
