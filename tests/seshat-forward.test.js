import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server.js forwarding a ported route to the Seshat service (seshat/PORT.md).
// A plain node:http server stands in for the service, so this runs without
// Seshat installed; seshat/PORT.md has the byte comparison against the real one.

const SECRET = 'test-secret-0123456789abcdef0123456789';
let service = { mode: 'local', status: 201, body: '{"from":"service"}' };
let seen = null;
const fake = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  seen = { url: req.url, secret: req.headers['x-echo-forward'] };
  if (req.method === 'POST') seen.body = body;
  const type = service.body ? { 'content-type': 'application/json; charset=utf-8' } : {};
  res.writeHead(service.status, { 'x-served-by': 'seshat', 'x-echo-mode': service.mode, ...type });
  res.end(service.body);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

process.env.ECHO_USAGE_SYNTHETIC = '1';
process.env.ECHO_USAGE_LOG_PATH = join(tmpdir(), `echo-test-seshat-forward-${process.pid}.jsonl`);
process.env.ECHO_SESHAT_URL = fakeUrl + '/';
process.env.ECHO_SESHAT_SECRET = SECRET;
const { app } = await import('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fake.close(); });

test('a ported route answers with the service\'s status, headers and body, sent with the secret', async () => {
  service = { mode: 'local', status: 201, body: '{"from":"service"}' };
  const res = await fetch(`${base}/api/health?x=1`);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-served-by'), 'seshat');
  assert.equal(res.headers.get('x-echo-mode'), null);
  assert.equal(await res.text(), '{"from":"service"}');
  assert.deepEqual(seen, { url: '/api/health?x=1', secret: SECRET });
});

test('the route\'s own path is forwarded: Express matches any case and a trailing slash, the service doesn\'t', async () => {
  service = { mode: 'local', status: 200, body: '{"from":"service"}' };
  await fetch(`${base}/API/Saved/a%20b%2Fc/?limit=1`);
  assert.deepEqual(seen, { url: '/api/saved/a%20b%2Fc?limit=1', secret: SECRET });
});

test('a transcript is forwarded only with Whisper off; otherwise server.js keeps it (Whisper is not ported)', async () => {
  service = { mode: 'local', status: 200, body: '{"from":"service"}' };
  const post = (body) => fetch(`${base}/api/transcript`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const off = await post({ url: 'nope', transcribe: 'off' });
  assert.equal(off.headers.get('x-served-by'), 'seshat');
  assert.equal(await off.text(), '{"from":"service"}');
  for (const body of [{ url: 'nope' }, { url: 'nope', transcribe: 'fallback' }, { url: 'nope', transcribe: 'always' }]) {
    const res = await post(body);
    assert.equal(res.headers.get('x-served-by'), null, JSON.stringify(body));
    assert.equal((await res.json()).error.code, 'INVALID_URL');
  }
});

test('a service running in another mode is not trusted: server.js answers itself', async () => {
  service = { mode: 'web', status: 200, body: '{"status":"ok","mode":"web"}' };
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-served-by'), null);
  assert.deepEqual(await res.json(), { status: 'ok', mode: 'local' });
});

test('a POST is forwarded with its JSON body, even with expect: 100-continue, and a 204 gets no ETag', async () => {
  service = { mode: 'local', status: 204, body: '' };
  // fetch() can't send `expect`; curl does, for bodies over 1 MB, and fetch() refused to forward it.
  const payload = JSON.stringify({ event: 'digest-copy', videoId: 'GRzaq5AHiV8' });
  const res = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json', expect: '100-continue' } }, resolve);
    req.on('continue', () => req.end(payload));
    req.on('error', reject);
  });
  res.resume();
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['x-served-by'], 'seshat');
  assert.equal(res.headers.etag, undefined);
  assert.deepEqual(seen, { url: '/api/event', secret: SECRET, body: payload });
});

test('with the service down, server.js answers itself', async () => {
  await new Promise((r) => fake.close(r));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-served-by'), null);
  assert.deepEqual(await res.json(), { status: 'ok', mode: 'local' });
});
