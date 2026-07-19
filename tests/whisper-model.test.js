import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { closeSync, openSync, ftruncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL,
  modelCacheDir,
  modelInfo,
  modelFilePath,
  isModelPresent,
  downloadState,
  startModelDownload,
} from '../whisperModel.js';

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('DEFAULT_WHISPER_MODEL is "base"', () => {
  assert.equal(DEFAULT_WHISPER_MODEL, 'base');
});

test('WHISPER_MODELS has base and small entries, each with name/label/file/url/sizeBytes/sha256', () => {
  for (const key of ['base', 'small']) {
    const m = WHISPER_MODELS[key];
    assert.ok(m, `expected WHISPER_MODELS.${key} to exist`);
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.file, 'string');
    assert.equal(typeof m.url, 'string');
    assert.equal(typeof m.sizeBytes, 'number');
    assert.ok(m.sizeBytes > 0);
    assert.equal(typeof m.sha256, 'string');
  }
});

// ---------------------------------------------------------------------------
// modelCacheDir
// ---------------------------------------------------------------------------

test('modelCacheDir: returns ECHO_WHISPER_MODEL_DIR exactly when set', () => {
  const saved = process.env.ECHO_WHISPER_MODEL_DIR;
  process.env.ECHO_WHISPER_MODEL_DIR = '/tmp/some-custom-whisper-cache';
  try {
    assert.equal(modelCacheDir(), '/tmp/some-custom-whisper-cache');
  } finally {
    if (saved === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = saved;
  }
});

test('modelCacheDir: falls back to a path containing echo/whisper-models when unset', () => {
  const saved = process.env.ECHO_WHISPER_MODEL_DIR;
  delete process.env.ECHO_WHISPER_MODEL_DIR;
  try {
    const dir = modelCacheDir();
    const expectedSuffix = path.join('echo', 'whisper-models');
    assert.ok(dir.endsWith(expectedSuffix), `expected "${dir}" to end with "${expectedSuffix}"`);
  } finally {
    if (saved === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = saved;
  }
});

// ---------------------------------------------------------------------------
// modelInfo
// ---------------------------------------------------------------------------

test('modelInfo("base") returns the base registry entry', () => {
  assert.equal(modelInfo('base'), WHISPER_MODELS.base);
});

test('modelInfo("nope") returns null for an unknown model', () => {
  assert.equal(modelInfo('nope'), null);
});

// ---------------------------------------------------------------------------
// modelFilePath
// ---------------------------------------------------------------------------

test('modelFilePath("base") joins the cache dir with the base model filename', () => {
  const saved = process.env.ECHO_WHISPER_MODEL_DIR;
  process.env.ECHO_WHISPER_MODEL_DIR = '/tmp/whisper-cache-dir';
  try {
    assert.equal(modelFilePath('base'), path.join('/tmp/whisper-cache-dir', 'ggml-base-q5_1.bin'));
  } finally {
    if (saved === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = saved;
  }
});

test('modelFilePath("nope") returns null for an unknown model', () => {
  assert.equal(modelFilePath('nope'), null);
});

// ---------------------------------------------------------------------------
// isModelPresent / downloadState / startModelDownload
//
// The real base/small models are 57MB/181MB — we never write real bytes.
// Instead we point ECHO_WHISPER_MODEL_DIR at a fresh temp dir and create a
// SPARSE file of the exact expected size via ftruncate, which reports the
// correct size to statSync without consuming real disk space.
// ---------------------------------------------------------------------------

test('isModelPresent/downloadState/startModelDownload: absent, wrong-size, and exact-size cases', async (t) => {
  const savedDir = process.env.ECHO_WHISPER_MODEL_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-model-test-'));
  process.env.ECHO_WHISPER_MODEL_DIR = dir;

  t.after(async () => {
    if (savedDir === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = savedDir;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const baseFile = path.join(dir, WHISPER_MODELS.base.file);

  // 1. No file at all -> not present.
  assert.equal(isModelPresent('base'), false);
  assert.deepEqual(downloadState('base'), {
    name: 'base', present: false, state: 'absent', received: 0, total: WHISPER_MODELS.base.sizeBytes, percent: 0,
  });

  // 2. A file exists but is the WRONG size -> still not present.
  await fs.writeFile(baseFile, 'not the real model, just a tiny stand-in');
  assert.equal(isModelPresent('base'), false);
  assert.equal(downloadState('base').present, false);
  assert.equal(downloadState('base').state, 'absent');

  // 3. A sparse file of the EXACT expected size -> present.
  const fd = openSync(baseFile, 'w');
  try {
    ftruncateSync(fd, WHISPER_MODELS.base.sizeBytes);
  } finally {
    closeSync(fd);
  }
  assert.equal(isModelPresent('base'), true);
  assert.deepEqual(downloadState('base'), {
    name: 'base', present: true, state: 'present',
    received: WHISPER_MODELS.base.sizeBytes, total: WHISPER_MODELS.base.sizeBytes, percent: 100,
  });
});

test('downloadState("nope") reports state "unknown" for an unregistered model', () => {
  const state = downloadState('nope');
  assert.equal(state.state, 'unknown');
  assert.equal(state.present, false);
});

test('startModelDownload("nope") throws with echoCode WHISPER_MODEL_UNKNOWN', () => {
  assert.throws(
    () => startModelDownload('nope'),
    (err) => err.echoCode === 'WHISPER_MODEL_UNKNOWN'
  );
});

test('startModelDownload("base") returns {state:"present"} without kicking off a download when the exact-size file already exists', async (t) => {
  const savedDir = process.env.ECHO_WHISPER_MODEL_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-model-test-'));
  process.env.ECHO_WHISPER_MODEL_DIR = dir;

  t.after(async () => {
    if (savedDir === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = savedDir;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const baseFile = path.join(dir, WHISPER_MODELS.base.file);
  const fd = openSync(baseFile, 'w');
  try {
    ftruncateSync(fd, WHISPER_MODELS.base.sizeBytes);
  } finally {
    closeSync(fd);
  }

  const result = startModelDownload('base');
  assert.deepEqual(result, { state: 'present' });
});

// Not covered here (needs a real HTTP fetch + a byte-for-byte matching model
// file to pass sha256 verification): the actual network download path inside
// doDownload() (fetch -> stream -> hash -> rename), its retry/error mapping
// (WHISPER_MODEL_DOWNLOAD_FAILED / WHISPER_MODEL_VERIFY_FAILED), and the
// "download already in progress" branch of startModelDownload. These are
// exercised by manual/E2E runtime verification instead, per the task brief.
