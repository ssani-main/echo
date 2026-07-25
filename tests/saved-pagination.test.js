import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// GET /api/saved paging.
//
// The library list renders a window at a time, so the first paint needs a page
// rather than the whole library — at 500 entries the full payload is 159 KB to
// show about 60 cards. Adding `?limit=` returns { entries, total, hasMore }.
//
// The contract that matters just as much is the one that did NOT change: with
// no `limit`, the route still answers with the bare array it always has. The
// export, the vault sync and the Obsidian plugin all read that shape, and none
// of them wants a page.
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-paging-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;
// Keep this integration test's real route hits out of the real local usage
// meter (data/usage-events.jsonl) — see usagelog.js. Belt and braces: the
// synthetic flag alone still filters at read time, but pointing the log at a
// throwaway path means this test never appends to the real file at all.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-paging-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;

const { app } = await import('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const TOTAL = 25;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
});

test('seeds a library big enough to page through', async () => {
  for (let i = 0; i < TOTAL; i++) {
    const res = await fetch(`${base}/api/saved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: `page${String(i).padStart(7, '0')}`,
        url: `https://www.youtube.com/watch?v=page${String(i).padStart(7, '0')}`,
        title: `Paged video ${i}`,
        segments: [{ text: `transcript ${i}`, offset: 0 }],
      }),
    });
    assert.equal(res.status, 200, `seeding entry ${i}`);
  }
});

test('no limit still returns the bare array, unchanged', async () => {
  const res = await fetch(`${base}/api/saved`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body), 'the unpaged shape must stay an array');
  assert.equal(body.length, TOTAL);
});

test('a limit returns one page plus the true total', async () => {
  const res = await fetch(`${base}/api/saved?limit=10`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.entries.length, 10);
  assert.equal(body.total, TOTAL, 'total counts the library, not the page');
  assert.equal(body.hasMore, true);
});

test('walking the pages yields every entry exactly once, newest first', async () => {
  const seen = [];
  let offset = 0;
  let guard = 0;
  for (;;) {
    assert.ok(++guard < 20, 'page walk failed to terminate');
    const body = await (await fetch(`${base}/api/saved?limit=10&offset=${offset}`)).json();
    seen.push(...body.entries.map((e) => e.videoId));
    if (!body.hasMore) break;
    offset += body.entries.length;
  }

  assert.equal(seen.length, TOTAL, 'the walk must not drop entries');
  assert.equal(new Set(seen).size, TOTAL, 'nor repeat them');

  // Same order the unpaged call uses, or the page would reshuffle mid-scroll.
  const whole = await (await fetch(`${base}/api/saved`)).json();
  assert.deepEqual(seen, whole.map((e) => e.videoId));
});

test('hasMore is false on the last page, and an offset past the end is empty', async () => {
  const last = await (await fetch(`${base}/api/saved?limit=10&offset=20`)).json();
  assert.equal(last.entries.length, 5);
  assert.equal(last.hasMore, false);

  const past = await (await fetch(`${base}/api/saved?limit=10&offset=${TOTAL + 50}`)).json();
  assert.equal(past.entries.length, 0);
  assert.equal(past.hasMore, false, 'an empty page must not ask the client to keep walking');
  assert.equal(past.total, TOTAL);
});

test('a page carries the tags of its own rows', async () => {
  // The unpaged path reads the whole tags table; the paged path reads tags for
  // just the rows it returns. Both have to produce the same entry.
  const target = `page${String(3).padStart(7, '0')}`;
  const res = await fetch(`${base}/api/saved/${target}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['alpha', 'beta'] }),
  });
  assert.equal(res.status, 200);

  const whole = await (await fetch(`${base}/api/saved`)).json();
  const fromWhole = whole.find((e) => e.videoId === target);

  // Page the walk until the tagged entry shows up.
  let fromPage = null;
  for (let offset = 0; offset < TOTAL && !fromPage; offset += 5) {
    const body = await (await fetch(`${base}/api/saved?limit=5&offset=${offset}`)).json();
    fromPage = body.entries.find((e) => e.videoId === target) || null;
  }

  assert.ok(fromPage, 'the tagged entry should appear in some page');
  assert.deepEqual(fromPage.tags, ['alpha', 'beta']);
  assert.deepEqual(fromPage, fromWhole, 'paged and unpaged entries must be identical');
});

test('bad paging parameters are rejected, not silently reinterpreted', async () => {
  for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=10&offset=-5', 'limit=10&offset=abc']) {
    const res = await fetch(`${base}/api/saved?${query}`);
    assert.equal(res.status, 400, `?${query} should be a 400`);
    const body = await res.json();
    assert.ok(body.error && body.error.message, `?${query} should use the error envelope`);
  }
});

test('an absurd limit is capped rather than honoured', async () => {
  const body = await (await fetch(`${base}/api/saved?limit=100000`)).json();
  assert.equal(body.entries.length, TOTAL);
  assert.equal(body.hasMore, false);
});
