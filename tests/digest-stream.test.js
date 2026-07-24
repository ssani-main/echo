import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Digest streaming, end to end over a fake CLI.
//
// The real `claude` binary cannot be driven from a test — it needs auth, it
// costs money, and per CLAUDE.md a CLI spawned from inside a Claude Code
// session behaves differently from one a user's `node server.js` spawns. So
// this puts a fake `claude` on PATH that emits the exact stream-json shape the
// real one does (captured from a live run) and drives the whole path through
// it: spawn → NDJSON parse → generateDigest → SSE frames → final payload.
//
// The fake deliberately writes its output in awkward pieces, splitting JSON
// objects across writes. Line reassembly across chunk boundaries is the part
// of this that fails intermittently and only under load if it is wrong, which
// is the worst possible way to find out.
//
// POSIX only: the Windows spawn path goes through cmd.exe and would need a
// .cmd shim, and the CI that matters here is Linux.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

const BIN_DIR = mkdtempSync(join(tmpdir(), 'echo-fake-claude-'));
const DB = join(tmpdir(), `echo-test-stream-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

/**
 * Install a fake `claude` that prints `lines` (already-serialised NDJSON),
 * broken into `pieces` writes regardless of where the line breaks fall.
 */
function installFakeClaude({ lines, exitCode = 0, stderr = '' }) {
  const payload = lines.join('\n') + '\n';
  const script = `#!/usr/bin/env node
const out = ${JSON.stringify(payload)};
// Write in 7-byte slices so JSON objects are split across chunks.
let i = 0;
(function write() {
  if (i >= out.length) {
    if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
    process.exit(${exitCode});
  }
  process.stdout.write(out.slice(i, i + 7));
  i += 7;
  setTimeout(write, 0);
})();
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
  total_cost_usd: 0.0123,
  usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});

// Noise the real CLI emits and the parser must ignore.
const NOISE = [
  JSON.stringify({ type: 'active_goal', value: null }),
  JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
];

const originalPath = process.env.PATH;
process.env.PATH = `${BIN_DIR}:${originalPath}`;

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

/** POST a digest request and collect the SSE frames it produces. */
async function collectStream(body = {}) {
  const res = await fetch(`${base}/api/digest?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'a transcript about aqueducts', ...body }),
  });

  const frames = [];
  const text = await res.text();
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let name = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) frames.push({ name, data: JSON.parse(data.join('\n')) });
  }
  return { res, frames };
}

// ---------------------------------------------------------------------------

test('the streaming route emits tokens and then the final payload', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  installFakeClaude({
    lines: [...NOISE, delta('## TL;DR\n\n'), delta('Aqueducts '), delta('moved water.'), resultLine('## TL;DR\n\nAqueducts moved water.')],
  });

  const { res, frames } = await collectStream();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const tokens = frames.filter((f) => f.name === 'token').map((f) => f.data.text);
  assert.deepEqual(tokens, ['## TL;DR\n\n', 'Aqueducts ', 'moved water.'],
    'every delta should reach the client, in order, unsplit');

  const done = frames.find((f) => f.name === 'done');
  assert.ok(done, 'the stream must finish with a done event');
  assert.equal(done.data.digest, '## TL;DR\n\nAqueducts moved water.');
  assert.equal(done.data.strategy, 'single');
});

test('the concatenated tokens equal the digest in the done payload', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  // If these ever disagree the reader watches one thing being written and then
  // sees it replaced by another, which reads as a glitch.
  const full = '## TL;DR\n\nRoman engineering, briefly.\n\n## Key Points\n- gravity\n- arches';
  installFakeClaude({
    lines: [...NOISE, ...full.match(/.{1,11}/gs).map(delta), resultLine(full)],
  });

  const { frames } = await collectStream();
  const streamed = frames.filter((f) => f.name === 'token').map((f) => f.data.text).join('');
  const done = frames.find((f) => f.name === 'done');

  assert.equal(streamed, full);
  assert.equal(done.data.digest, full);
});

test('usage and suggested tags still ride along with the stream', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  installFakeClaude({
    lines: [...NOISE, delta('text'), resultLine('text')],
  });

  const { frames } = await collectStream();
  const done = frames.find((f) => f.name === 'done');

  assert.equal(done.data.usage.costUsd, 0.0123);
  assert.equal(done.data.usage.inputTokens, 100);
  assert.equal(done.data.usage.outputTokens, 42);
  assert.ok(Array.isArray(done.data.suggestedTags), 'tagging runs alongside and must not be dropped');
});

test('a CLI failure arrives as an error event, not a dead stream', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  // The response is already a 200 by the time this happens, so the failure has
  // to be a message. Silence here would leave a spinner running forever.
  installFakeClaude({ lines: [], exitCode: 1, stderr: 'Invalid API key · Please run /login' });

  const { res, frames } = await collectStream();

  assert.equal(res.status, 200, 'an SSE response is committed before the failure is known');
  const error = frames.find((f) => f.name === 'error');
  assert.ok(error, 'a failure must be reported as an error event');
  assert.equal(error.data.error.code, 'CLAUDE_NOT_AUTHED');
  assert.match(error.data.error.hint, /login/i);
  assert.ok(!frames.some((f) => f.name === 'done'), 'a failed run must not also report done');
});

test('a generic CLI error keeps its detail for the disclosure', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  installFakeClaude({ lines: [], exitCode: 2, stderr: 'something went sideways in the model call' });

  const { frames } = await collectStream();
  const error = frames.find((f) => f.name === 'error');

  assert.equal(error.data.error.code, 'CLAUDE_FAILED');
  assert.match(error.data.error.detail, /sideways/);
});

test('a stream with no result line falls back to the text already shown', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  // Blanking a digest the reader watched being written would be worse than
  // keeping it, so partial text wins over an error here.
  installFakeClaude({ lines: [...NOISE, delta('partial but real content')] });

  const { frames } = await collectStream();
  const done = frames.find((f) => f.name === 'done');

  assert.ok(done, 'should still complete');
  assert.equal(done.data.digest, 'partial but real content');
});

test('no result line and no text at all is a genuine error', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  installFakeClaude({ lines: [...NOISE] });

  const { frames } = await collectStream();
  assert.ok(frames.find((f) => f.name === 'error'), 'nothing produced means nothing to show');
});

test('without ?stream=1 the route still answers with plain JSON', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  // The Obsidian plugin and anything else built against this route must not
  // suddenly start receiving an event stream.
  //
  // The buffered path passes --output-format json, so the CLI answers with one
  // JSON object rather than NDJSON. The fake matches that, which is also a
  // check that the two paths really do ask for different formats.
  installFakeClaude({ lines: [resultLine('## TL;DR\n\nBuffered.')] });

  const res = await fetch(`${base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'a transcript' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal(body.digest, '## TL;DR\n\nBuffered.');
});

test('a request with no transcript is still rejected before streaming starts', { skip: isWindows && 'POSIX spawn path only' }, async () => {
  const res = await fetch(`${base}/api/digest?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });

  assert.equal(res.status, 400, 'validation happens before the stream is opened');
  const body = await res.json();
  assert.ok(body.error);
});
