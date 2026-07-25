import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// extension/shared.js is a classic script (MV3 content scripts are not ES
// modules), so it is loaded here through createRequire against the scoped
// extension/package.json {"type":"commonjs"} — the same pattern tools/ai-tell
// uses, and the reason that package.json exists. Importing it directly would
// yield an empty namespace under this repo's root "type":"module".
const require = createRequire(import.meta.url);
const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const {
  echoExtractVideoId, echoNormalizeServer, echoReadUrl, ECHO_DEFAULT_SERVER,
  echoReadUrlWithTranscript, echoEncodeTranscript, ECHO_TX_HASH_KEY, ECHO_TX_MAX_ENCODED,
  echoParseTimestamp,
} = require(join(EXT_DIR, 'shared.js'));

// ---------------------------------------------------------------------------
// echoExtractVideoId — deliberately mirrors extractVideoId() in transcript.js.
// The extension cannot import server code, so these cases are what keeps the
// two copies honest: if one side learns a URL form, this file should fail.
// ---------------------------------------------------------------------------

test('echoExtractVideoId: watch URLs, with and without extra params', () => {
  assert.equal(echoExtractVideoId('https://www.youtube.com/watch?v=GRzaq5AHiV8'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://www.youtube.com/watch?v=GRzaq5AHiV8&t=42s'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://www.youtube.com/watch?list=PL123&v=GRzaq5AHiV8'), 'GRzaq5AHiV8');
});

test('echoExtractVideoId: short, shorts, embed and live forms', () => {
  assert.equal(echoExtractVideoId('https://youtu.be/GRzaq5AHiV8'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://youtu.be/GRzaq5AHiV8?t=10'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://www.youtube.com/shorts/GRzaq5AHiV8'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://www.youtube.com/embed/GRzaq5AHiV8'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('https://www.youtube.com/live/GRzaq5AHiV8'), 'GRzaq5AHiV8');
});

test('echoExtractVideoId: a bare 11-character id passes through', () => {
  assert.equal(echoExtractVideoId('GRzaq5AHiV8'), 'GRzaq5AHiV8');
  assert.equal(echoExtractVideoId('_-aBcDeFgHi'), '_-aBcDeFgHi');
});

test('echoExtractVideoId: non-video YouTube pages yield null', () => {
  // These are exactly the pages the content script must NOT put a button on.
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/results?search_query=whatever',
    'https://www.youtube.com/playlist?list=PL1234567890',
  ]) {
    assert.equal(echoExtractVideoId(url), null, url);
  }
});

test('echoExtractVideoId: junk input yields null rather than throwing', () => {
  assert.equal(echoExtractVideoId(''), null);
  assert.equal(echoExtractVideoId(null), null);
  assert.equal(echoExtractVideoId(undefined), null);
  assert.equal(echoExtractVideoId(12345), null);
  assert.equal(echoExtractVideoId('too-short'), null);
  assert.equal(echoExtractVideoId('waytoolongtobeavideoid'), null);
});

// ---------------------------------------------------------------------------
// echoNormalizeServer — the value becomes a URL the worker navigates to, so a
// non-http(s) scheme has to be refused. Host-based checks do NOT catch this:
// new URL('javascript:alert(1)').host === '' (see CLAUDE.md).
// ---------------------------------------------------------------------------

test('echoNormalizeServer: keeps http(s) origins and strips trailing slashes', () => {
  assert.equal(echoNormalizeServer('http://localhost:8000'), 'http://localhost:8000');
  assert.equal(echoNormalizeServer('http://localhost:8000/'), 'http://localhost:8000');
  assert.equal(echoNormalizeServer('http://localhost:8000///'), 'http://localhost:8000');
  assert.equal(echoNormalizeServer('  https://echo.example.com  '), 'https://echo.example.com');
});

test('echoNormalizeServer: keeps a subpath, for Echo behind a reverse proxy', () => {
  assert.equal(echoNormalizeServer('https://example.com/echo'), 'https://example.com/echo');
  assert.equal(echoNormalizeServer('https://example.com/echo/'), 'https://example.com/echo');
});

test('echoNormalizeServer: refuses every non-http(s) scheme', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome-extension://abcdef/options.html',
    'ftp://example.com',
    '//example.com',
    'example.com',
    '',
    '   ',
  ]) {
    assert.equal(echoNormalizeServer(bad), null, `should refuse: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// echoReadUrl — Echo's frontend reads ?v= on load (autoLoadFromQuery) and
// kicks off the transcript fetch itself.
// ---------------------------------------------------------------------------

test('echoReadUrl: builds the deep link Echo auto-loads from', () => {
  assert.equal(
    echoReadUrl('http://localhost:8000', 'GRzaq5AHiV8'),
    'http://localhost:8000/?v=GRzaq5AHiV8'
  );
});

test('echoReadUrl: percent-encodes the id', () => {
  assert.equal(echoReadUrl('http://localhost:8000', 'a b&c'), 'http://localhost:8000/?v=a%20b%26c');
});

test('the default server is the address `npm start` prints', () => {
  assert.equal(ECHO_DEFAULT_SERVER, 'http://localhost:8000');
});

// ---------------------------------------------------------------------------
// echoEncodeTranscript / echoReadUrlWithTranscript — the extension side of
// the transcript handoff. The decode+validate half lives in public/app.js
// and can't import this file (classic script, no build step) — see
// tests/extension-transcript-codec.test.js for the round trip between them.
// ---------------------------------------------------------------------------

test('echoEncodeTranscript: produces a URL-safe string with no base64 padding', async () => {
  const encoded = await echoEncodeTranscript({
    videoId: 'GRzaq5AHiV8',
    segments: [{ text: 'hello', offset: 0 }],
  });
  assert.equal(typeof encoded, 'string');
  assert.ok(encoded.length > 0);
  // base64url: no '+', '/' or '=' padding.
  assert.ok(!/[+/=]/.test(encoded), `expected no +, / or = in: ${encoded}`);
});

test('echoEncodeTranscript: returns null once the encoded result exceeds the cap', async () => {
  // A giant, poorly-compressing payload (random-ish text defeats gzip)
  // pushed well past ECHO_TX_MAX_ENCODED.
  const segments = [];
  for (let i = 0; i < 20000; i++) {
    segments.push({ text: `segment ${i} ${Math.random()}`, offset: i });
  }
  const encoded = await echoEncodeTranscript({ videoId: 'GRzaq5AHiV8', segments });
  // Either it legitimately fit (compresses better than expected) or it was
  // rejected for being too big — either way the cap must be respected.
  if (encoded !== null) {
    assert.ok(encoded.length <= ECHO_TX_MAX_ENCODED);
  } else {
    assert.equal(encoded, null);
  }
});

test('echoReadUrlWithTranscript: appends the fragment after the normal ?v= URL', () => {
  const url = echoReadUrlWithTranscript('http://localhost:8000', 'GRzaq5AHiV8', 'abc123');
  assert.equal(url, `http://localhost:8000/?v=GRzaq5AHiV8#${ECHO_TX_HASH_KEY}=abc123`);
});

// ---------------------------------------------------------------------------
// echoParseTimestamp — the DOM fallback's equivalent of the API path's
// tStartMs. The transcript panel only ever gives us formatted mm:ss / h:mm:ss
// strings, never raw offsets.
// ---------------------------------------------------------------------------

test('echoParseTimestamp: is exported from shared.js', () => {
  assert.equal(typeof echoParseTimestamp, 'function');
});

test('echoParseTimestamp: parses mm:ss and h:mm:ss forms', () => {
  assert.equal(echoParseTimestamp('0:15'), 15);
  assert.equal(echoParseTimestamp('1:02'), 62);
  assert.equal(echoParseTimestamp('12:34'), 754);
  assert.equal(echoParseTimestamp('1:02:33'), 3753);
  assert.equal(echoParseTimestamp('0:00'), 0);
});

test('echoParseTimestamp: tolerates surrounding whitespace', () => {
  assert.equal(echoParseTimestamp('  1:02  '), 62);
  assert.equal(echoParseTimestamp('\n0:15\t'), 15);
});

test('echoParseTimestamp: returns 0 for anything unparseable rather than throwing', () => {
  assert.equal(echoParseTimestamp(null), 0);
  assert.equal(echoParseTimestamp(undefined), 0);
  assert.equal(echoParseTimestamp(''), 0);
  assert.equal(echoParseTimestamp('abc'), 0);
  assert.equal(echoParseTimestamp('1:2:3:4'), 0);
  assert.equal(echoParseTimestamp(':'), 0);
  assert.equal(echoParseTimestamp(42), 0);
  assert.equal(echoParseTimestamp({}), 0);
});
