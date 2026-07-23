import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Same temp-DB-before-import setup as tests/store.test.js.
const DB = join(tmpdir(), `echo-test-store-listentries-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// listEntries() — projection + shape parity with saveEntry()/toMeta()
// ---------------------------------------------------------------------------

const entryAPayload = {
  videoId: 'list-vid-a',
  url: 'https://www.youtube.com/watch?v=list-vid-a',
  title: 'Entry A — has digest',
  digest: '# Digest for A\n\nSome markdown content.',
  segments: [
    { text: 'segment one', offset: 0 },
    { text: 'segment two', offset: 5 },
    { text: 'segment three', offset: 10 },
  ],
  channel: 'Channel A',
  channelUrl: 'https://www.youtube.com/@channelA',
  transcriptSource: 'whisper',
  whisperModel: 'base',
};

test('listEntries: returns both entries sorted savedAt DESC with correct metadata', async () => {
  const savedA = await store.saveEntry(entryAPayload);

  // Ensure a distinct savedAt ordering (savedAt uses ISO timestamps with ms
  // resolution; a tiny delay guarantees B is saved strictly after A).
  await new Promise((resolve) => setTimeout(resolve, 5));

  await store.saveEntry({
    videoId: 'list-vid-b',
    url: 'https://www.youtube.com/watch?v=list-vid-b',
    title: 'Entry B — no digest',
    segments: [{ text: 'only segment', offset: 0 }],
  });

  const list = await store.listEntries();

  const idxA = list.findIndex((e) => e.videoId === 'list-vid-a');
  const idxB = list.findIndex((e) => e.videoId === 'list-vid-b');
  assert.ok(idxA !== -1, 'entry A present');
  assert.ok(idxB !== -1, 'entry B present');
  assert.ok(idxB < idxA, 'entry B (saved later) should sort before entry A — savedAt DESC');

  const entryA = list[idxA];
  assert.equal(entryA.hasDigest, true);
  assert.equal(entryA.segmentCount, 3);
  assert.equal(entryA.channel, 'Channel A');
  assert.equal(entryA.channelUrl, 'https://www.youtube.com/@channelA');
  assert.equal(entryA.transcriptSource, 'whisper');
  assert.equal(entryA.whisperModel, 'base');

  const entryB = list[idxB];
  assert.equal(entryB.hasDigest, false);
  assert.equal(entryB.transcriptSource, null);
  assert.equal(entryB.whisperModel, null);

  // Drift guard: listEntries() and saveEntry() must emit the identical key set.
  assert.deepEqual(
    Object.keys(entryA).sort(),
    Object.keys(savedA).sort(),
    'listEntries() rows must have the same shape as saveEntry() results',
  );
});
