import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-store-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// saveEntry / getEntry round-trip
// ---------------------------------------------------------------------------

test('saveEntry then getEntry round-trips title, url, segments, digest, and default favorite=false', async () => {
  const segments = [{ text: 'hello there', offset: 0 }, { text: 'world', offset: 5 }];
  await store.saveEntry({
    videoId: 'vid001',
    url: 'https://www.youtube.com/watch?v=vid001',
    title: 'First Video',
    segments,
    digest: 'a short digest',
  });

  const entry = await store.getEntry('vid001');
  assert.ok(entry);
  assert.equal(entry.title, 'First Video');
  assert.equal(entry.url, 'https://www.youtube.com/watch?v=vid001');
  assert.deepEqual(entry.segments, segments);
  assert.equal(entry.digest, 'a short digest');
  assert.equal(entry.favorite, false);
});

// ---------------------------------------------------------------------------
// URL sanitization
// ---------------------------------------------------------------------------

test('saveEntry with an unsafe url (javascript:) stores/returns an empty url', async () => {
  await store.saveEntry({
    videoId: 'vid-unsafe-url',
    url: 'javascript:alert(1)',
    title: 'Unsafe URL Video',
    segments: [{ text: 'hello', offset: 0 }],
  });

  const entry = await store.getEntry('vid-unsafe-url');
  assert.ok(entry);
  assert.equal(entry.url, '');
});

test('saveEntry with a valid https url round-trips that url', async () => {
  const url = 'https://www.youtube.com/watch?v=vid-safe-url';
  await store.saveEntry({
    videoId: 'vid-safe-url',
    url,
    title: 'Safe URL Video',
    segments: [{ text: 'hello', offset: 0 }],
  });

  const entry = await store.getEntry('vid-safe-url');
  assert.ok(entry);
  assert.equal(entry.url, url);
});

// ---------------------------------------------------------------------------
// Idempotent upsert
// ---------------------------------------------------------------------------

test('saveEntry twice with the same videoId upserts instead of duplicating', async () => {
  await store.saveEntry({
    videoId: 'vid002',
    url: 'https://www.youtube.com/watch?v=vid002',
    title: 'Original Title',
    segments: [{ text: 'v1', offset: 0 }],
  });

  await store.saveEntry({
    videoId: 'vid002',
    url: 'https://www.youtube.com/watch?v=vid002',
    title: 'Updated Title',
    segments: [{ text: 'v2', offset: 0 }],
  });

  const all = await store.listEntries();
  const matches = all.filter((e) => e.videoId === 'vid002');
  assert.equal(matches.length, 1);

  const entry = await store.getEntry('vid002');
  assert.equal(entry.title, 'Updated Title');
  assert.deepEqual(entry.segments, [{ text: 'v2', offset: 0 }]);
});

// ---------------------------------------------------------------------------
// Tags / favorite / notes / highlights
// ---------------------------------------------------------------------------

test('setTags, setFavorite, addNote, deleteNote, addHighlight, deleteHighlight mutate the entry as expected', async () => {
  await store.saveEntry({
    videoId: 'vid003',
    url: 'https://www.youtube.com/watch?v=vid003',
    title: 'Mutable Video',
    segments: [{ text: 'segment text', offset: 0 }],
  });

  // Tags
  await store.setTags('vid003', ['tag-a', 'tag-b', 'tag-a']); // dedup
  let entry = await store.getEntry('vid003');
  assert.deepEqual(entry.tags.sort(), ['tag-a', 'tag-b']);

  // Favorite
  await store.setFavorite('vid003', true);
  entry = await store.getEntry('vid003');
  assert.equal(entry.favorite, true);

  // Notes
  const note = await store.addNote('vid003', 'my note text');
  assert.ok(note.id);
  entry = await store.getEntry('vid003');
  assert.equal(entry.notes.length, 1);
  assert.equal(entry.notes[0].text, 'my note text');
  assert.equal(entry.notes[0].id, note.id);

  const deleteNoteResult = await store.deleteNote('vid003', note.id);
  assert.equal(deleteNoteResult, true);
  entry = await store.getEntry('vid003');
  assert.equal(entry.notes.length, 0);

  // Highlights
  const highlight = await store.addHighlight('vid003', { text: 'my highlight' });
  assert.ok(highlight.id);
  entry = await store.getEntry('vid003');
  assert.equal(entry.highlights.length, 1);
  assert.equal(entry.highlights[0].text, 'my highlight');
  assert.equal(entry.highlights[0].id, highlight.id);

  const deleteHighlightResult = await store.deleteHighlight('vid003', highlight.id);
  assert.equal(deleteHighlightResult, true);
  entry = await store.getEntry('vid003');
  assert.equal(entry.highlights.length, 0);
});

// ---------------------------------------------------------------------------
// listEntries metadata
// ---------------------------------------------------------------------------

test('listEntries returns metadata with correct counts, tags, and favorite', async () => {
  await store.saveEntry({
    videoId: 'vid004',
    url: 'https://www.youtube.com/watch?v=vid004',
    title: 'Metadata Video',
    segments: [{ text: 'a', offset: 0 }, { text: 'b', offset: 1 }],
    tags: ['x', 'y'],
    favorite: true,
  });
  await store.addNote('vid004', 'note one');
  await store.addNote('vid004', 'note two');
  await store.addHighlight('vid004', { text: 'hl one' });

  const all = await store.listEntries();
  const meta = all.find((e) => e.videoId === 'vid004');
  assert.ok(meta);
  assert.equal(meta.segmentCount, 2);
  assert.equal(meta.noteCount, 2);
  assert.equal(meta.highlightCount, 1);
  assert.deepEqual(meta.tags.sort(), ['x', 'y']);
  assert.equal(meta.favorite, true);
});

// ---------------------------------------------------------------------------
// searchLibrary
// ---------------------------------------------------------------------------

test('searchLibrary keyword search finds a distinctive word and returns [] for nonsense queries', async () => {
  await store.saveEntry({
    videoId: 'vid005',
    url: 'https://www.youtube.com/watch?v=vid005',
    title: 'Zorbnaxaquil Adventures',
    segments: [{ text: 'a normal transcript line', offset: 0 }],
    digest: 'This digest mentions Zorbnaxaquil explicitly.',
  });

  const hits = await store.searchLibrary('Zorbnaxaquil');
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((e) => e.videoId === 'vid005'));

  const noHits = await store.searchLibrary('qqqzzznonexistentqueryterm');
  assert.deepEqual(noHits, []);
});

// ---------------------------------------------------------------------------
// deleteEntry
// ---------------------------------------------------------------------------

test('deleteEntry removes the entry', async () => {
  await store.saveEntry({
    videoId: 'vid006',
    url: 'https://www.youtube.com/watch?v=vid006',
    title: 'To Be Deleted',
    segments: [{ text: 'gone soon', offset: 0 }],
  });

  const beforeCount = (await store.listEntries()).length;

  const deleted = await store.deleteEntry('vid006');
  assert.equal(deleted, true);

  const entry = await store.getEntry('vid006');
  assert.equal(entry, null);

  const afterCount = (await store.listEntries()).length;
  assert.equal(afterCount, beforeCount - 1);
});
