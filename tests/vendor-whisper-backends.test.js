import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  compareSharedFiles,
  missingBackends,
  addBundleResources,
  sha256,
  PLATFORMS,
} from '../tools/vendor-whisper-backends.mjs';

// ---------------------------------------------------------------------------
// The vendoring helper's two load-bearing decisions:
//
//   1. Is this source archive the SAME whisper.cpp build as the vendored set?
//      Only then are its extra CPU backends safe to mix with the vendored
//      libggml. Getting this wrong produces a failure that cannot reproduce on
//      a non-AVX-512 machine, so the check has to be right by construction.
//   2. Which backend files are new, and are they added to the Tauri bundle?
//      A vendored file missing from bundle.resources fails only at runtime in
//      the packaged desktop app (see CLAUDE.md, "Tauri bundle drift").
// ---------------------------------------------------------------------------

let tmp;
let sourceDir;
let vendorDir;

/** name -> absolute path, the shape the helpers consume. */
async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  const map = new Map();
  for (const [name, contents] of Object.entries(files)) {
    const abs = path.join(dir, name);
    await fs.writeFile(abs, contents);
    map.set(name, abs);
  }
  return map;
}

test('sets up a fake upstream archive and a fake vendored set', async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-vendor-test-'));
  sourceDir = path.join(tmp, 'source');
  vendorDir = path.join(tmp, 'vendor');
  assert.ok(tmp);
});

test('compareSharedFiles: identical shared files prove the same build', async () => {
  const source = await writeFiles(sourceDir, {
    'libggml.so.0': 'core-v1',
    'libggml-cpu-x64.so': 'baseline-v1',
    'libggml-cpu-haswell.so': 'avx2-v1',
    'libggml-cpu-skylakex.so': 'avx512-v1',
    'whisper-cli': 'cli-v1',
  });
  const vendored = await writeFiles(vendorDir, {
    'libggml.so.0': 'core-v1',
    'libggml-cpu-x64.so': 'baseline-v1',
    'libggml-cpu-haswell.so': 'avx2-v1',
    'whisper-cli': 'cli-v1',
  });

  const { matched, differing } = compareSharedFiles(source, vendored);
  assert.deepEqual(differing, []);
  assert.deepEqual(matched.sort(), ['libggml-cpu-haswell.so', 'libggml-cpu-x64.so', 'libggml.so.0', 'whisper-cli']);
});

test('compareSharedFiles: ONE differing byte flags a different build', async () => {
  // This is the case the whole script exists to catch: an archive that looks
  // right and is a different build, whose skylakex backend would load against
  // a libggml it was not compiled with.
  const other = path.join(tmp, 'other-build');
  const source = await writeFiles(other, {
    'libggml.so.0': 'core-v1',
    'libggml-cpu-haswell.so': 'avx2-v2-REBUILT',
    'libggml-cpu-skylakex.so': 'avx512-v2',
  });
  const vendored = await writeFiles(vendorDir, {
    'libggml.so.0': 'core-v1',
    'libggml-cpu-haswell.so': 'avx2-v1',
  });

  const { matched, differing } = compareSharedFiles(source, vendored);
  assert.deepEqual(differing, ['libggml-cpu-haswell.so']);
  assert.ok(matched.includes('libggml.so.0'), 'a partial match must not be treated as proof');
});

test('compareSharedFiles: no shared files at all yields no proof either way', async () => {
  const unrelated = await writeFiles(path.join(tmp, 'unrelated'), { 'README.md': 'nothing here' });
  const vendored = await writeFiles(vendorDir, { 'libggml.so.0': 'core-v1' });

  const { matched } = compareSharedFiles(unrelated, vendored);
  assert.deepEqual(matched, [], 'caller must refuse when there is nothing to compare');
});

test('missingBackends: returns only backend variants not already vendored', async () => {
  const source = await writeFiles(path.join(tmp, 's2'), {
    'libggml-cpu-x64.so': 'a',
    'libggml-cpu-haswell.so': 'b',
    'libggml-cpu-skylakex.so': 'c',
    'libggml-cpu-icelake.so': 'd',
    'libggml-cpu-alderlake.so': 'e',
    'libggml.so.0': 'core',       // not a backend
    'whisper-cli': 'cli',         // not a backend
  });
  const vendored = await writeFiles(path.join(tmp, 'v2'), {
    'libggml-cpu-x64.so': 'a',
    'libggml-cpu-haswell.so': 'b',
  });

  const missing = missingBackends(source, vendored, PLATFORMS['linux-x64'].backendRe);
  assert.deepEqual(missing, ['libggml-cpu-alderlake.so', 'libggml-cpu-icelake.so', 'libggml-cpu-skylakex.so']);
});

test('missingBackends: the Windows pattern matches .dll names, not .so', async () => {
  const source = await writeFiles(path.join(tmp, 's3'), {
    'ggml-cpu-haswell.dll': 'a',
    'ggml-cpu-skylakex.dll': 'b',
    'ggml.dll': 'core',
  });
  const vendored = await writeFiles(path.join(tmp, 'v3'), { 'ggml-cpu-haswell.dll': 'a' });

  const missing = missingBackends(source, vendored, PLATFORMS['win32-x64'].backendRe);
  assert.deepEqual(missing, ['ggml-cpu-skylakex.dll']);
});

test('addBundleResources: appends new files in the src-tauri-relative form', () => {
  const conf = {
    bundle: {
      resources: {
        '../server.js': 'server.js',
        '../vendor/whisper/linux-x64/whisper-cli': 'vendor/whisper/linux-x64/whisper-cli',
      },
    },
  };

  const { conf: updated, added } = addBundleResources(
    conf, 'vendor/whisper/linux-x64', ['libggml-cpu-skylakex.so', 'libggml-cpu-icelake.so']
  );

  assert.deepEqual(added, [
    '../vendor/whisper/linux-x64/libggml-cpu-skylakex.so',
    '../vendor/whisper/linux-x64/libggml-cpu-icelake.so',
  ]);
  assert.equal(
    updated.bundle.resources['../vendor/whisper/linux-x64/libggml-cpu-skylakex.so'],
    'vendor/whisper/linux-x64/libggml-cpu-skylakex.so'
  );
  // Existing entries survive untouched.
  assert.equal(updated.bundle.resources['../server.js'], 'server.js');
  assert.equal(conf.bundle.resources['../vendor/whisper/linux-x64/libggml-cpu-skylakex.so'], undefined,
    'the input config must not be mutated');
});

test('addBundleResources: is idempotent — re-running adds nothing', () => {
  const conf = {
    bundle: {
      resources: {
        '../vendor/whisper/linux-x64/libggml-cpu-skylakex.so': 'vendor/whisper/linux-x64/libggml-cpu-skylakex.so',
      },
    },
  };
  const { added } = addBundleResources(conf, 'vendor/whisper/linux-x64', ['libggml-cpu-skylakex.so']);
  assert.deepEqual(added, []);
});

test('sha256: distinguishes files that differ by a single byte', async () => {
  const a = path.join(tmp, 'a.bin');
  const b = path.join(tmp, 'b.bin');
  await fs.writeFile(a, Buffer.from([1, 2, 3, 4]));
  await fs.writeFile(b, Buffer.from([1, 2, 3, 5]));
  assert.notEqual(sha256(a), sha256(b));
  assert.equal(sha256(a), sha256(a));
});

test.after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});
