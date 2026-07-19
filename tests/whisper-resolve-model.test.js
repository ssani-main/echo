import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { closeSync, openSync, ftruncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWhisper } from '../whisper.js';
import { WHISPER_MODELS } from '../whisperModel.js';

// ---------------------------------------------------------------------------
// resolveWhisper: model-cache + opts.modelName integration
//
// When opts.modelPath / ECHO_WHISPER_MODEL are not given, resolveWhisper falls
// back to the model download cache (whisperModel.js), keyed by opts.modelName
// (or ECHO_WHISPER_DEFAULT_MODEL, or DEFAULT_WHISPER_MODEL). We point
// ECHO_WHISPER_MODEL_DIR at a fresh temp dir containing a sparse, exact-size
// "ggml-base-q5_1.bin" (see whisper-model.test.js for why a sparse file is
// used instead of writing real 57MB/181MB of bytes).
//
// These tests save/restore every whisper-related env var so they're
// deterministic regardless of the host environment.
// ---------------------------------------------------------------------------

const ENV_KEYS = ['ECHO_WHISPER', 'ECHO_WHISPER_MODEL', 'ECHO_WHISPER_MODEL_DIR', 'ECHO_WHISPER_DEFAULT_MODEL'];

function saveEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test('resolveWhisper: opts.modelName "base" resolves modelPath into the model cache dir when the exact-size file is present', async (t) => {
  const saved = saveEnv();
  const modelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-resolve-test-'));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-resolve-bin-'));

  t.after(async () => {
    restoreEnv(saved);
    await fs.rm(modelDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  });

  delete process.env.ECHO_WHISPER;
  delete process.env.ECHO_WHISPER_MODEL;
  delete process.env.ECHO_WHISPER_DEFAULT_MODEL;
  process.env.ECHO_WHISPER_MODEL_DIR = modelDir;

  // Sparse, exact-size stand-in for the base model file.
  const baseFile = path.join(modelDir, WHISPER_MODELS.base.file);
  const fd = openSync(baseFile, 'w');
  try {
    ftruncateSync(fd, WHISPER_MODELS.base.sizeBytes);
  } finally {
    closeSync(fd);
  }

  // A real (tiny) file standing in for the whisper-cli binary.
  const binPath = path.join(binDir, 'whisper-cli');
  await fs.writeFile(binPath, 'dummy-binary');

  const resolved = resolveWhisper({ whisperPath: binPath, modelName: 'base' });
  assert.ok(resolved, 'expected resolveWhisper to resolve when both binary and cached model are present');
  assert.equal(resolved.binPath, binPath);
  assert.equal(resolved.modelPath, path.join(modelDir, WHISPER_MODELS.base.file));
});

test('resolveWhisper: opts.modelName "small" returns null when no small model file is present in the cache', async (t) => {
  const saved = saveEnv();
  const modelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-resolve-test-'));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-resolve-bin-'));

  t.after(async () => {
    restoreEnv(saved);
    await fs.rm(modelDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  });

  delete process.env.ECHO_WHISPER;
  delete process.env.ECHO_WHISPER_MODEL;
  delete process.env.ECHO_WHISPER_DEFAULT_MODEL;
  process.env.ECHO_WHISPER_MODEL_DIR = modelDir;

  // Only the base model is present in the cache; no small model file exists.
  const baseFile = path.join(modelDir, WHISPER_MODELS.base.file);
  const fd = openSync(baseFile, 'w');
  try {
    ftruncateSync(fd, WHISPER_MODELS.base.sizeBytes);
  } finally {
    closeSync(fd);
  }

  const binPath = path.join(binDir, 'whisper-cli');
  await fs.writeFile(binPath, 'dummy-binary');

  const resolved = resolveWhisper({ whisperPath: binPath, modelName: 'small' });
  assert.equal(resolved, null);
});
