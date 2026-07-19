import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Same temp-DB-before-import setup as tests/store.test.js.
const DB = join(tmpdir(), `echo-test-store-transcript-source-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// transcriptSource / whisperModel persistence
// ---------------------------------------------------------------------------

test('saveEntry with transcriptSource+whisperModel round-trips both fields via getEntry', async () => {
  await store.saveEntry({
    videoId: 'whisper-vid-001',
    url: 'https://www.youtube.com/watch?v=whisper-vid-001',
    title: 'Whisper Transcribed Video',
    segments: [{ text: 'transcribed by whisper', offset: 0 }],
    transcriptSource: 'whisper',
    whisperModel: 'base',
  });

  const entry = await store.getEntry('whisper-vid-001');
  assert.ok(entry);
  assert.equal(entry.transcriptSource, 'whisper');
  assert.equal(entry.whisperModel, 'base');
});

test('saveEntry without transcriptSource/whisperModel reads back both as null (backward-compatible default)', async () => {
  await store.saveEntry({
    videoId: 'caption-vid-001',
    url: 'https://www.youtube.com/watch?v=caption-vid-001',
    title: 'Caption-sourced Video',
    segments: [{ text: 'from captions, not whisper', offset: 0 }],
  });

  const entry = await store.getEntry('caption-vid-001');
  assert.ok(entry);
  assert.equal(entry.transcriptSource, null);
  assert.equal(entry.whisperModel, null);
});

test('saveEntry: updating an existing entry without transcriptSource/whisperModel preserves the previously-saved values (keep-existing idiom)', async () => {
  await store.saveEntry({
    videoId: 'whisper-vid-002',
    url: 'https://www.youtube.com/watch?v=whisper-vid-002',
    title: 'Initially Whisper-Transcribed',
    segments: [{ text: 'first pass', offset: 0 }],
    transcriptSource: 'whisper',
    whisperModel: 'small',
  });

  // Re-save (e.g. a re-digest) without passing transcriptSource/whisperModel.
  await store.saveEntry({
    videoId: 'whisper-vid-002',
    url: 'https://www.youtube.com/watch?v=whisper-vid-002',
    title: 'Initially Whisper-Transcribed',
    segments: [{ text: 'second pass, same source', offset: 0 }],
  });

  const entry = await store.getEntry('whisper-vid-002');
  assert.ok(entry);
  assert.equal(entry.transcriptSource, 'whisper', 'transcriptSource from the earlier save must survive an update that omits it');
  assert.equal(entry.whisperModel, 'small', 'whisperModel from the earlier save must survive an update that omits it');
  assert.deepEqual(entry.segments, [{ text: 'second pass, same source', offset: 0 }]);
});
