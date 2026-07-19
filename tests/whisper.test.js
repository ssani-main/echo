import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  resolveWhisper,
  mapWhisperJson,
  mapWhisperError,
} from '../whisper.js';
import { fetchTranscript } from '../transcript.js';

// ---------------------------------------------------------------------------
// mapWhisperJson
//
// Pure function — every case is exercised with synthetic whisper.cpp `-oj`
// JSON. Nothing here spawns whisper-cli or hits the network.
// ---------------------------------------------------------------------------

test('mapWhisperJson: maps segments to {text, offset}, drops empty/whitespace-only segments, offset is offsets.from/1000 in SECONDS', () => {
  const json = {
    transcription: [
      { offsets: { from: 0, to: 4380 }, text: ' Oke, halo.' },
      { offsets: { from: 4380, to: 8000 }, text: '  ' },
      { offsets: { from: 8000, to: 12000 }, text: ' Dunia.' },
    ],
    result: { language: 'id' },
  };
  const result = mapWhisperJson(json);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { text: 'Oke, halo.', offset: 0 });
  assert.deepEqual(result[1], { text: 'Dunia.', offset: 8 });
});

test('mapWhisperJson: stamps langUsed from result.language, non-enumerably', () => {
  const json = {
    transcription: [{ offsets: { from: 0, to: 1000 }, text: 'hi' }],
    result: { language: 'id' },
  };
  const result = mapWhisperJson(json);
  assert.equal(result.langUsed, 'id');
  assert.deepEqual(Object.keys(result), ['0']); // only the array index is enumerable
  const desc = Object.getOwnPropertyDescriptor(result, 'langUsed');
  assert.equal(desc.enumerable, false);
});

test('mapWhisperJson: stamps source as "whisper", non-enumerably', () => {
  const json = {
    transcription: [{ offsets: { from: 0, to: 1000 }, text: 'hi' }],
    result: { language: 'id' },
  };
  const result = mapWhisperJson(json);
  assert.equal(result.source, 'whisper');
  const desc = Object.getOwnPropertyDescriptor(result, 'source');
  assert.equal(desc.enumerable, false);
});

test('mapWhisperJson: {} (no transcription key) returns an empty array', () => {
  const result = mapWhisperJson({});
  assert.equal(result.length, 0);
});

test('mapWhisperJson: {transcription: []} returns an empty array', () => {
  const result = mapWhisperJson({ transcription: [] });
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// mapWhisperError
// ---------------------------------------------------------------------------

test('mapWhisperError: null input maps to a generic WHISPER_FAILED', () => {
  const mapped = mapWhisperError(null);
  assert.equal(mapped.echoCode, 'WHISPER_FAILED');
  assert.equal(typeof mapped.message, 'string');
  assert.equal(typeof mapped.hint, 'string');
});

test('mapWhisperError: a pre-set echoCode passes through unchanged', () => {
  const err = { echoCode: 'WHISPER_AUDIO_TOO_LONG', message: 'x', hint: 'h' };
  const mapped = mapWhisperError(err);
  assert.deepEqual(mapped, { echoCode: 'WHISPER_AUDIO_TOO_LONG', message: 'x', hint: 'h' });
});

test('mapWhisperError: whisper-cli ENOENT maps to WHISPER_MISSING', () => {
  const err = { code: 'ENOENT', path: '/usr/bin/whisper-cli', message: 'spawn whisper-cli ENOENT' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'WHISPER_MISSING');
  assert.match(mapped.hint, /ECHO_WHISPER/);
});

test('mapWhisperError: yt-dlp ENOENT maps to YTDLP_MISSING', () => {
  const err = { code: 'ENOENT', message: 'spawn yt-dlp ENOENT' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'YTDLP_MISSING');
  assert.match(mapped.hint, /yt-dlp/i);
});

test('mapWhisperError: ffmpeg ENOENT maps to FFMPEG_MISSING', () => {
  const err = { code: 'ENOENT', message: 'spawn ffmpeg ENOENT' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'FFMPEG_MISSING');
  assert.match(mapped.hint, /ffmpeg/i);
});

test('mapWhisperError: a killed/SIGTERM error maps to WHISPER_TIMEOUT', () => {
  const err = { killed: true, signal: 'SIGTERM', message: 'x' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'WHISPER_TIMEOUT');
});

test('mapWhisperError: a "timed out" message maps to WHISPER_TIMEOUT even without killed/signal', () => {
  const err = { message: 'operation timed out' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'WHISPER_TIMEOUT');
});

test('mapWhisperError: a generic error maps to WHISPER_FAILED', () => {
  const err = { message: 'boom' };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'WHISPER_FAILED');
});

// ---------------------------------------------------------------------------
// resolveWhisper
//
// The no-config case must be deterministic regardless of the host env, so we
// save/clear ECHO_WHISPER + ECHO_WHISPER_MODEL around these tests and restore
// them afterward.
// ---------------------------------------------------------------------------

const savedEnvWhisper = process.env.ECHO_WHISPER;
const savedEnvWhisperModel = process.env.ECHO_WHISPER_MODEL;
delete process.env.ECHO_WHISPER;
delete process.env.ECHO_WHISPER_MODEL;

test('resolveWhisper: no opts and no env returns null', () => {
  assert.equal(resolveWhisper(), null);
  assert.equal(resolveWhisper({}), null);
});

test('resolveWhisper: opts pointing at two real files returns {binPath, modelPath}', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-test-'));
  const binPath = path.join(dir, 'whisper-cli');
  const modelPath = path.join(dir, 'ggml-model.bin');
  try {
    await fs.writeFile(binPath, 'dummy-binary');
    await fs.writeFile(modelPath, 'dummy-model');

    const resolved = resolveWhisper({ whisperPath: binPath, modelPath });
    assert.deepEqual(resolved, { binPath, modelPath });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('resolveWhisper: whisperPath exists but modelPath does not returns null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-test-'));
  const binPath = path.join(dir, 'whisper-cli');
  const missingModelPath = path.join(dir, 'does-not-exist.bin');
  try {
    await fs.writeFile(binPath, 'dummy-binary');
    const resolved = resolveWhisper({ whisperPath: binPath, modelPath: missingModelPath });
    assert.equal(resolved, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('resolveWhisper: modelPath exists but whisperPath does not returns null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-test-'));
  const modelPath = path.join(dir, 'ggml-model.bin');
  const missingBinPath = path.join(dir, 'does-not-exist-cli');
  try {
    await fs.writeFile(modelPath, 'dummy-model');
    const resolved = resolveWhisper({ whisperPath: missingBinPath, modelPath });
    assert.equal(resolved, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// Restore the host env immediately after the resolveWhisper block so later
// tests in this process (or other files run in the same worker) are unaffected.
if (savedEnvWhisper === undefined) delete process.env.ECHO_WHISPER;
else process.env.ECHO_WHISPER = savedEnvWhisper;
if (savedEnvWhisperModel === undefined) delete process.env.ECHO_WHISPER_MODEL;
else process.env.ECHO_WHISPER_MODEL = savedEnvWhisperModel;

// ---------------------------------------------------------------------------
// fetchTranscript: Whisper integration seams (offline, dependency-injected)
//
// transcribe, primaryFetcher, captionFallback, whisperResolver, transcriber
// are all injectable opts on fetchTranscript — no real yt-dlp/whisper-cli
// binary or network call happens in any of these tests.
// ---------------------------------------------------------------------------

test('fetchTranscript: transcribe "always" with whisper present skips captions entirely and returns the transcriber result', async () => {
  let primaryCalled = false;
  const primaryFetcher = async () => {
    primaryCalled = true;
    throw new Error('should not be called');
  };
  const result = await fetchTranscript('vid1', {
    transcribe: 'always',
    whisperResolver: () => ({}),
    transcriber: async () => [{ text: 'w', offset: 0 }],
    primaryFetcher,
    retryDelaysMs: [],
  });
  assert.deepEqual(result, [{ text: 'w', offset: 0 }]);
  assert.equal(primaryCalled, false);
});

test('fetchTranscript: transcribe "always" with whisper absent falls back to captions and never calls the transcriber', async () => {
  let transcriberCalled = false;
  const transcriber = async () => {
    transcriberCalled = true;
    throw new Error('should not be called');
  };
  const result = await fetchTranscript('vid2', {
    transcribe: 'always',
    whisperResolver: () => null,
    primaryFetcher: async () => [{ text: 'cap', offset: 0 }],
    transcriber,
    retryDelaysMs: [],
  });
  assert.deepEqual(result, [{ text: 'cap', offset: 0 }]);
  assert.equal(transcriberCalled, false);
});

test('fetchTranscript: transcribe "fallback" invokes whisper only after both caption paths fail', async () => {
  const result = await fetchTranscript('vid3', {
    transcribe: 'fallback',
    primaryFetcher: async () => { throw new Error('primary failed'); },
    captionFallback: async () => { throw new Error('yt-dlp caption fallback failed'); },
    whisperResolver: () => ({}),
    transcriber: async () => [{ text: 'w', offset: 0 }],
    retryDelaysMs: [],
  });
  assert.deepEqual(result, [{ text: 'w', offset: 0 }]);
});

test('fetchTranscript: transcribe "fallback" rejects with TRANSCRIPT_UNAVAILABLE when whisper itself fails', async () => {
  await assert.rejects(
    () => fetchTranscript('vid4', {
      transcribe: 'fallback',
      primaryFetcher: async () => { throw new Error('primary failed'); },
      captionFallback: async () => { throw new Error('yt-dlp caption fallback failed'); },
      whisperResolver: () => ({}),
      transcriber: async () => { throw new Error('whisper transcription failed'); },
      retryDelaysMs: [],
    }),
    (err) => err.echoCode === 'TRANSCRIPT_UNAVAILABLE'
  );
});

test('fetchTranscript: transcribe "off" never calls whisper even when both caption paths fail', async () => {
  let transcriberCalled = false;
  const transcriber = async () => {
    transcriberCalled = true;
    throw new Error('should not be called');
  };
  await assert.rejects(
    () => fetchTranscript('vid5', {
      transcribe: 'off',
      primaryFetcher: async () => { throw new Error('primary failed'); },
      captionFallback: async () => { throw new Error('yt-dlp caption fallback failed'); },
      whisperResolver: () => ({}),
      transcriber,
      retryDelaysMs: [],
    }),
    (err) => err.echoCode === 'TRANSCRIPT_UNAVAILABLE'
  );
  assert.equal(transcriberCalled, false);
});

test('fetchTranscript: transcribe "fallback" with no whisper resolved never calls the transcriber', async () => {
  let transcriberCalled = false;
  const transcriber = async () => {
    transcriberCalled = true;
    throw new Error('should not be called');
  };
  await assert.rejects(
    () => fetchTranscript('vid6', {
      transcribe: 'fallback',
      primaryFetcher: async () => { throw new Error('primary failed'); },
      captionFallback: async () => { throw new Error('yt-dlp caption fallback failed'); },
      whisperResolver: () => null,
      transcriber,
      retryDelaysMs: [],
    }),
    (err) => err.echoCode === 'TRANSCRIPT_UNAVAILABLE'
  );
  assert.equal(transcriberCalled, false);
});
