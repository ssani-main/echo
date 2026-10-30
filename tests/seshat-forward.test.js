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
let seenBytes = null;
let seenRequestId = null;
const aborted = [];
let onAbort = () => {};
let releaseStream = () => {};
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/internal/abort') {
    aborted.push({ id: req.headers['x-echo-request'], secret: req.headers['x-echo-forward'] });
    res.writeHead(204).end();
    onAbort();
    return;
  }
  seenBytes = Buffer.concat(chunks);
  seenRequestId = req.headers['x-echo-request'];
  seen = { url: req.url, secret: req.headers['x-echo-forward'] };
  if (req.method === 'POST') seen.body = seenBytes.toString();
  if (service.hang) return; // never answers: the client gives up first
  if (service.stream) {
    res.writeHead(200, { 'x-served-by': 'seshat', 'x-echo-mode': service.mode, 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    await new Promise((r) => { releaseStream = r; });
    res.end('data: two\n\n');
    return;
  }
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
// Open connections too: a failing stream or cancel test leaves one, which would keep the run from ending.
after(() => { releaseStream(); server.closeAllConnections(); server.close(); fake.closeAllConnections(); fake.close(); });

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

test('every transcript is forwarded, with Whisper or without', async () => {
  service = { mode: 'local', status: 200, body: '{"from":"service"}' };
  const post = (body) => fetch(`${base}/api/transcript`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ url: 'nope', transcribe: 'off' }, { url: 'nope' }, { url: 'nope', transcribe: 'always' }]) {
    const res = await post(body);
    assert.equal(res.headers.get('x-served-by'), 'seshat', JSON.stringify(body));
    assert.equal(await res.text(), '{"from":"service"}');
  }
});

test('an upload is forwarded as its raw bytes', async () => {
  service = { mode: 'local', status: 200, body: '{"from":"service"}' };
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const res = await fetch(`${base}/api/transcript/file?name=a.mp3`, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: bytes });
  assert.equal(res.headers.get('x-served-by'), 'seshat');
  assert.equal(seen.url, '/api/transcript/file?name=a.mp3');
  assert.deepEqual(seenBytes, bytes);
});

test('server-sent events are passed on as they come, not when the stream ends', { timeout: 5000 }, async () => {
  service = { mode: 'local', stream: true };
  const res = await fetch(`${base}/api/transcript/progress?jobId=j1`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = await reader.read(); // the service holds the second event until released
  assert.equal(Buffer.from(first.value).toString(), 'data: one\n\n');
  releaseStream();
  let rest = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += Buffer.from(r.value).toString();
  assert.equal(rest, 'data: two\n\n');
});

test('a client that leaves cancels its request on the service, by the id it was forwarded with', { timeout: 5000 }, async () => {
  service = { mode: 'local', hang: true };
  seen = null;
  const told = new Promise((r) => { onAbort = r; });
  const ac = new AbortController();
  const pending = fetch(`${base}/api/transcript`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"GRzaq5AHiV8"}', signal: ac.signal }).catch(() => 'aborted');
  while (!seen) await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  assert.equal(await pending, 'aborted');
  await told;
  assert.deepEqual(aborted, [{ id: seenRequestId, secret: SECRET }]);
  assert.match(seenRequestId, /^[0-9a-f-]{36}$/);
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
