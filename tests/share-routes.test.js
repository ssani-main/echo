import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-share-routes-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const { app } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupDb();
});

// ---------------------------------------------------------------------------
// POST /api/share -> GET /s/:id -> DELETE /api/share/:id -> GET /s/:id (404)
// ---------------------------------------------------------------------------

test('POST /api/share with a digest returns 200 {id, path}; GET /s/:id serves the digest; DELETE removes it', async () => {
  const postRes = await fetch(`${base}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId: 'share-route-vid',
      title: 'Shared Route Test',
      sourceUrl: 'https://www.youtube.com/watch?v=share-route-vid',
      digestMd: 'This is the shareable digest body.',
    }),
  });
  assert.equal(postRes.status, 200);
  const created = await postRes.json();
  assert.equal(typeof created.id, 'string');
  assert.ok(created.id.length > 0);
  assert.equal(created.path, `/s/${created.id}`);

  const getRes = await fetch(`${base}${created.path}`);
  assert.equal(getRes.status, 200);
  const html = await getRes.text();
  assert.match(html, /^<!doctype html/i);
  assert.ok(html.includes('This is the shareable digest body.'));

  const delRes = await fetch(`${base}/api/share/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.deepEqual(delBody, { ok: true });

  const getAfterDelete = await fetch(`${base}${created.path}`);
  assert.equal(getAfterDelete.status, 404);
});

// ---------------------------------------------------------------------------
// GET /s/:id — bogus id
// ---------------------------------------------------------------------------

test('GET /s/:id with a bogus id returns 404 HTML', async () => {
  const res = await fetch(`${base}/s/this-id-does-not-exist`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.ok(html.includes('404'));
});

// ---------------------------------------------------------------------------
// DELETE /api/share/:id — missing id
// ---------------------------------------------------------------------------

test('DELETE /api/share/:id with a missing id returns a 404 structured error envelope', async () => {
  const res = await fetch(`${base}/api/share/this-id-does-not-exist`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
});

// ---------------------------------------------------------------------------
// POST /api/share — validation
// ---------------------------------------------------------------------------

test('POST /api/share with no digestMd returns a 4xx structured error envelope', async () => {
  const res = await fetch(`${base}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'No digest here' }),
  });
  assert.ok(res.status >= 400 && res.status < 500);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
});

// ---------------------------------------------------------------------------
// POST /api/claims — validation only (no provider/network call)
// ---------------------------------------------------------------------------

test('POST /api/claims with no digest returns a 400 structured error envelope ("No digest provided.")', async () => {
  const res = await fetch(`${base}/api/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'No digest field' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
  assert.match(body.error.message, /No digest provided/);
});
