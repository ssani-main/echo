import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The streaming digest route, end to end, WITHOUT a POSIX spawn path.
//
// tests/digest-stream.test.js already covers this by putting a fake `claude` on
// PATH — which means every one of those 15 tests is skipped on Windows, where the
// CLI spawn path does not exist. The streaming route is the most delicate path in
// the app, so "green on Windows" currently says nothing about it.
//
// `ECHO_DEEPSEEK_BASE_URL` closes that gap. Pointing the DeepSeek provider at a
// loopback mock exercises the same route, the same SSE framing, the same NDJSON/
// SSE line reassembly across chunk boundaries and the same `done` payload — on
// every platform, with no fake binary, no dependency and no network.
//
// It also guards the thing that makes a ceiling visible: a stream that stops at
// the provider's output limit must still deliver `done` (with `truncated`), not
// an `error`, because the text that arrived is real and the caller has already
// watched it being written.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

// Distinct from every other fixed port in this suite (8901-8906, 8917).
const MOCK_PORT = 8931;
const ECHO_PORT = 8932;

const DIGEST_TEXT = '## TL;DR\n\nThe point, stated plainly.';

/** Response the mock should signal on the finish reason. */
let finishReason = 'stop';
/** Requests the mock has served, for assertions about what was actually sent. */
let seenRequests = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A minimal OpenAI-compatible endpoint: one chat-completions route that answers
 * either buffered or as an event stream, plus the strict-JSON tagging sibling
 * that runs concurrently with the digest.
 */
function startMock() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* leave empty */ }
      const prompt = (parsed.messages || []).map((m) => m.content).join('\n');
      seenRequests.push({ url: req.url, model: parsed.model, auth: req.headers.authorization, stream: !!parsed.stream, prompt });

      // suggestTags() runs concurrently with the digest and wants strict JSON.
      if (/STRICT JSON/.test(prompt)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"tags":["one","two"]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: DIGEST_TEXT }, finish_reason: finishReason }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      // Deliberately small writes, so the test proves the client-side of the
      // route reassembles frames rather than getting one convenient blob.
      for (const piece of (DIGEST_TEXT.match(/.{1,9}/gs) || [])) {
        frame({ choices: [{ delta: { content: piece } }] });
      }
      frame({ choices: [{ delta: {}, finish_reason: finishReason }] });
      frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

function bootServer(dbDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        ECHO_MODE: 'local',
        ECHO_HOST: '127.0.0.1',
        PORT: String(ECHO_PORT),
        ECHO_DB_PATH: join(dbDir, 'library.db'),
        // Keep this out of the real usage meter.
        ECHO_USAGE_SYNTHETIC: '1',
        ECHO_USAGE_LOG_PATH: join(dbDir, 'usage.jsonl'),
        // The provider under test, pointed at the mock. The key is a literal
        // string that never leaves loopback.
        ECHO_PROVIDER: 'deepseek',
        ECHO_DEEPSEEK_API_KEY: 'test-key-not-real',
        ECHO_DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let out = '';
    let err = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`server did not start.\nstdout: ${out}\nstderr: ${err}`));
    }, 15_000);

    proc.stdout.on('data', (c) => {
      out += c.toString();
      if (!settled && /Listening on/.test(out)) {
        settled = true;
        clearTimeout(timeout);
        resolve({ proc, base: `http://127.0.0.1:${ECHO_PORT}` });
      }
    });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timeout); reject(e); } });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`server exited early (${code}).\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

/** Parses Echo's SSE output into [{ name, data }]. */
async function postStreamDigest(base) {
  const res = await fetch(`${base}/api/digest?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: 'a transcript about something', format: 'digest' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const events = [];
  for (const block of (await res.text()).split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (name && data) events.push({ name: name[1], data: JSON.parse(data[1]) });
  }
  return events;
}

const dbDir = mkdtempSync(join(tmpdir(), 'echo-stream-provider-'));
let mock, server;

test('boots the mock provider and an Echo pointed at it', async () => {
  mock = await startMock();
  server = await bootServer(dbDir);
  assert.ok(server.base);
});

test('the streamed digest route works with no POSIX spawn path involved', async () => {
  finishReason = 'stop';
  seenRequests = [];

  const events = await postStreamDigest(server.base);
  const tokens = events.filter((e) => e.name === 'token').map((e) => e.data.text);
  const done = events.find((e) => e.name === 'done');

  assert.ok(!events.some((e) => e.name === 'error'), 'no error event expected');
  assert.ok(done, 'a done event must arrive');
  assert.ok(tokens.length > 1, 'the text must arrive as tokens, not one blob');
  assert.equal(tokens.join(''), done.data.digest, 'the streamed tokens and the final payload must agree');
  assert.equal(done.data.digest, DIGEST_TEXT);
  assert.equal(done.data.truncated, undefined, 'a clean run must not claim truncation');

  // The concurrently-running tagging call must not have been mistaken for the
  // digest, and the digest call must not have gone out as a non-streaming one.
  const digestCalls = seenRequests.filter((r) => !/STRICT JSON/.test(r.prompt));
  assert.ok(digestCalls.some((r) => r.stream === true), 'the digest call must request a stream');
  assert.ok(seenRequests.some((r) => /STRICT JSON/.test(r.prompt)), 'tags are requested in parallel');
  assert.ok(done.data.suggestedTags.includes('one'), 'tag suggestions reach the done payload');
});

test('the provider is named and its key is used, not the CLI', async () => {
  const digestCall = seenRequests.filter((r) => !/STRICT JSON/.test(r.prompt))[0];
  assert.match(digestCall.url, /\/chat\/completions$/, 'must call the OpenAI-compatible route');
  assert.equal(digestCall.auth, 'Bearer test-key-not-real');
  assert.ok(digestCall.model, 'a model id must be sent');
});

test('a stream that stops at the output ceiling still ends in done, flagged', async () => {
  finishReason = 'length';

  const events = await postStreamDigest(server.base);
  const done = events.find((e) => e.name === 'done');

  // The single most important assertion in this file. Streaming already put the
  // text on the user's screen; turning a ceiling into an error event would blank
  // work they watched being written, and reporting it as a clean success — which
  // is what used to happen — would file a half-digest as a finished one.
  assert.ok(!events.some((e) => e.name === 'error'), 'truncation must not be an error event');
  assert.ok(done, 'done must still arrive');
  assert.equal(done.data.truncated, true, 'the ceiling must be reported');
  assert.match(String(done.data.truncationNote), /DeepSeek/, 'the notice names the provider');
  assert.equal(done.data.digest, DIGEST_TEXT, 'the partial text must survive');

  finishReason = 'stop';
});

test('closes the mock and the server', async () => {
  if (server) {
    const exited = new Promise((r) => server.proc.once('exit', r));
    server.proc.kill();
    await exited;
  }
  if (mock) await new Promise((r) => mock.close(r));
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ }
  await sleep(50);
});
