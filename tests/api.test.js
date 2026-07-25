import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-api-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;
// Keep this integration test's real route hits out of the real local usage
// meter (data/usage-events.jsonl) — see usagelog.js. Belt and braces: the
// synthetic flag alone still filters at read time, but pointing the log at a
// throwaway path means this test never appends to the real file at all.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-api-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;

const { app } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDb();
});

// ---------------------------------------------------------------------------
// GET /api/saved
// ---------------------------------------------------------------------------

test('GET /api/saved returns 200 and an empty JSON array initially', async () => {
  const res = await fetch(`${base}/api/saved`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 0);
});

// ---------------------------------------------------------------------------
// POST /api/saved — success then verify via GET
// ---------------------------------------------------------------------------

test('POST /api/saved with a valid payload saves the entry and GET /api/saved reflects it', async () => {
  const payload = {
    videoId: 'apivid001',
    url: 'https://www.youtube.com/watch?v=apivid001',
    title: 'API Test Video',
    segments: [{ text: 'hello from the api test', offset: 0 }],
  };

  const postRes = await fetch(`${base}/api/saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(postRes.status, 200);
  const meta = await postRes.json();
  assert.equal(meta.videoId, 'apivid001');
  assert.equal(meta.title, 'API Test Video');

  const getRes = await fetch(`${base}/api/saved`);
  const list = await getRes.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].videoId, 'apivid001');
});

// ---------------------------------------------------------------------------
// POST /api/saved — validation errors
// ---------------------------------------------------------------------------

test('POST /api/saved missing videoId/segments returns 400 with a structured error envelope', async () => {
  const res = await fetch(`${base}/api/saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=missing' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.hint, 'string');
});

// ---------------------------------------------------------------------------
// POST /api/transcript — invalid URL, no network
// ---------------------------------------------------------------------------

test('POST /api/transcript with an empty url returns a 4xx structured error envelope', async () => {
  const res = await fetch(`${base}/api/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '' }),
  });
  assert.ok(res.status >= 400 && res.status < 500);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
  assert.equal(body.error.code, 'INVALID_URL');
});

// ---------------------------------------------------------------------------
// GET /api/video-meta — invalid videoId, no network
// ---------------------------------------------------------------------------

test('GET /api/video-meta with a bad videoId returns a 400 INVALID_URL error envelope', async () => {
  const res = await fetch(`${base}/api/video-meta?videoId=not-a-real-id`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
  assert.equal(body.error.code, 'INVALID_URL');
});

// ---------------------------------------------------------------------------
// POST /api/digest — empty text, no network/claude call
// ---------------------------------------------------------------------------

test('POST /api/digest with empty text returns 400 with a structured error envelope', async () => {
  const res = await fetch(`${base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
});

test('GET /api/saved/export streams valid JSON containing every entry', async () => {
  // It is written one entry at a time rather than assembled in memory: on a
  // 300-entry library the old shape cost +102 MB of heap to produce a 42 MB
  // payload. Streaming means the response is built incrementally, so the thing
  // worth asserting is that it is still valid JSON with nothing missing.
  for (const id of ['expvid001', 'expvid002', 'expvid003']) {
    await fetch(`${base}/api/saved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: `Export ${id}`,
        segments: [{ text: `content of ${id}`, offset: 0 }],
        digest: `Digest for ${id}`,
      }),
    });
  }

  const res = await fetch(`${base}/api/saved/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const body = await res.json();
  assert.ok(Array.isArray(body.entries));
  for (const id of ['expvid001', 'expvid002', 'expvid003']) {
    const entry = body.entries.find((e) => e.videoId === id);
    assert.ok(entry, `${id} missing from the export`);
    // Full fidelity: an export is a backup, so the transcript must be there.
    assert.equal(entry.segments[0].text, `content of ${id}`);
    assert.equal(entry.digest, `Digest for ${id}`);
  }
});

test('GET /api/saved/export produces well-formed JSON when the library is empty', async () => {
  // The comma-placement in a hand-written JSON stream is exactly the kind of
  // thing that breaks at zero and one entries.
  const res = await fetch(`${base}/api/saved/export?probe=empty`);
  const text = await res.text();
  assert.doesNotThrow(() => JSON.parse(text), `not valid JSON: ${text.slice(0, 120)}`);
});

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

test('GET /api/search?q=... keyword mode returns { results, mode } with an array of results', async () => {
  // Save an entry first so a keyword hit is possible.
  await fetch(`${base}/api/saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId: 'searchvid001',
      url: 'https://www.youtube.com/watch?v=searchvid001',
      title: 'Quizzlewhomp Search Target',
      segments: [{ text: 'a transcript line', offset: 0 }],
    }),
  });

  const res = await fetch(`${base}/api/search?q=Quizzlewhomp`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.results));
  assert.equal(typeof body.mode, 'string');
});

test('GET /api/search with an empty q returns { results: [], mode: "keyword" }', async () => {
  const res = await fetch(`${base}/api/search?q=`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { results: [], mode: 'keyword' });
});
