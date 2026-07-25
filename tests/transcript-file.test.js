import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// POST /api/transcript/file — transcribe a media file the user supplies.
//
// The Whisper stage itself cannot run here (no model in CI, no ffmpeg), so
// what these cover is everything around it: validation, the raw-body upload
// path, the synthetic library id, and that a real request travels all the way
// to Whisper resolution and comes back as a structured envelope rather than a
// stack trace. That last one is the load-bearing case — it proves the route
// accepted the bytes, wrote them, and entered the pipeline.
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-file-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;
// Keep this integration test's real route hits out of the real local usage
// meter (data/usage-events.jsonl) — see usagelog.js. Belt and braces: the
// synthetic flag alone still filters at read time, but pointing the log at a
// throwaway path means this test never appends to the real file at all.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-file-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;

const { app, localMediaId } = await import('../server.js');

const server = app.listen(0);
const port = server.address().port;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
});

/** POST raw bytes, the way the browser sends a File object. */
function upload(query, body, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `/api/transcript/file${query}`,
      headers: { 'Content-Type': contentType, 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(buf);
  });
}

test('POST /api/transcript/file with no body returns a structured 400', async () => {
  const res = await upload('?name=empty.mp3', Buffer.alloc(0));
  assert.equal(res.status, 400);
  assert.ok(res.json.error, 'expected an error envelope');
  assert.match(res.json.error.message, /No file/i);
});

test('POST /api/transcript/file rejects a file type ffmpeg has no business decoding', async () => {
  const res = await upload('?name=notes.pdf', Buffer.from('%PDF-1.7 not audio'));
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /Unsupported file type/i);
  // The hint should name what IS accepted, not just what isn't.
  assert.match(res.json.error.hint, /mp3|wav|mp4/i);
});

test('POST /api/transcript/file accepts an extensionless name rather than guessing', async () => {
  // No extension means no extension check — ffmpeg sniffs the container, so
  // refusing here would reject legitimate files (a downloaded podcast with no
  // suffix). It must fail later, in the pipeline, not at the door.
  const res = await upload('?name=recording', Buffer.from('some bytes'));
  assert.notEqual(res.status, 400, 'an extensionless upload must not be rejected as a bad type');
});

test('a valid upload reaches the Whisper stage and reports why it cannot finish', async () => {
  // How far the pipeline gets depends on what the machine has installed, so the
  // assertion is on the *class* of answer, not one code. Bare CI stops at
  // Whisper resolution (no model, no ffmpeg); a developer box with both gets
  // further, and ffmpeg rejects these fake bytes — MEDIA_UNREADABLE. Every one
  // of them proves the upload was accepted, buffered, written and handed to
  // transcribeFile(); what must never appear is a bare INTERNAL, which is what
  // an unclassified error degrades to.
  const res = await upload('?name=lecture.mp3', Buffer.from('fake mp3 bytes for the pipeline'));

  assert.ok(res.json && res.json.error, `expected an error envelope, got: ${res.text.slice(0, 200)}`);
  assert.ok(
    ['WHISPER_MODEL_MISSING', 'WHISPER_MISSING', 'WHISPER_FAILED', 'FFMPEG_MISSING', 'MEDIA_UNREADABLE']
      .includes(res.json.error.code),
    `expected a Whisper-stage error code, got ${res.json.error.code}`
  );
  // Whatever the stage, the user must get a next step rather than a bare failure.
  assert.ok(res.json.error.hint && res.json.error.hint.length > 0, 'error must carry a hint');
});

test('the same file uploaded twice gets the same library id', async () => {
  // The id is what lets a local file live in the same SQLite library as YouTube
  // entries. It has to be stable, or re-uploading duplicates the entry.
  const bytes = Buffer.from('identical content');
  assert.equal(localMediaId('talk.mp3', bytes), localMediaId('talk.mp3', bytes));
  assert.notEqual(localMediaId('talk.mp3', bytes), localMediaId('other.mp3', bytes));
  assert.notEqual(
    localMediaId('talk.mp3', bytes),
    localMediaId('talk.mp3', Buffer.from('different content!'))
  );
  // Must satisfy vault.js's filename guard: ^[A-Za-z0-9_-]{1,20}$
  assert.match(localMediaId('talk.mp3', bytes), /^[A-Za-z0-9_-]{1,20}$/);
});
