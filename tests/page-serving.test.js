import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Two guards on how server.js serves the app shell and the Whisper progress
// stream:
//
//   1. GET / is pre-gzipped once at boot and served with Content-Encoding when
//      (and only when) the client actually accepts gzip. The page is a ~316 KB
//      inline monolith, so shipping it uncompressed is a 4x cost on every visit.
//   2. GET /api/transcript/progress bounds how many streams can be open at
//      once. Each one holds a socket and a repeating timer, and nothing about
//      the route requires a stream to ever be closed by its client.
//
// These use raw node:http rather than fetch() because fetch transparently
// negotiates and decompresses gzip, which is exactly the behaviour under test.
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-page-serving-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const { app } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;

const agent = new http.Agent({ maxSockets: 64 });

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(async () => {
  agent.destroy();
  await new Promise((resolve) => server.close(resolve));
  cleanupDb();
});

/**
 * Raw GET that returns the undecoded body buffer plus headers, so a
 * Content-Encoding can be observed rather than silently unwrapped.
 */
function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// GET / — compression
// ---------------------------------------------------------------------------

test('GET / serves gzip when the client accepts it, and it decompresses to the page', async () => {
  const res = await rawGet('/', { 'Accept-Encoding': 'gzip' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(res.headers['content-type'], /text\/html/);

  const html = gunzipSync(res.body).toString('utf8');
  assert.match(html, /<!doctype html>/i);
  // The page now pulls its script and CSS from real files, which is what lets
  // the CSP refuse inline script.
  assert.match(html, /<script src="\/app\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css"/);
});

test('GET / advertises Vary: Accept-Encoding so caches keep the two representations apart', async () => {
  const res = await rawGet('/', { 'Accept-Encoding': 'gzip' });
  assert.match(String(res.headers.vary || ''), /accept-encoding/i);
});

test('GET / gzipped is dramatically smaller than the raw page', async () => {
  const gzipped = await rawGet('/', { 'Accept-Encoding': 'gzip' });
  const plain = await rawGet('/', { 'Accept-Encoding': 'identity' });

  assert.ok(
    gzipped.body.length < plain.body.length / 2,
    `expected gzip to at least halve the page, got ${gzipped.body.length} vs ${plain.body.length} bytes`
  );
  // Content-Length must describe the encoded body, not the original.
  assert.equal(Number(gzipped.headers['content-length']), gzipped.body.length);
});

test('GET / serves plain HTML when the client does not accept gzip', async () => {
  const res = await rawGet('/', { 'Accept-Encoding': 'identity' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.match(res.body.toString('utf8'), /<!doctype html>/i);
});

test('GET / treats "gzip;q=0" as a refusal, not as support', async () => {
  // A naive substring check for "gzip" reads q=0 as support and then serves an
  // encoding the client explicitly rejected.
  const res = await rawGet('/', { 'Accept-Encoding': 'gzip;q=0, identity' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.match(res.body.toString('utf8'), /<!doctype html>/i);
});

test('GET / still serves the page when no Accept-Encoding is sent at all', async () => {
  const res = await rawGet('/', { 'Accept-Encoding': '' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.match(res.body.toString('utf8'), /<!doctype html>/i);
});

// ---------------------------------------------------------------------------
// The split assets
// ---------------------------------------------------------------------------

test('app.css, app.js and the boot scripts are served, gzipped, with the right types', async () => {
  // These are served from memory and compressed at boot, exactly like the page.
  // If they ever fall through to express.static instead they would still work —
  // just uncompressed — which is the kind of regression nobody notices.
  for (const [path, type] of [
    ['/app.css', /text\/css/],
    ['/app.js', /javascript/],
    ['/theme-init.js', /javascript/],
    ['/echo-config.js', /javascript/],
  ]) {
    const res = await rawGet(path, { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-encoding'], 'gzip', `${path} must be compressed`);
    assert.match(String(res.headers.vary || ''), /accept-encoding/i, path);
  }
});

test('the page carries no inline script, which is what lets the CSP refuse it', async () => {
  const html = gunzipSync((await rawGet('/', { 'Accept-Encoding': 'gzip' })).body).toString('utf8');

  // Every <script> must have a src. An inline one would be silently blocked by
  // the CSP at runtime — a failure that only shows up in a browser.
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scripts.length > 0, 'the page should load scripts');
  for (const tag of scripts) {
    assert.match(tag, /\ssrc=/i, `inline <script> found: ${tag}`);
  }
  assert.doesNotMatch(html, /<style[\s>]/i, 'inline <style> should have moved to app.css');
});

test('the CSP no longer allows inline script', async () => {
  const res = await rawGet('/');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(csp.split('script-src')[1].split(';')[0], /unsafe-inline/,
    "script-src must not allow inline any more");
  // The stale Google Fonts allowances went with the Plaintext theme.
  assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('echo-config.js reports the running mode to the page', async () => {
  const res = await rawGet('/echo-config.js', { 'Accept-Encoding': 'identity' });
  assert.match(res.body.toString('utf8'), /window\.__ECHO__=\{"mode":"local"\}/);
});

// ---------------------------------------------------------------------------
// API responses — compression
// ---------------------------------------------------------------------------

/** Raw POST of a JSON body, used to seed a library entry big enough to compress. */
function rawPostJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('seeds a saved entry with a transcript large enough to be worth compressing', async () => {
  const segments = [];
  for (let i = 0; i < 1200; i++) {
    segments.push({ text: `segment ${i} of a fairly long transcript about a repeated subject`, offset: i * 2 });
  }
  const res = await rawPostJson('/api/saved', {
    videoId: 'gzipvid001',
    url: 'https://www.youtube.com/watch?v=gzipvid001',
    title: 'Compression Test Video',
    segments,
  });
  assert.equal(res.status, 200);
});

test('a large JSON response is gzipped and decompresses to the same JSON', async () => {
  const res = await rawGet('/api/saved/gzipvid001', { 'Accept-Encoding': 'gzip' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(String(res.headers.vary || ''), /accept-encoding/i);

  const entry = JSON.parse(gunzipSync(res.body).toString('utf8'));
  assert.equal(entry.videoId, 'gzipvid001');
  assert.equal(entry.segments.length, 1200);

  // Content-Length must describe the compressed body actually written.
  assert.equal(Number(res.headers['content-length']), res.body.length);
});

test('a large JSON response is substantially smaller gzipped than plain', async () => {
  const gzipped = await rawGet('/api/saved/gzipvid001', { 'Accept-Encoding': 'gzip' });
  const plain = await rawGet('/api/saved/gzipvid001', { 'Accept-Encoding': 'identity' });

  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok(
    gzipped.body.length < plain.body.length / 4,
    `expected a large ratio on transcript JSON, got ${gzipped.body.length} vs ${plain.body.length} bytes`
  );
  // Both encodings must carry the same data.
  const fromGzip = JSON.parse(gunzipSync(gzipped.body).toString('utf8'));
  const fromPlain = JSON.parse(plain.body.toString('utf8'));
  assert.deepEqual(fromGzip, fromPlain);
});

test('a small JSON response is left uncompressed', async () => {
  // /api/health is a few dozen bytes — under the threshold, where gzip would
  // cost CPU and two headers to save nothing.
  const res = await rawGet('/api/health', { 'Accept-Encoding': 'gzip' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(res.body.toString('utf8')).status, 'ok');
});

test('a markdown export is gzipped too (it is text, and transcripts are long)', async () => {
  const res = await rawGet('/api/saved/gzipvid001/export.md', { 'Accept-Encoding': 'gzip' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  const md = gunzipSync(res.body).toString('utf8');
  assert.match(md, /# Compression Test Video/);
});

test('an error envelope still arrives intact when the client accepts gzip', async () => {
  const res = await rawGet('/api/saved/no-such-video-id', { 'Accept-Encoding': 'gzip' });

  assert.equal(res.status, 404);
  // Small enough to skip compression — the point is that the envelope parses.
  const raw = res.headers['content-encoding'] === 'gzip' ? gunzipSync(res.body) : res.body;
  assert.ok(JSON.parse(raw.toString('utf8')).error);
});

// ---------------------------------------------------------------------------
// GET /api/transcript/progress — stream guard rails
// ---------------------------------------------------------------------------

test('GET /api/transcript/progress without a jobId is rejected', async () => {
  const res = await rawGet('/api/transcript/progress');
  assert.equal(res.status, 400);
});

/**
 * Opens an SSE stream and leaves it open, resolving once the response headers
 * (or an error status) have arrived. Returns { status, close }.
 */
function openStream(jobId) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: `/api/transcript/progress?jobId=${encodeURIComponent(jobId)}`,
      agent,
    }, (res) => {
      res.resume(); // drain heartbeats; never end the stream from this side
      resolve({ status: res.statusCode, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

test('GET /api/transcript/progress caps how many streams can be open at once', async () => {
  const streams = [];
  try {
    // The cap is 32; opening exactly that many must all succeed.
    for (let i = 0; i < 32; i++) {
      const s = await openStream(`cap-test-${i}`);
      streams.push(s);
      assert.equal(s.status, 200, `stream ${i} should have been accepted`);
    }

    // The next one is refused with the structured rate-limit envelope rather
    // than quietly adding another socket + timer.
    const overflow = await rawGet('/api/transcript/progress?jobId=cap-test-overflow');
    assert.equal(overflow.status, 429);
    const body = JSON.parse(overflow.body.toString('utf8'));
    assert.equal(body.error.code, 'RATE_LIMITED');
  } finally {
    for (const s of streams) s.close();
  }
});

test('closing streams releases the cap again', async () => {
  // Give the server's res 'close' handlers a moment to run after the previous
  // test destroyed its sockets — the count must return to zero, or the cap
  // would leak and permanently wedge the route.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const s = await openStream('cap-released');
  try {
    assert.equal(s.status, 200);
  } finally {
    s.close();
  }
});
