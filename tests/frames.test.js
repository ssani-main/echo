import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mapFramesError, cleanupFrames } from '../frames.js';
import { generateDigest } from '../digest.js';
import { ApiKeyProvider } from '../providers.js';

// ---------------------------------------------------------------------------
// mapFramesError
//
// Pure function — every branch is exercised directly with synthetic error
// objects. No ffmpeg/yt-dlp/claude binaries are invoked anywhere in this file.
// ---------------------------------------------------------------------------

test('mapFramesError: an error with a pre-set echoCode passes through echoCode/message/hint unchanged', () => {
  const err = { echoCode: 'VIDEO_TOO_LONG', message: 'm', hint: 'h' };
  const mapped = mapFramesError(err);
  assert.deepEqual(mapped, { echoCode: 'VIDEO_TOO_LONG', message: 'm', hint: 'h' });
});

test('mapFramesError: a pre-set echoCode without an explicit hint falls back to the generic hint', () => {
  const err = { echoCode: 'VIDEO_TOO_LONG', message: 'too long' };
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'VIDEO_TOO_LONG');
  assert.equal(mapped.message, 'too long');
  assert.equal(mapped.hint, 'Could not extract frames from this video.');
});

test('mapFramesError: ffmpeg ENOENT maps to FFMPEG_MISSING with an install hint', () => {
  const err = { code: 'ENOENT', path: 'ffmpeg', message: 'spawn ffmpeg ENOENT' };
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'FFMPEG_MISSING');
  assert.equal(mapped.message, 'spawn ffmpeg ENOENT');
  assert.match(mapped.hint, /ffmpeg/i);
});

test('mapFramesError: yt-dlp ENOENT maps to YTDLP_MISSING with an install hint', () => {
  const err = { code: 'ENOENT', path: 'yt-dlp', message: 'spawn yt-dlp ENOENT' };
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'YTDLP_MISSING');
  assert.equal(mapped.message, 'spawn yt-dlp ENOENT');
  assert.match(mapped.hint, /yt-dlp/i);
});

test('mapFramesError: ENOENT with an unrecognized path/message maps to a generic FRAMES_FAILED binary hint', () => {
  const err = { code: 'ENOENT', path: 'some-other-binary', message: 'spawn some-other-binary ENOENT' };
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'FRAMES_FAILED');
  assert.equal(mapped.message, 'spawn some-other-binary ENOENT');
  assert.match(mapped.hint, /binary/i);
});

test('mapFramesError: a killed/SIGTERM timeout maps to FRAMES_TIMEOUT', () => {
  const err = { killed: true, signal: 'SIGTERM', message: 'timed out' };
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'FRAMES_TIMEOUT');
  assert.equal(mapped.message, 'timed out');
  assert.match(mapped.hint, /too long/i);
});

test('mapFramesError: a message matching /timed?\\s?out/i maps to FRAMES_TIMEOUT even without killed/signal set', () => {
  const err = new Error('the operation timed out');
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'FRAMES_TIMEOUT');
});

test('mapFramesError: a generic Error maps to FRAMES_FAILED with the generic hint', () => {
  const err = new Error('boom');
  const mapped = mapFramesError(err);
  assert.equal(mapped.echoCode, 'FRAMES_FAILED');
  assert.equal(mapped.message, 'boom');
  assert.equal(mapped.hint, 'Could not extract frames from this video.');
});

test('mapFramesError: null/undefined input does not throw and maps to a generic FRAMES_FAILED', () => {
  const mappedNull = mapFramesError(null);
  assert.equal(mappedNull.echoCode, 'FRAMES_FAILED');
  assert.equal(typeof mappedNull.message, 'string');
  assert.equal(typeof mappedNull.hint, 'string');

  const mappedUndefined = mapFramesError(undefined);
  assert.equal(mappedUndefined.echoCode, 'FRAMES_FAILED');
  assert.equal(typeof mappedUndefined.message, 'string');
  assert.equal(typeof mappedUndefined.hint, 'string');
});

test('mapFramesError: the returned shape always has echoCode/message/hint string fields', () => {
  const inputs = [
    { echoCode: 'X', message: 'm', hint: 'h' },
    { code: 'ENOENT', path: 'ffmpeg', message: 'spawn ffmpeg ENOENT' },
    { code: 'ENOENT', path: 'yt-dlp', message: 'spawn yt-dlp ENOENT' },
    { code: 'ENOENT', path: 'mystery', message: 'spawn mystery ENOENT' },
    { killed: true, signal: 'SIGTERM', message: 'timed out' },
    new Error('boom'),
    null,
    undefined,
  ];
  for (const input of inputs) {
    const mapped = mapFramesError(input);
    assert.equal(typeof mapped.echoCode, 'string');
    assert.equal(typeof mapped.message, 'string');
    assert.equal(typeof mapped.hint, 'string');
  }
});

// ---------------------------------------------------------------------------
// cleanupFrames
//
// Best-effort by design — must never throw, even on a non-existent path or a
// missing argument.
// ---------------------------------------------------------------------------

test('cleanupFrames: resolves without throwing for a non-existent directory', async () => {
  const bogus = path.join(os.tmpdir(), `echo-frames-does-not-exist-${Date.now()}`);
  await assert.doesNotReject(() => cleanupFrames(bogus));
});

test('cleanupFrames: resolves without throwing when called with undefined', async () => {
  await assert.doesNotReject(() => cleanupFrames(undefined));
});

test('cleanupFrames: resolves without throwing when called with null', async () => {
  await assert.doesNotReject(() => cleanupFrames(null));
});

test('cleanupFrames: removes a real temp directory and its contents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-frames-test-'));
  await fs.writeFile(path.join(dir, 'frame-001.jpg'), 'fake-jpg-bytes');

  await cleanupFrames(dir);

  await assert.rejects(() => fs.stat(dir), (err) => err.code === 'ENOENT');
});

// ---------------------------------------------------------------------------
// generateDigest frames plumbing
//
// getProvider(opts) returns ApiKeyProvider whenever opts.apiKey is supplied
// (see providers.js), so mocking ApiKeyProvider.call is enough to exercise
// generateDigest's frames handling without spawning the real `claude` CLI —
// same technique as tests/tags-suggest.test.js / provider-error-mapping.test.js.
// ---------------------------------------------------------------------------

function fakeUsage() {
  return {
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 120,
    durationMs: 5,
  };
}

test('generateDigest: with no opts.frames, visualFrames is 0 and behaves as before', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: 'A digest with no visual grounding.',
    usage: fakeUsage(),
  }));

  const { digest, visualFrames } = await generateDigest('some transcript text', { apiKey: 'sk-test' });

  assert.equal(digest, 'A digest with no visual grounding.');
  assert.equal(visualFrames, 0);
});

test('generateDigest: passing opts.frames with items yields visualFrames equal to the item count', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: 'A digest grounded in the sampled frames.', usage: fakeUsage() };
  });

  const frames = { dir: '/x', items: [{ path: '/x/frame-001.jpg', offsetSec: 12 }] };
  const { digest, visualFrames } = await generateDigest('some transcript text', {
    apiKey: 'sk-test',
    frames,
  });

  assert.equal(digest, 'A digest grounded in the sampled frames.');
  assert.equal(visualFrames, 1);
  // The frame-count prompt block should be woven into the prompt sent to the provider.
  assert.match(capturedPrompt, /frame/i);
});

test('generateDigest: opts.frames with an empty items array is treated the same as no frames (visualFrames: 0)', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: 'A digest with an empty frames list.',
    usage: fakeUsage(),
  }));

  const { visualFrames } = await generateDigest('some transcript text', {
    apiKey: 'sk-test',
    frames: { dir: '/x', items: [] },
  });

  assert.equal(visualFrames, 0);
});
