import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server.js forwarding a ported route to the Seshat service (seshat/PORT.md).
// A plain node:http server stands in for the service, so this runs without
// Seshat installed; seshat/PORT.md has the byte comparison against the real one.

const SECRET = 'test-secret-0123456789abcdef0123456789';
let service = { mode: 'local', status: 201, body: '{"from":"service"}' };
let seen = null;
const fake = createServer((req, res) => {
  seen = { url: req.url, secret: req.headers['x-echo-forward'] };
  res.writeHead(service.status, { 'x-served-by': 'seshat', 'x-echo-mode': service.mode, 'content-type': 'application/json; charset=utf-8' });
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

test('a service running in another mode is not trusted: server.js answers itself', async () => {
  service = { mode: 'web', status: 200, body: '{"status":"ok","mode":"web"}' };
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-served-by'), null);
  assert.deepEqual(await res.json(), { status: 'ok', mode: 'local' });
});

test('with the service down, server.js answers itself', async () => {
  await new Promise((r) => fake.close(r));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-served-by'), null);
  assert.deepEqual(await res.json(), { status: 'ok', mode: 'local' });
});
