#!/usr/bin/env node
// Vendor extra ggml CPU backend variants (AVX-512 and friends) beside the
// whisper-cli binary already in vendor/whisper/<platform>-<arch>/.
//
// WHY THIS EXISTS
// ---------------
// The vendored set is a deliberately lean slice of upstream's release archive:
// the baseline (x64) and AVX2 (haswell) CPU backends only. ggml's backend
// registry loads every libggml-cpu-*.so it finds beside the binary, asks each
// one to score itself against the host CPU, and runs the highest scorer — so a
// machine with AVX-512 silently runs the AVX2 build today, purely because the
// better backend was never shipped. Dropping the missing variants in is enough;
// no Echo code changes, because the dispatch is entirely inside ggml.
//
// WHY IT REFUSES MISMATCHED FILES
// -------------------------------
// A backend .so is only loadable by the libggml.so.0 it was BUILT WITH. Take
// libggml-cpu-skylakex.so from a different whisper.cpp build — a different
// release, a different compiler, a local build — and you get an ABI mismatch
// that nothing here can detect: the file loads on an AVX2 box (it is never
// scored highest, so never used) and fails only on the AVX-512 machines it was
// added for. This script therefore verifies that every file the source archive
// shares with the vendored set is BYTE-IDENTICAL before copying anything new.
// Identical shared files prove the archive is the same build; a single
// difference means it isn't, and the script stops.
//
// USAGE
// -----
// Get the release asset that MATCHES the vendored version — currently
// whisper.cpp v1.9.1 from ggml-org/whisper.cpp (see vendor/whisper/README.md,
// which records the provenance):
//
//   linux-x64:  whisper-bin-ubuntu-x64.tar.gz
//   win32-x64:  whisper-bin-x64.zip        (the plain CPU build, not CUDA)
//
//   tar xf whisper-bin-ubuntu-x64.tar.gz -C /tmp/whisper-upstream
//   node tools/vendor-whisper-backends.mjs /tmp/whisper-upstream
//
// Then commit the new files. It takes an already-extracted directory rather
// than a URL so it needs no archive-format handling and no network access of
// its own — unpack with whatever you already have.

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Per-platform: where the vendored files live, and how a CPU backend file is
// named there. Windows ships .dll with no lib prefix.
export const PLATFORMS = {
  'linux-x64': { dir: 'vendor/whisper/linux-x64', backendRe: /^libggml-cpu-.*\.so$/ },
  'win32-x64': { dir: 'vendor/whisper/win32-x64', backendRe: /^ggml-cpu-.*\.dll$/ },
};

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file in `dir`, one level deep, as name -> absolute path. */
function filesIn(dir) {
  const out = new Map();
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isFile()) out.set(name, abs);
  }
  return out;
}

/** Recursively find the directory inside `root` that holds the backend files. */
function findBackendDir(root, backendRe, depth = 0) {
  if (depth > 4) return null;
  const entries = readdirSync(root);
  if (entries.some((n) => backendRe.test(n))) return root;
  for (const name of entries) {
    const abs = join(root, name);
    if (!statSync(abs).isDirectory()) continue;
    const found = findBackendDir(abs, backendRe, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Compare the files the source and the vendored set have in common.
 *
 * This is the ABI gate: identical shared files mean the source archive is the
 * same build that produced the vendored libggml, so its other backends are safe
 * to mix in. Any difference means it is a different build.
 *
 * @returns {{ matched: string[], differing: string[] }}
 */
export function compareSharedFiles(sourceFiles, vendoredFiles) {
  const matched = [];
  const differing = [];
  for (const [name, vendoredPath] of vendoredFiles) {
    const sourcePath = sourceFiles.get(name);
    if (!sourcePath) continue; // not shared — nothing to prove either way
    if (sha256(sourcePath) === sha256(vendoredPath)) matched.push(name);
    else differing.push(name);
  }
  return { matched, differing };
}

/** Backend variants present in the source but not yet vendored. */
export function missingBackends(sourceFiles, vendoredFiles, backendRe) {
  return [...sourceFiles.keys()]
    .filter((name) => backendRe.test(name) && !vendoredFiles.has(name))
    .sort();
}

/**
 * Add bundle.resources entries for newly vendored files, preserving the
 * existing key order and formatting style of tauri.conf.json.
 *
 * A vendored file that is missing from bundle.resources is NOT caught by the
 * test suite or the .deb/.rpm bundlers — it surfaces as a runtime failure in
 * the desktop app only (see the "Tauri bundle drift" gotcha in CLAUDE.md).
 *
 * @returns {{ conf: object, added: string[] }}
 */
export function addBundleResources(conf, platformDir, fileNames) {
  const resources = { ...conf.bundle.resources };
  const added = [];
  for (const name of fileNames) {
    const key = `../${platformDir}/${name}`;
    if (key in resources) continue;
    resources[key] = `${platformDir}/${name}`;
    added.push(key);
  }
  return { conf: { ...conf, bundle: { ...conf.bundle, resources } }, added };
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const platformFlag = args.indexOf('--platform');
  const platform = platformFlag !== -1 ? args[platformFlag + 1] : 'linux-x64';
  const sourceArg = args.find((a) => !a.startsWith('--') && a !== platform);

  if (!sourceArg) {
    fail('Usage: node tools/vendor-whisper-backends.mjs <extracted-release-dir> [--platform linux-x64|win32-x64]');
  }
  const spec = PLATFORMS[platform];
  if (!spec) fail(`Unknown platform "${platform}". Known: ${Object.keys(PLATFORMS).join(', ')}`);
  if (!existsSync(sourceArg)) fail(`Source directory not found: ${sourceArg}`);

  const vendorDir = join(REPO_ROOT, spec.dir);
  if (!existsSync(vendorDir)) fail(`No vendored set for ${platform} at ${spec.dir}`);

  const sourceDir = findBackendDir(sourceArg, spec.backendRe);
  if (!sourceDir) fail(`No files matching ${spec.backendRe} anywhere under ${sourceArg}. Is this the right archive for ${platform}?`);

  const sourceFiles = filesIn(sourceDir);
  const vendoredFiles = filesIn(vendorDir);

  console.log(`source:   ${sourceDir}`);
  console.log(`vendored: ${spec.dir}\n`);

  // --- ABI gate ------------------------------------------------------------
  const { matched, differing } = compareSharedFiles(sourceFiles, vendoredFiles);
  if (matched.length === 0) {
    fail(
      'The source shares no files with the vendored set, so there is no way to ' +
      'prove they are the same build. Refusing to mix backends.'
    );
  }
  if (differing.length > 0) {
    fail(
      `These files differ from the vendored ones:\n    ${differing.join('\n    ')}\n\n` +
      '  That means this archive is a DIFFERENT build of whisper.cpp/ggml than the one\n' +
      '  vendored here. Its backends are not guaranteed to be ABI-compatible with the\n' +
      '  vendored libggml, and a mismatch would only ever fail on the AVX-512 machines\n' +
      '  you are adding them for — never on this one.\n\n' +
      '  Either fetch the archive matching the vendored version, or replace the WHOLE\n' +
      '  vendored set from this archive (all libs together) and re-verify end to end.'
    );
  }
  console.log(`✓ ${matched.length} shared file(s) byte-identical — same build:`);
  for (const name of matched) console.log(`    ${name}`);

  // --- Copy the missing variants -------------------------------------------
  const missing = missingBackends(sourceFiles, vendoredFiles, spec.backendRe);
  if (missing.length === 0) {
    console.log('\nNothing to add — every backend variant in the source is already vendored.');
    return;
  }

  console.log(`\nAdding ${missing.length} backend variant(s):`);
  let bytes = 0;
  for (const name of missing) {
    const dest = join(vendorDir, name);
    copyFileSync(sourceFiles.get(name), dest);
    const size = statSync(dest).size;
    bytes += size;
    console.log(`    ${name}  (${(size / 1024).toFixed(0)} KB)`);
  }

  // --- Keep the Tauri bundle in sync ---------------------------------------
  const confPath = join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  const { conf: updated, added } = addBundleResources(conf, spec.dir, missing);
  if (added.length > 0) {
    writeFileSync(confPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    console.log(`\n✓ Added ${added.length} entr${added.length === 1 ? 'y' : 'ies'} to tauri.conf.json bundle.resources`);
  }

  console.log(`\nDone — ${(bytes / 1024).toFixed(0)} KB added to the bundle.`);
  console.log('Verify before committing:');
  console.log('  1. npm test');
  console.log(`  2. LD_LIBRARY_PATH=${spec.dir} ./${spec.dir}/${platform.startsWith('win32') ? 'whisper-cli.exe' : 'whisper-cli'} --help | head -2`);
  console.log('     → the "load_backend:" line should now name the best variant for this CPU.');
  console.log('  3. Transcribe a known video and diff the text against a pre-change run —');
  console.log('     a wider-register backend should change the timing, never the words.');
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && basename(process.argv[1]) === 'vendor-whisper-backends.mjs') {
  main();
}
