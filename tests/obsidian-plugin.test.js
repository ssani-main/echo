import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The Obsidian plugin, loaded and driven for real.
//
// The plugin cannot be run inside Obsidian from a test suite, but almost none
// of what can break is Obsidian-specific: it is HTTP handling, error-envelope
// handling, note construction and vault paths. So main.js is loaded with
// `require('obsidian')` redirected to a stub, pointed at a stand-in Echo, and
// actually run — the same code path a user triggers from the command palette.
//
// What this does NOT cover: whether Obsidian's real API behaves like the stub,
// and anything visual. Those need the plugin installed in a vault.
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'obsidian-plugin');
const STUB_PATH = join(PLUGIN_DIR, 'test', 'obsidian-stub.cjs');

// Redirect the bare 'obsidian' specifier to the stub before main.js is loaded.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return STUB_PATH;
  return originalResolve.call(this, request, ...rest);
};

const obsidian = require_(STUB_PATH);
const EchoPlugin = require_(join(PLUGIN_DIR, 'main.js'));
const lib = require_(join(PLUGIN_DIR, 'lib.js'));

// --- A stand-in Echo -------------------------------------------------------

const SEGMENTS = [
  { text: 'A kebab in Berlin went from 3.50 euros in 2019', offset: 0 },
  { text: 'to 9 euros by 2024, which is about 157 percent.', offset: 5 },
];

let failNext = null; // when set, the next API call returns this error envelope

const echo = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = req.url.split('?')[0];

  if (failNext) {
    const envelope = failNext;
    failNext = null;
    return send(503, { error: envelope });
  }

  if (url === '/api/health') return send(200, { status: 'ok', mode: 'local' });

  if (url === '/api/transcript') {
    return send(200, {
      videoId: 'GRzaq5AHiV8',
      url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8',
      title: 'Why everything costs more',
      channel: 'Some Channel',
      channelUrl: 'https://www.youtube.com/@some',
      segments: SEGMENTS,
      langCode: 'en',
      transcriptSource: 'captions',
    });
  }

  if (url === '/api/digest') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      echo.lastDigestRequest = parsed;
      send(200, {
        digest: '## TL;DR\n\nA kebab went from 3.50 euros to 9 euros.\n\n## Detail\n\nThat is about 157 percent over five years.',
        usage: { costUsd: 0.01 },
        strategy: 'single',
        suggestedTags: ['inflation', 'berlin'],
      });
    });
  }

  send(404, { error: { code: 'INTERNAL', message: 'no route' } });
});

let base;
test('starts a stand-in Echo server', async () => {
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${echo.address().port}`;
  assert.ok(base);
});

/** Fresh plugin instance wired to the stand-in server. */
async function makePlugin(overrides = {}) {
  const app = obsidian.__test.makeApp();
  const plugin = new EchoPlugin(app);
  plugin.app = app;
  await plugin.loadSettings();
  Object.assign(plugin.settings, { server: base, folder: 'Echo' }, overrides);
  return { plugin, app };
}

// --- The happy path --------------------------------------------------------

test('reading a video writes a note with frontmatter, digest and transcript', async () => {
  const { plugin, app } = await makePlugin();
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');

  const paths = [...app.vault.files.keys()];
  assert.equal(paths.length, 1, `expected one note, got ${paths}`);
  assert.equal(paths[0], 'Echo/why-everything-costs-more-GRzaq5AHiV8.md');

  const note = app.vault.files.get(paths[0]).contents;
  assert.match(note, /^---\n/);
  assert.match(note, /title: "Why everything costs more"/);
  assert.match(note, /videoId: "GRzaq5AHiV8"/);
  assert.match(note, /channel: "Some Channel"/);
  assert.match(note, /tags: \["inflation", "berlin"\]/);
  assert.match(note, /summary: "A kebab went from 3\.50 euros to 9 euros\."/);
  assert.match(note, /# Why everything costs more/);
  assert.match(note, /## Digest/);
  assert.match(note, /## Transcript/);
  assert.match(note, /3\.50 euros in 2019/);
});

test('the target folder is created when the vault does not have it', async () => {
  const { plugin, app } = await makePlugin({ folder: 'Reading/Videos' });
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.ok(app.vault.folders.has('Reading/Videos'), `folders: ${[...app.vault.folders]}`);
  assert.ok(app.vault.files.has('Reading/Videos/why-everything-costs-more-GRzaq5AHiV8.md'));
});

test('re-reading the same video updates its note instead of duplicating it', async () => {
  const { plugin, app } = await makePlugin();
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.equal(app.vault.files.size, 1, 'a second read must not create a second note');
});

test('the transcript can be left out for shorter notes', async () => {
  const { plugin, app } = await makePlugin({ includeTranscript: false });
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  const note = [...app.vault.files.values()][0].contents;
  assert.doesNotMatch(note, /## Transcript/);
  assert.match(note, /## Digest/, 'the digest must survive');
});

test('the fidelity setting reaches the API as format + length', async () => {
  const { plugin } = await makePlugin({ fidelity: 'article' });
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.equal(echo.lastDigestRequest.format, 'article');
  assert.equal(echo.lastDigestRequest.length, 'detailed');

  const gist = await makePlugin({ fidelity: 'bullets' });
  await gist.plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.equal(echo.lastDigestRequest.format, 'bullets');
  assert.equal(echo.lastDigestRequest.length, 'short', 'Gist is the short end of the dial');
});

test('the note opens after creation when that setting is on', async () => {
  const { plugin, app } = await makePlugin({ openAfterCreate: true });
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.equal(app.workspace.opened.length, 1);
});

// --- Failure paths ---------------------------------------------------------

test("Echo's structured error, hint included, is surfaced to the user", async () => {
  // The hint is the useful half ("Open Settings → Transcription and download a
  // model"), so losing it would leave a user with a dead end.
  failNext = {
    code: 'WHISPER_MODEL_MISSING',
    message: 'No Whisper model downloaded yet.',
    hint: 'Open Settings → Transcription and download a model.',
  };
  obsidian.Notice.log.length = 0;

  const { plugin, app } = await makePlugin();
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');

  const shown = obsidian.Notice.log.join(' | ');
  assert.match(shown, /No Whisper model downloaded yet/);
  assert.match(shown, /Open Settings/, 'the hint must survive to the user');
  assert.equal(app.vault.files.size, 0, 'a failed read must not leave a note behind');
});

test('a non-YouTube URL is refused before any request is made', async () => {
  obsidian.Notice.log.length = 0;
  const { plugin, app } = await makePlugin();
  await plugin.readVideo('https://example.com/not-a-video');
  assert.match(obsidian.Notice.log.join(' '), /doesn't look like a YouTube link/i);
  assert.equal(app.vault.files.size, 0);
});

test('a server address that is not http(s) is refused', async () => {
  // The address goes into a request URL; a host check would not catch
  // javascript:, since new URL('javascript:x').host is ''.
  obsidian.Notice.log.length = 0;
  const { plugin, app } = await makePlugin({ server: 'javascript:alert(1)' });
  await plugin.readVideo('https://www.youtube.com/watch?v=GRzaq5AHiV8');
  assert.match(obsidian.Notice.log.join(' '), /valid Echo server/i);
  assert.equal(app.vault.files.size, 0);
});

// --- Note format parity with the server ------------------------------------

test('buildNote matches the shape markdown.js writes, so both paths agree', async () => {
  // A vault fed by BOTH the plugin and /api/vault/sync must not end up with two
  // different note formats for the same kind of thing.
  const { entryToMarkdown } = await import('../markdown.js');
  const entry = {
    videoId: 'GRzaq5AHiV8',
    url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8',
    title: 'Why everything costs more',
    digest: '## TL;DR\n\nA kebab went from 3.50 euros to 9 euros.',
    segments: SEGMENTS,
    tags: ['inflation'],
    savedAt: '2026-07-24T00:00:00.000Z',
  };

  const server = entryToMarkdown(entry, { includeTranscript: true });
  const plugin = lib.buildNote(entry, { includeTranscript: true });

  for (const marker of ['# Why everything costs more', '**Source:**', '## Digest', '## Transcript', 'summary: "']) {
    assert.ok(server.includes(marker), `server note missing ${marker}`);
    assert.ok(plugin.includes(marker), `plugin note missing ${marker}`);
  }
  // Same filename, so the two paths write to one file rather than two.
  assert.match(lib.notePath('Echo', entry.title, entry.videoId), /why-everything-costs-more-GRzaq5AHiV8\.md$/);
});

test('shuts down the stand-in server', async () => {
  Module._resolveFilename = originalResolve;
  await new Promise((r) => echo.close(r));
});
