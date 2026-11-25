import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mapFramesError, cleanupFrames, findCues, planVisuals } from '../frames.js';
import { generateDigest, buildClaudeArgs, buildClaudeStreamArgs } from '../digest.js';
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
  // The block sits in the instructions, ahead of the transcript, and names the files.
  const at = capturedPrompt.indexOf('frame-001.jpg');
  assert.ok(at > 0 && at < capturedPrompt.indexOf('Here is the transcript'));
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

// ---------------------------------------------------------------------------
// When a digest reads frames: findCues + planVisuals
// ---------------------------------------------------------------------------

const seg = (offset, text) => ({ offset, text });
// 10 minutes, a pointing phrase every 100 s: 6 cues, well over 2 per 10 min.
const pointing = Array.from({ length: 61 }, (_, i) => seg(i * 10, i % 10 === 0 ? 'look at this chart' : 'and so on'));
const talking = Array.from({ length: 61 }, (_, i) => seg(i * 10, 'and so on'));
const local = { visuals: true, videoId: 'GRzaq5AHiV8', web: false, providerKind: 'cli' };

test('findCues: one cue per pointing phrase, 20 s apart, 2 s after the segment, in three languages', () => {
  const r = findCues([
    seg(10, 'as you can see here'), seg(15, 'look at this'), // 5 s later: same moment
    seg(40, 'Wie ihr hier seht'), seg(80, 'bisa kalian lihat di layar'), seg(120, 'nothing to see'),
    { offset: 'x', text: 'look at this' }, null, seg(200, 42),
  ]);
  assert.deepEqual(r, { count: 3, times: [12, 42, 82] });
});

test('findCues: more cues than the cap are spread over the whole video, not the first minutes', () => {
  const many = Array.from({ length: 40 }, (_, i) => seg(i * 60, 'this slide'));
  const { count, times } = findCues(many);
  assert.equal(count, 40);
  assert.equal(times.length, 8);
  assert.ok(times[7] > 2000, `last cue at ${times[7]} s should be near the end`);
});

test('planVisuals: a video that points at its screen gets frames at those moments', () => {
  const plan = planVisuals({ ...local, segments: pointing });
  assert.deepEqual(plan, { cueTimes: [2, 102, 202, 302, 402, 502, 602], durationSec: 600 });
});

test('planVisuals: a talking-only video, the setting off, or a bad request gets none', () => {
  assert.equal(planVisuals({ ...local, segments: talking }), null);
  assert.equal(planVisuals({ ...local, segments: pointing, visuals: undefined }), null);
  assert.equal(planVisuals({ ...local, segments: pointing, visuals: 'true' }), null);
  assert.equal(planVisuals({ ...local, segments: 'look at this' }), null);
  assert.equal(planVisuals({ ...local, segments: [] }), null);
});

test('planVisuals: never in web mode, never for an API provider, never for a local file', () => {
  assert.equal(planVisuals({ ...local, segments: pointing, web: true }), null);
  assert.equal(planVisuals({ ...local, segments: pointing, web: undefined }), null, 'unknown mode fails closed');
  assert.equal(planVisuals({ ...local, segments: pointing, providerKind: 'anthropic' }), null);
  assert.equal(planVisuals({ ...local, segments: pointing, videoId: 'file_0123456789abcd' }), null);
});

test('planVisuals: nothing past 90 minutes (a long download for one digest)', () => {
  const long = pointing.map((s) => seg(s.offset * 10, s.text)); // 100 minutes
  assert.equal(planVisuals({ ...local, segments: long }), null);
});

test('buildClaudeArgs: a digest gets no tools and no MCP servers; frames get Read, confined by --restricted', () => {
  // Measured 2026-11-25: a default `claude -p` printed a file from outside its
  // working directory on request, and listed the user's Gmail/Drive connectors.
  // A transcript is untrusted text, so this is the guard.
  for (const build of [buildClaudeArgs, buildClaudeStreamArgs]) {
    const plain = build();
    assert.equal(plain[plain.indexOf('--tools') + 1], '', 'no built-in tools');
    assert.ok(plain.includes('--strict-mcp-config'), 'no MCP servers');
    assert.ok(!plain.includes('--restricted') && !plain.includes('--allowedTools') && !plain.includes('--add-dir'));

    const withFrames = build({ framesDir: '/tmp/echo-frames-x' });
    assert.equal(withFrames[withFrames.indexOf('--tools') + 1], 'Read');
    assert.ok(withFrames.includes('--restricted'), 'Read confined to the working directory');
    assert.ok(withFrames.includes('--strict-mcp-config'));
    assert.ok(!withFrames.includes('--allowedTools') && !withFrames.includes('--add-dir'));
    const sp = withFrames[withFrames.indexOf('--system-prompt') + 1];
    assert.match(sp, /Read tool/);
    assert.ok(!/[&|<>^%"]/.test(sp), 'frames system prompt must survive cmd.exe /c unescaped');
  }
});
