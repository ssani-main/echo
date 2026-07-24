import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildWhisperArgs, resolveVadModel } from '../whisper.js';

// ---------------------------------------------------------------------------
// The whisper-cli flag contract.
//
// Nothing here spawns whisper-cli — the suite never does (see CLAUDE.md
// "tests miss runtime"). What these lock down is the set of flags Echo asks
// for, because that set is the whole quality/speed trade: the accuracy-costing
// flags must stay OUT even while chasing speed, and VAD must be off unless a
// model was explicitly pointed at.
// ---------------------------------------------------------------------------

const BASE = {
  modelPath: '/models/ggml-base-q5_1.bin',
  wavPath: '/tmp/echo-whisper-x/audio.wav',
  whisperLang: 'auto',
  threads: 3,
  outPrefix: '/tmp/echo-whisper-x/out',
};

/** Value that follows `flag` in the arg list, or undefined if absent. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('buildWhisperArgs: carries model, audio, language, threads and JSON output', () => {
  const args = buildWhisperArgs(BASE);

  assert.equal(valueAfter(args, '-m'), BASE.modelPath);
  assert.equal(valueAfter(args, '-f'), BASE.wavPath);
  assert.equal(valueAfter(args, '-l'), 'auto');
  assert.equal(valueAfter(args, '-t'), '3');
  assert.equal(valueAfter(args, '-of'), BASE.outPrefix);
  assert.ok(args.includes('-oj'), 'JSON output is what mapWhisperJson() parses');
  assert.ok(args.includes('--print-progress'), 'progress lines drive the SSE channel');
});

test('buildWhisperArgs: threads is stringified — spawn() rejects numeric args', () => {
  const args = buildWhisperArgs({ ...BASE, threads: 8 });
  assert.equal(valueAfter(args, '-t'), '8');
  assert.equal(typeof valueAfter(args, '-t'), 'string');
});

test('buildWhisperArgs: never asks for a flag that trades accuracy for speed', () => {
  const args = buildWhisperArgs(BASE);

  // Leaving these unset keeps whisper.cpp's own defaults: beam size 5,
  // best-of 5, temperature fallback on, one processor. Every one of them
  // would decode faster and decode worse.
  for (const flag of ['-bs', '--beam-size', '-bo', '--best-of', '-nf', '--no-fallback',
    '-p', '--processors', '-ac', '--audio-ctx', '-mc', '--max-context']) {
    assert.ok(!args.includes(flag), `${flag} must not be passed — it costs transcription quality`);
  }
});

test('buildWhisperArgs: no VAD model means the invocation is byte-for-byte what it always was', () => {
  const withoutVad = buildWhisperArgs({ ...BASE, vadModelPath: null });
  const omitted = buildWhisperArgs(BASE);

  assert.deepEqual(withoutVad, omitted);
  assert.ok(!withoutVad.includes('--vad'));
  assert.ok(!withoutVad.includes('-vm'));
  assert.deepEqual(withoutVad, [
    '-m', BASE.modelPath,
    '-f', BASE.wavPath,
    '-l', 'auto',
    '-t', '3',
    '--print-progress',
    '-oj', '-of', BASE.outPrefix,
  ]);
});

test('buildWhisperArgs: a VAD model adds --vad and -vm, and nothing else', () => {
  const vadModelPath = '/models/ggml-silero-v5.1.2.bin';
  const args = buildWhisperArgs({ ...BASE, vadModelPath });

  assert.ok(args.includes('--vad'));
  assert.equal(valueAfter(args, '-vm'), vadModelPath);

  // The VAD tuning knobs stay at whisper.cpp's conservative defaults —
  // raising the threshold or shrinking the padding is what starts clipping
  // quiet speech.
  for (const flag of ['-vt', '--vad-threshold', '-vp', '--vad-speech-pad-ms']) {
    assert.ok(!args.includes(flag), `${flag} must not be set without measuring against real audio`);
  }

  // Everything the non-VAD invocation carries is still present, unchanged.
  const plain = buildWhisperArgs(BASE);
  assert.deepEqual(args.slice(0, plain.length), plain);
});

// ---------------------------------------------------------------------------
// resolveVadModel — presence of a model IS the on/off switch
// ---------------------------------------------------------------------------

let tmpDir;
let realVadModel;

test('sets up a temp dir with a stand-in VAD model file', async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-vad-test-'));
  realVadModel = path.join(tmpDir, 'ggml-silero-v5.1.2.bin');
  await fs.writeFile(realVadModel, 'not a real model, only its presence matters here');
});

test('resolveVadModel: no opts and no env returns null — VAD stays off by default', () => {
  const prev = process.env.ECHO_WHISPER_VAD_MODEL;
  delete process.env.ECHO_WHISPER_VAD_MODEL;
  try {
    assert.equal(resolveVadModel(), null);
    assert.equal(resolveVadModel({}), null);
  } finally {
    if (prev !== undefined) process.env.ECHO_WHISPER_VAD_MODEL = prev;
  }
});

test('resolveVadModel: opts.vadModelPath pointing at a real file resolves it', () => {
  assert.equal(resolveVadModel({ vadModelPath: realVadModel }), realVadModel);
});

test('resolveVadModel: ECHO_WHISPER_VAD_MODEL enables VAD', () => {
  const prev = process.env.ECHO_WHISPER_VAD_MODEL;
  process.env.ECHO_WHISPER_VAD_MODEL = realVadModel;
  try {
    assert.equal(resolveVadModel(), realVadModel);
  } finally {
    if (prev === undefined) delete process.env.ECHO_WHISPER_VAD_MODEL;
    else process.env.ECHO_WHISPER_VAD_MODEL = prev;
  }
});

test('resolveVadModel: a path that does not exist returns null rather than failing the run', () => {
  // A typo'd path must degrade to "VAD off", not kill a transcription that
  // would otherwise have worked.
  const prev = process.env.ECHO_WHISPER_VAD_MODEL;
  process.env.ECHO_WHISPER_VAD_MODEL = path.join(tmpDir, 'missing-model.bin');
  try {
    assert.equal(resolveVadModel(), null);
  } finally {
    if (prev === undefined) delete process.env.ECHO_WHISPER_VAD_MODEL;
    else process.env.ECHO_WHISPER_VAD_MODEL = prev;
  }
});

test('resolveVadModel: opts win over the env var', () => {
  const prev = process.env.ECHO_WHISPER_VAD_MODEL;
  process.env.ECHO_WHISPER_VAD_MODEL = path.join(tmpDir, 'missing-model.bin');
  try {
    assert.equal(resolveVadModel({ vadModelPath: realVadModel }), realVadModel);
  } finally {
    if (prev === undefined) delete process.env.ECHO_WHISPER_VAD_MODEL;
    else process.env.ECHO_WHISPER_VAD_MODEL = prev;
  }
});

test.after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
