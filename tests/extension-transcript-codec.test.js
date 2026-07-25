import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The extension-to-page transcript handoff (see CLAUDE.md's "let the browser
// extension scrape it" architecture note) is a matched encoder/decoder pair
// that live in two files which cannot import each other:
//
//   - extension/shared.js   echoEncodeTranscript()  — gzip + base64url
//   - public/app.js         applyExtensionTranscript() (decode half, private)
//
// That is exactly the "a copied function will drift, silently" trap CLAUDE.md
// warns about — except here it isn't even a copy, it's two different
// operations that only work if they stay inverses of each other. This file
// round-trips a payload through the real encoder and the real decoder (lifted
// out of app.js by brace-matching, the same technique
// tests/markdown-render.test.js and tests/shared-parity.test.js use) and
// fails loudly the moment they disagree.
//
// It also covers the decoder's validator directly, since — per the trust
// boundary comment in app.js itself — that check is the one that actually
// matters: a hostile page can hand a visitor `<echo>/?v=…#echo-tx=…` with a
// fabricated payload without going through the extension at all.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const require_ = createRequire(import.meta.url);
const { echoEncodeTranscript } = require_(join(ROOT, 'extension', 'shared.js'));

const APP_SOURCE = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

/**
 * Slice one top-level `function name(...) { ... }` out of public/app.js,
 * keeping a leading `async ` if the declaration has one — applyExtensionTranscript
 * is async, and dropping that keyword would leave a syntactically-broken
 * function full of `await` with no `async`.
 */
function sliceFunction(name) {
  let start = APP_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in public/app.js — was it renamed?`);
  const asyncPrefix = 'async ';
  if (APP_SOURCE.slice(start - asyncPrefix.length, start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  let depth = 0;
  let i = APP_SOURCE.indexOf('{', start);
  for (; i < APP_SOURCE.length; i++) {
    if (APP_SOURCE[i] === '{') depth++;
    else if (APP_SOURCE[i] === '}') { depth--; if (depth === 0) break; }
  }
  return APP_SOURCE.slice(start, i + 1);
}

// applyExtensionTranscript() calls applyTranscriptResponse() on success —
// stub it so the test can observe what would have been applied without
// dragging in the whole page (DOM elements, session storage, etc. that
// app.js's top-level scope assumes exist).
let lastApplied = null;
function applyTranscriptResponse(data) { lastApplied = data; }

const { applyExtensionTranscript, isValidExtensionTranscript } = new Function(
  'applyTranscriptResponse',
  `${sliceFunction('isValidExtensionTranscript')}
   ${sliceFunction('applyExtensionTranscript')}
   return { applyExtensionTranscript, isValidExtensionTranscript };`
)(applyTranscriptResponse);

const SAMPLE_PAYLOAD = {
  videoId: 'GRzaq5AHiV8',
  url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8',
  title: 'A sample video',
  channel: 'A Sample Channel',
  channelUrl: 'https://www.youtube.com/channel/UC12345',
  langCode: 'en',
  transcriptSource: 'captions',
  segments: [
    { text: 'Hello and welcome to the video.', offset: 0 },
    { text: 'This is the second segment — em dash, “quotes”, ellipsis…', offset: 3.5 },
    { text: '第三段：非 ASCII 文本也要能往返。', offset: 8.25 },
  ],
};

test('round trip: encode with extension/shared.js, decode with public/app.js', async () => {
  lastApplied = null;
  const encoded = await echoEncodeTranscript(SAMPLE_PAYLOAD);
  assert.equal(typeof encoded, 'string');

  const applied = await applyExtensionTranscript(encoded, SAMPLE_PAYLOAD.videoId);
  assert.equal(applied, true);
  assert.deepEqual(lastApplied, SAMPLE_PAYLOAD);
});

test('round trip: fails closed on a mismatched expected video id', async () => {
  lastApplied = null;
  const encoded = await echoEncodeTranscript(SAMPLE_PAYLOAD);
  const applied = await applyExtensionTranscript(encoded, 'differentId');
  assert.equal(applied, false);
  assert.equal(lastApplied, null);
});

test('round trip: fails closed on garbage input instead of throwing', async () => {
  for (const bad of ['', 'not-base64-gzip', 'GRzaq5AHiV8'.repeat(100)]) {
    const applied = await applyExtensionTranscript(bad, 'GRzaq5AHiV8');
    assert.equal(applied, false, `expected false for: ${JSON.stringify(bad).slice(0, 40)}`);
  }
});

// --- isValidExtensionTranscript(): the real trust boundary ------------------

test('validator: accepts a well-formed payload', () => {
  assert.equal(isValidExtensionTranscript(SAMPLE_PAYLOAD, 'GRzaq5AHiV8'), true);
});

test('validator: rejects a non-object payload', () => {
  for (const bad of [null, undefined, 'a string', 42, ['array', 'not', 'object'], true]) {
    assert.equal(isValidExtensionTranscript(bad, 'GRzaq5AHiV8'), false, `expected false for: ${JSON.stringify(bad)}`);
  }
});

test('validator: rejects an oversized segments array', () => {
  const segments = new Array(50001).fill({ text: 'x', offset: 0 });
  const payload = { ...SAMPLE_PAYLOAD, segments };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false);
});

test('validator: rejects an empty segments array', () => {
  const payload = { ...SAMPLE_PAYLOAD, segments: [] };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false);
});

test('validator: rejects a non-numeric offset', () => {
  const payload = { ...SAMPLE_PAYLOAD, segments: [{ text: 'x', offset: '0' }] };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false);
});

test('validator: rejects a non-finite offset (NaN / Infinity)', () => {
  for (const offset of [NaN, Infinity, -Infinity]) {
    const payload = { ...SAMPLE_PAYLOAD, segments: [{ text: 'x', offset }] };
    assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false, `expected false for offset ${offset}`);
  }
});

test('validator: rejects an over-length segment text', () => {
  const payload = { ...SAMPLE_PAYLOAD, segments: [{ text: 'x'.repeat(5001), offset: 0 }] };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false);
});

test('validator: rejects a videoId that does not match the expected ?v= id', () => {
  assert.equal(isValidExtensionTranscript(SAMPLE_PAYLOAD, 'somethingElse'), false);
});

test('validator: rejects a videoId that fails the YouTube id shape', () => {
  const payload = { ...SAMPLE_PAYLOAD, videoId: 'not an id!' };
  assert.equal(isValidExtensionTranscript(payload, 'not an id!'), false);
});

test('validator: rejects an over-length optional string field', () => {
  const payload = { ...SAMPLE_PAYLOAD, title: 'x'.repeat(501) };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), false);
});

test('validator: tolerates missing optional fields', () => {
  const payload = {
    videoId: 'GRzaq5AHiV8',
    segments: [{ text: 'hello', offset: 0 }],
  };
  assert.equal(isValidExtensionTranscript(payload, 'GRzaq5AHiV8'), true);
});
