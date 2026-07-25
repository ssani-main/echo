import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  resolveWhisper,
  mapWhisperJson,
  mapWhisperError,
  isTransientDownloadFailure,
  DEFAULT_DOWNLOAD_RETRY_DELAYS_MS,
  withDownloadRetry,
  chooseModelForLanguage,
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

// Regression: ffmpeg *running* and rejecting the input is a different failure
// from ffmpeg being absent, and it used to have no code at all — so a corrupt
// upload reached the user as a bare 500 "unexpected server error" with no hint.
test('mapWhisperError: a non-zero ffmpeg exit maps to MEDIA_UNREADABLE, not FFMPEG_MISSING', () => {
  const err = {
    exitCode: 1,
    message: "ffmpeg exited with code 1: Invalid data found when processing input",
    stderr: 'Invalid data found when processing input',
  };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'MEDIA_UNREADABLE');
  assert.match(mapped.hint, /corrupt|truncated|not an audio/i);
});

// The decode check must not swallow a conversion we killed ourselves: a timeout
// also exits non-zero via ffmpeg, but the cause — and the fix — is different.
test('mapWhisperError: an ffmpeg conversion killed on timeout is still WHISPER_TIMEOUT', () => {
  const err = {
    killed: true, signal: 'SIGTERM', exitCode: null,
    message: 'ffmpeg exited with code null (SIGTERM): ',
  };
  const mapped = mapWhisperError(err);
  assert.equal(mapped.echoCode, 'WHISPER_TIMEOUT');
});

// An absent binary must keep reporting FFMPEG_MISSING — that one is fixable by
// installing something, and MEDIA_UNREADABLE would send the user hunting a
// nonexistent problem in their file.
test('mapWhisperError: ffmpeg ENOENT still wins over the decode-failure branch', () => {
  const err = { code: 'ENOENT', message: 'spawn ffmpeg ENOENT', path: 'ffmpeg' };
  assert.equal(mapWhisperError(err).echoCode, 'FFMPEG_MISSING');
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

test('resolveWhisper: no opts and no env returns null', async () => {
  // Hermetic: point the model cache at a guaranteed-empty dir so a model that
  // happens to be downloaded on this machine (real users download one) can't
  // make resolveWhisper resolve a real path and fail this assertion.
  const savedModelDir = process.env.ECHO_WHISPER_MODEL_DIR;
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-empty-'));
  process.env.ECHO_WHISPER_MODEL_DIR = emptyDir;
  try {
    assert.equal(resolveWhisper(), null);
    assert.equal(resolveWhisper({}), null);
  } finally {
    if (savedModelDir === undefined) delete process.env.ECHO_WHISPER_MODEL_DIR;
    else process.env.ECHO_WHISPER_MODEL_DIR = savedModelDir;
    await fs.rm(emptyDir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Audio-download retry + 403 classification.
//
// The caption path has retried since day one; the Whisper audio download never
// did. A single transient refusal threw the whole run away *after* the binary
// and model had already been resolved, and reported "Could not transcribe this
// video" — which reads as a fact about the video and stops the user retrying.
// Observed live: YouTube 403'd format 139, and the identical yt-dlp command
// succeeded from a shell seconds later.
// ---------------------------------------------------------------------------

const ytdlpFail = (stderr) => Object.assign(new Error(`yt-dlp exited with code 1: ${stderr}`), { stderr, exitCode: 1 });

test('isTransientDownloadFailure: a 403 is transient', () => {
  assert.equal(isTransientDownloadFailure(ytdlpFail('ERROR: unable to download video data: HTTP Error 403: Forbidden')), true);
});

test('isTransientDownloadFailure: 429 and 5xx are transient', () => {
  assert.equal(isTransientDownloadFailure(ytdlpFail('HTTP Error 429: Too Many Requests')), true);
  assert.equal(isTransientDownloadFailure(ytdlpFail('HTTP Error 503: Service Unavailable')), true);
});

// Retrying these just makes the user wait three times as long for the same no.
test('isTransientDownloadFailure: a fact about the video is NOT transient', () => {
  assert.equal(isTransientDownloadFailure(ytdlpFail('ERROR: Private video. Sign in if you have been granted access.')), false);
  assert.equal(isTransientDownloadFailure(ytdlpFail('ERROR: Video unavailable')), false);
  assert.equal(isTransientDownloadFailure(ytdlpFail('ERROR: Join this channel to get access to members-only content')), false);
});

// A cancelled request and a timeout we imposed are both "stop", not "try again".
test('isTransientDownloadFailure: aborts and our own timeouts are not retried', () => {
  assert.equal(isTransientDownloadFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isTransientDownloadFailure(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), false);
  assert.equal(isTransientDownloadFailure(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })), false);
});

test('isTransientDownloadFailure: null/undefined are not transient', () => {
  assert.equal(isTransientDownloadFailure(null), false);
  assert.equal(isTransientDownloadFailure(undefined), false);
});

test('the default gives two retries, so three attempts in total', () => {
  assert.equal(DEFAULT_DOWNLOAD_RETRY_DELAYS_MS.length, 2);
  assert.ok(DEFAULT_DOWNLOAD_RETRY_DELAYS_MS.every((d) => Number.isFinite(d) && d > 0));
});

// The whole point, tested for real against the retry helper itself.
test('a 403 that clears on the second attempt is invisible to the caller', async () => {
  let attempts = 0;
  const result = await withDownloadRetry(async () => {
    attempts++;
    if (attempts === 1) throw ytdlpFail('HTTP Error 403: Forbidden');
    return 'downloaded';
  }, { downloadRetryDelaysMs: [1, 1] });
  assert.equal(result, 'downloaded');
  assert.equal(attempts, 2, 'should have retried exactly once');
});

test('a 403 that never clears becomes AUDIO_DOWNLOAD_REFUSED, not WHISPER_FAILED', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withDownloadRetry(async () => {
      attempts++;
      throw ytdlpFail('ERROR: unable to download video data: HTTP Error 403: Forbidden');
    }, { downloadRetryDelaysMs: [1, 1] }),
    (err) => {
      assert.equal(err.echoCode, 'AUDIO_DOWNLOAD_REFUSED');
      assert.match(err.hint, /temporar|try again/i);
      assert.match(err.detail, /403/);
      return true;
    }
  );
  assert.equal(attempts, 3, 'two delays means three attempts');
});

// Retrying a private video just makes the user wait three times as long.
test('a permanent failure is not retried and keeps its original error', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withDownloadRetry(async () => {
      attempts++;
      throw ytdlpFail('ERROR: Private video. Sign in if you have been granted access.');
    }, { downloadRetryDelaysMs: [1, 1] }),
    (err) => err.echoCode === undefined && /Private video/.test(err.stderr)
  );
  assert.equal(attempts, 1, 'must not retry a fact about the video');
});

test('passing [] disables retries entirely', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withDownloadRetry(async () => { attempts++; throw ytdlpFail('HTTP Error 403: Forbidden'); },
      { downloadRetryDelaysMs: [] }),
    (err) => err.echoCode === 'AUDIO_DOWNLOAD_REFUSED'
  );
  assert.equal(attempts, 1);
});

// In `fallback` mode transcript.js rewrites the headline, so the retry fix has
// to survive that path too — otherwise a transient refusal still reads as
// "Whisper couldn't transcribe this video" and the user gives up.
test('fetchTranscript: a refused audio download keeps a retryable headline in fallback mode', async () => {
  const refused = Object.assign(new Error('YouTube refused the audio download.'), {
    echoCode: 'AUDIO_DOWNLOAD_REFUSED',
    hint: 'YouTube throttles audio downloads under load. This is usually temporary — try again in a minute.',
  });
  await assert.rejects(
    () => fetchTranscript('vidRefused', {
      transcribe: 'fallback',
      primaryFetcher: async () => { throw new Error('Transcript is disabled on this video'); },
      captionFallback: async () => { throw Object.assign(new Error('no subs'), { code: 'ENOENT', syscall: 'open' }); },
      whisperResolver: () => ({}),
      transcriber: async () => { throw refused; },
      retryDelaysMs: [],
    }),
    (err) => {
      assert.equal(err.reason, 'whisper_failed');
      assert.match(err.message, /refused the audio download/i);
      assert.doesNotMatch(err.message, /couldn't transcribe this video/i);
      assert.match(err.hint, /temporar|try again/i);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// chooseModelForLanguage — model selection from the video's language.
//
// Measured 2026-07-25 (WHISPER.md): `base` renders Indonesian badly enough to
// be unusable in places ("niatnya bagus" -> "nyanyi bagus"), while `small`
// handles the same passage cleanly. Upgrading is worth ~3x the runtime; doing
// it when it is NOT needed is pure cost, so every branch is pinned here.
// ---------------------------------------------------------------------------

test('chooseModelForLanguage: base + a non-English language upgrades to small', () => {
  assert.equal(chooseModelForLanguage('base', 'id'), 'small');
  assert.equal(chooseModelForLanguage('base', 'de'), 'small');
  assert.equal(chooseModelForLanguage('base', 'ja'), 'small');
});

test('chooseModelForLanguage: base + English stays on base', () => {
  assert.equal(chooseModelForLanguage('base', 'en'), 'base');
  assert.equal(chooseModelForLanguage('base', 'en-US'), 'base');
  assert.equal(chooseModelForLanguage('base', 'EN'), 'base');
});

// yt-dlp prints "NA" when YouTube has no language metadata (verified against a
// real video). Guessing from nothing would cost 3x runtime on a hunch.
test('chooseModelForLanguage: an unknown language does not trigger an upgrade', () => {
  for (const unknown of ['NA', 'na', '', null, undefined, 'none']) {
    assert.equal(chooseModelForLanguage('base', unknown), 'base', `unknown=${unknown}`);
  }
});

test('chooseModelForLanguage: an explicit small is never downgraded', () => {
  assert.equal(chooseModelForLanguage('small', 'en'), 'small');
  assert.equal(chooseModelForLanguage('small', 'id'), 'small');
  assert.equal(chooseModelForLanguage('small', 'NA'), 'small');
});

test('chooseModelForLanguage: an unrecognised model is left alone', () => {
  assert.equal(chooseModelForLanguage('medium', 'id'), 'medium');
  assert.equal(chooseModelForLanguage('large-v3', 'id'), 'large-v3');
});
