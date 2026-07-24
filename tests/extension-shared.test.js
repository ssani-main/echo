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
const { echoExtractVideoId, echoNormalizeServer, echoReadUrl, ECHO_DEFAULT_SERVER } =
  require(join(EXT_DIR, 'shared.js'));

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
