import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

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
// Tags
// ---------------------------------------------------------------------------

test('setTags mutates the entry as expected', async () => {
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

  const all = await store.listEntries();
  const meta = all.find((e) => e.videoId === 'vid004');
  assert.ok(meta);
  assert.equal(meta.segmentCount, 2);
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
// segment_count denormalization
// ---------------------------------------------------------------------------

test('listEntries reports segmentCount from the denormalized column for various segment counts', async () => {
  const segments = Array.from({ length: 7 }, (_, i) => ({ text: `seg ${i}`, offset: i }));
  await store.saveEntry({
    videoId: 'vid-segcount',
    url: 'https://www.youtube.com/watch?v=vid-segcount',
    title: 'Segment Count Video',
    segments,
  });

  const all = await store.listEntries();
  const meta = all.find((e) => e.videoId === 'vid-segcount');
  assert.ok(meta);
  assert.equal(meta.segmentCount, 7);

  // Full entry (getEntry) must still return the complete segments array.
  const entry = await store.getEntry('vid-segcount');
  assert.equal(entry.segments.length, 7);
  assert.deepEqual(entry.segments, segments);

  // Re-saving with fewer segments updates the denormalized count too.
  const fewer = segments.slice(0, 3);
  await store.saveEntry({
    videoId: 'vid-segcount',
    url: 'https://www.youtube.com/watch?v=vid-segcount',
    title: 'Segment Count Video',
    segments: fewer,
  });
  const allAfter = await store.listEntries();
  const metaAfter = allAfter.find((e) => e.videoId === 'vid-segcount');
  assert.equal(metaAfter.segmentCount, 3);
});

test('segment_count migration backfills existing rows created before the column existed', () => {
  const migrationDb = join(tmpdir(), `echo-test-migration-${process.pid}-${Date.now()}.db`);
  try {
    // Simulate a pre-migration DB: create the videos table WITHOUT segment_count,
    // then insert a row with segments but no segment_count value.
    const raw = new DatabaseSync(migrationDb);
    raw.exec(`
      CREATE TABLE videos (
        videoId   TEXT PRIMARY KEY,
        url       TEXT NOT NULL,
        title     TEXT,
        savedAt   TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        segments  TEXT NOT NULL DEFAULT '[]',
        digest    TEXT,
        favorite  INTEGER NOT NULL DEFAULT 0
      );
    `);
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, favorite)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-vid',
      'https://www.youtube.com/watch?v=legacy-vid',
      'Legacy Video',
      now, now,
      JSON.stringify([{ text: 'a', offset: 0 }, { text: 'b', offset: 1 }, { text: 'c', offset: 2 }]),
      null, 0,
    );
    raw.close();

    // Import store.js in a fresh subprocess pointed at this legacy DB so the
    // module-load-time migration runs against it, then report listEntries().
    const storeUrl = new URL('../store.js', import.meta.url).href;
    const script = `
      process.env.ECHO_DB_PATH = ${JSON.stringify(migrationDb)};
      import(${JSON.stringify(storeUrl)}).then(async (store) => {
        const all = await store.listEntries();
        process.stdout.write(JSON.stringify(all.map((e) => ({ videoId: e.videoId, segmentCount: e.segmentCount }))));
      });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
    });
    const result = JSON.parse(out.trim());
    const legacy = result.find((e) => e.videoId === 'legacy-vid');
    assert.ok(legacy, 'legacy row should be present after migration');
    assert.equal(legacy.segmentCount, 3);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(migrationDb + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
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
