import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Cancelling a running digest, end to end.
//
// Two layers are covered here:
//   (1) digest.js unit-level — runClaude()/runClaudeStream() directly, with a
//       slow fake `claude` on PATH, proving the spawn is actually killed (not
//       left to finish) and that the rejection is AbortError-shaped rather
//       than CLAUDE_FAILED.
//   (2) HTTP-level — POST /api/digest?stream=1, aborted client-side mid-flight,
//       proving the same kill happens through the whole server route and that
//       the server survives it (a follow-up request still works) and that the
//       non-streaming JSON contract is untouched by the AbortController wiring
//       added to that route.
//
// POSIX only, same reasoning as tests/digest-stream.test.js: the Windows spawn
// path goes through cmd.exe and would need a .cmd shim, and the CI that
// matters here is Linux.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

const BIN_DIR = mkdtempSync(join(tmpdir(), 'echo-fake-claude-cancel-'));
const DB = join(tmpdir(), `echo-test-cancel-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const originalPath = process.env.PATH;
process.env.PATH = `${BIN_DIR}:${originalPath}`;

/**
 * Installs a fake `claude` that:
 *   - writes `startedMarker` the instant it starts (proves it was spawned),
 *   - immediately streams `initialLines` (NDJSON, one per line) so a caller
 *     genuinely sees it mid-flight,
 *   - then sleeps `sleepMs` before writing `finishedMarker` and exiting 0.
 *
 * A caller that aborts during the sleep and then finds `finishedMarker`
 * absent has proof the process was actually killed, not merely abandoned.
 */
function installSlowFakeClaude({ startedMarker, finishedMarker, initialLines = [], sleepMs = 4000 }) {
  const initial = initialLines.length ? initialLines.join('\n') + '\n' : '';
  const script = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');
process.stdout.write(${JSON.stringify(initial)});
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(finishedMarker)}, 'finished');
  process.exit(0);
}, ${sleepMs});
`;
  const path = join(BIN_DIR, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const delta = (text) => JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});

const resultLine = (result, extra = {}) => JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

let markerCount = 0;
function markerPaths() {
  markerCount += 1;
  return {
    started: join(BIN_DIR, `started-${markerCount}.marker`),
    finished: join(BIN_DIR, `finished-${markerCount}.marker`),
  };
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. */
async function waitUntil(predicate, timeoutMs = 2000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

const { runClaude, runClaudeStream } = await import('../digest.js');
const { app } = await import('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  process.env.PATH = originalPath;
  await new Promise((resolve) => server.close(resolve));
  try { rmSync(BIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// digest.js unit level
// ---------------------------------------------------------------------------

test('runClaude rejects immediately with an AbortError when the signal is already aborted, and never spawns anything', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const { started } = markerPaths();
  installSlowFakeClaude({ startedMarker: started, finishedMarker: join(BIN_DIR, 'unused.marker'), sleepMs: 4000 });

  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () => runClaude('a prompt', { signal: ac.signal }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      assert.equal(err.code, 'ABORT_ERR');
      assert.notEqual(err.echoCode, 'CLAUDE_FAILED');
      return true;
    }
  );

  // Give any accidental spawn a moment to have written its marker, then
  // confirm it never did.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(started), false, 'an already-aborted signal must stop the call before spawning');
});

test('runClaude aborted mid-run kills the child tree and rejects with AbortError, not CLAUDE_FAILED', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const { started, finished } = markerPaths();
  installSlowFakeClaude({ startedMarker: started, finishedMarker: finished, sleepMs: 3000 });

  const ac = new AbortController();
  const promise = runClaude('a prompt', { signal: ac.signal });

  assert.ok(await waitUntil(() => existsSync(started)), 'the process must actually start before we abort it');
  ac.abort();

  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'AbortError');
    assert.equal(err.code, 'ABORT_ERR');
    assert.notEqual(err.echoCode, 'CLAUDE_FAILED');
    return true;
  });

  // The fake would write `finished` ~3s after starting if left alone. Confirm
  // it never gets there — proof the process tree was actually killed, not
  // just abandoned by a caller that stopped waiting.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(existsSync(finished), false, 'the process must be killed, not left running to completion');
});

test('runClaudeStream aborted mid-stream (after tokens already arrived) kills the child and rejects with AbortError', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const { started, finished } = markerPaths();
  installSlowFakeClaude({
    startedMarker: started,
    finishedMarker: finished,
    initialLines: [delta('partial '), delta('digest text')],
    sleepMs: 3000,
  });

  const ac = new AbortController();
  const tokens = [];
  const promise = runClaudeStream('a prompt', { signal: ac.signal }, (t) => tokens.push(t));

  assert.ok(await waitUntil(() => tokens.length > 0), 'at least one token must arrive before the abort, proving this was a genuine mid-stream cancel');
  ac.abort();

  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'AbortError');
    assert.equal(err.code, 'ABORT_ERR');
    return true;
  });

  await new Promise((r) => setTimeout(r, 600));
  assert.equal(existsSync(finished), false, 'the process must be killed, not left running to completion');
});

test('a non-aborted signal does not interfere with a normal run', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  // A fast-exiting fake that returns a real result immediately.
  const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(resultLine('ok') + '\n')});\n`;
  const path = join(BIN_DIR, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  const ac = new AbortController();
  const { result } = await runClaude('a prompt', { signal: ac.signal });
  assert.equal(result, 'ok');
});

// ---------------------------------------------------------------------------
// HTTP level — POST /api/digest?stream=1
// ---------------------------------------------------------------------------

test('aborting the client fetch mid-stream kills the underlying claude process', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const { started, finished } = markerPaths();
  installSlowFakeClaude({
    startedMarker: started,
    finishedMarker: finished,
    initialLines: [delta('the first '), delta('few words of a digest')],
    sleepMs: 3000,
  });

  const controller = new AbortController();
  const res = await fetch(`${base}/api/digest?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'a transcript long enough to digest' }),
    signal: controller.signal,
  });

  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  // Read at least one chunk so we know the stream — and the underlying
  // `claude` spawn behind it — genuinely started before we cancel it.
  const { value } = await reader.read();
  assert.ok(value && value.byteLength > 0, 'the client should see streamed bytes before aborting');
  assert.ok(await waitUntil(() => existsSync(started)), 'the server-side claude process must have started');

  controller.abort();

  // Give the server's res 'close' handler + abort propagation a moment, then
  // confirm the fake claude process was actually killed rather than left to
  // finish (which would write `finished` ~3s after it started).
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(existsSync(finished), false, 'the server must kill the child process when the client disconnects');

  // The server itself must not have crashed — prove it with a follow-up
  // request over the same connection pool.
  const followUp = await fetch(`${base}/api/languages?videoId=dQw4w9WgXcQ`);
  assert.ok(followUp.status === 200 || followUp.status === 500 || followUp.status === 502,
    'the server process must still be alive and answering requests after a cancelled digest');
});

test('without ?stream=1 the JSON contract is unaffected by the cancellation wiring', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(resultLine('## TL;DR\n\nStill buffered.') + '\n')});\n`;
  const path = join(BIN_DIR, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  const res = await fetch(`${base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'a transcript' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal(body.digest, '## TL;DR\n\nStill buffered.');
  assert.ok(Array.isArray(body.suggestedTags));
});
