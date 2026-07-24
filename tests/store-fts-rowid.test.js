import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// The FTS index is keyed by videos.rowid, not by videoId.
//
// videoId is an UNINDEXED column in an FTS5 table, so `DELETE FROM videos_fts
// WHERE videoId = ?` plans as `SCAN videos_fts VIRTUAL TABLE` — a linear pass
// over every stored transcript, on every save. Measured before the change:
// 10.5 ms/save at 100 entries, 18.6 at 400, 23.7 at 800. After: flat ~9 ms.
//
// The catch is that pre-existing databases have FTS rowids that do NOT line up
// with videos rowids, so a rowid-keyed delete would silently miss them and
// leave stale documents that search keeps returning. Echo's ordinary flow —
// save the transcript, save again when the digest arrives — is exactly what
// pulls them apart: the second save deleted and re-inserted the FTS row, which
// handed it a fresh rowid while the videos rowid stayed put. Measured on the
// pre-change code: 40 of 40 rows diverged. Hence migrateFtsRowids().
// ---------------------------------------------------------------------------

const DBS = [];
function freshDbPath(label) {
  const p = join(tmpdir(), `echo-fts-rowid-${label}-${process.pid}-${Date.now()}-${DBS.length}.db`);
  DBS.push(p);
  return p;
}

test.after(() => {
  for (const p of DBS) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(p + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
});

/** Import a fresh instance of store.js bound to `dbPath`. */
async function loadStore(dbPath) {
  process.env.ECHO_DB_PATH = dbPath;
  return import(`../store.js?fts=${dbPath}`);
}

/**
 * Build a database in the pre-change shape: correct data, FTS rowids that do
 * not match videos rowids, and user_version still 0. This is what every real
 * library looked like, reproduced by hand so the test does not depend on the
 * old code still existing.
 */
function seedLegacyDb(dbPath, count) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE videos (
      videoId TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT,
      savedAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      segments TEXT NOT NULL DEFAULT '[]', digest TEXT,
      favorite INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0,
      channel TEXT, channelUrl TEXT, transcript_source TEXT, whisper_model TEXT
    );
    CREATE TABLE tags (
      videoId TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE,
      tag TEXT NOT NULL, UNIQUE(videoId, tag)
    );
    CREATE VIRTUAL TABLE videos_fts USING fts5(
      videoId UNINDEXED, title, transcript_text, digest
    );
  `);

  const insVideo = db.prepare(`
    INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, segment_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFts = db.prepare(
    'INSERT INTO videos_fts(rowid, videoId, title, transcript_text, digest) VALUES (?, ?, ?, ?, ?)');

  for (let i = 0; i < count; i++) {
    const id = `legacy${i}`;
    const text = `transcript for ${id} discussing capybaras and aqueducts`;
    const when = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    insVideo.run(id, `https://youtu.be/${id}`, `Legacy video ${i}`, when, when,
      JSON.stringify([{ text, offset: 0 }]), `## TL;DR\n\nDigest ${i}.`, 1);
    // The offset is the point: re-saves handed FTS rows rowids far past the
    // videos rowids they belong to.
    insFts.run(count + 1 + i, id, `Legacy video ${i}`, text, `## TL;DR\n\nDigest ${i}.`);
  }

  const mismatches = db.prepare(`
    SELECT COUNT(*) n FROM videos_fts f JOIN videos v ON v.videoId = f.videoId
    WHERE f.rowid != v.rowid`).get().n;
  assert.equal(mismatches, count, 'fixture should start fully divergent');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  db.close();
}

// ---------------------------------------------------------------------------

test('opening a pre-change database re-keys the FTS index by videos.rowid', async () => {
  const dbPath = freshDbPath('migrate');
  seedLegacyDb(dbPath, 12);

  const store = await loadStore(dbPath);
  await store.listEntries(); // force the open + migrations

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1,
    'the migration should record that it ran');
  assert.equal(db.prepare(`
    SELECT COUNT(*) n FROM videos_fts f JOIN videos v ON v.videoId = f.videoId
    WHERE f.rowid != v.rowid`).get().n, 0, 'every FTS row should now be keyed by its videos rowid');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM videos_fts').get().n, 12,
    'the rebuild should not lose or duplicate rows');
  db.close();

  // The index is still usable, which is the only reason any of this matters.
  const hits = await store.searchSummaries('capybaras', 50);
  assert.equal(hits.length, 12, 'every migrated entry should still be searchable');
});

test('the migration does not run twice', async () => {
  const dbPath = freshDbPath('idempotent');
  seedLegacyDb(dbPath, 5);

  const first = await loadStore(dbPath);
  await first.listEntries();

  // A second open must leave the index exactly as it is — not rebuild it, and
  // above all not append a second copy of every document.
  const second = await loadStore(dbPath);
  await second.listEntries();

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM videos_fts').get().n, 5);
  db.close();
  assert.equal((await second.searchSummaries('capybaras', 50)).length, 5);
});

test('re-saving an entry replaces its FTS row rather than adding one', async () => {
  // This is the flow that pulled rowids apart in the first place: save the
  // transcript, then save again once the digest arrives.
  const dbPath = freshDbPath('resave');
  const store = await loadStore(dbPath);

  await store.saveEntry({
    videoId: 'resave00001',
    url: 'https://youtu.be/resave00001',
    title: 'Aqueduct engineering',
    segments: [{ text: 'a talk about roman aqueducts', offset: 0 }],
  });
  const entry = await store.getEntry('resave00001');
  await store.saveEntry({ ...entry, digest: '## TL;DR\n\nAqueducts, mostly.' });

  const db = new DatabaseSync(dbPath);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM videos_fts WHERE videoId = 'resave00001'").get().n, 1,
    'a re-save must leave exactly one FTS row');
  assert.equal(db.prepare(`
    SELECT COUNT(*) n FROM videos_fts f JOIN videos v ON v.videoId = f.videoId
    WHERE f.rowid != v.rowid`).get().n, 0);
  db.close();

  // The digest text only reaches the index if the re-save actually re-indexed.
  assert.equal((await store.searchSummaries('aqueducts', 10)).length, 1);
});

test('deleting an entry removes it from the search index', async () => {
  // The failure a rowid mistake produces is not a crash — it is a deleted
  // video that keeps turning up in search results forever.
  const dbPath = freshDbPath('delete');
  const store = await loadStore(dbPath);

  for (const id of ['delone00001', 'deltwo00002']) {
    await store.saveEntry({
      videoId: id,
      url: `https://youtu.be/${id}`,
      title: `Video ${id}`,
      segments: [{ text: `unmistakable marker phrase in ${id}`, offset: 0 }],
      digest: '## TL;DR\n\nx',
    });
  }
  assert.equal((await store.searchSummaries('unmistakable', 10)).length, 2);

  assert.equal(await store.deleteEntry('delone00001'), true);

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM videos_fts WHERE videoId = 'delone00001'").get().n, 0);
  db.close();

  const remaining = await store.searchSummaries('unmistakable', 10);
  assert.equal(remaining.length, 1, 'the deleted video must not survive in the index');
  assert.equal(remaining[0].videoId, 'deltwo00002');
});

test('a rowid recycled by SQLite does not resurrect the old document', async () => {
  // videos.rowid is reused after a delete. That is only safe because both rows
  // are always deleted together — if the FTS row outlived the videos row, the
  // next video to claim that rowid would inherit its text.
  const dbPath = freshDbPath('recycle');
  const store = await loadStore(dbPath);

  await store.saveEntry({
    videoId: 'ghost000001',
    url: 'https://youtu.be/ghost000001',
    title: 'Ghost video',
    segments: [{ text: 'haunted vocabulary spectral', offset: 0 }],
    digest: '## TL;DR\n\nboo',
  });
  await store.deleteEntry('ghost000001');

  await store.saveEntry({
    videoId: 'fresh0000001',
    url: 'https://youtu.be/fresh0000001',
    title: 'Fresh video',
    segments: [{ text: 'ordinary words about gardening', offset: 0 }],
    digest: '## TL;DR\n\nplants',
  });

  assert.equal((await store.searchSummaries('spectral', 10)).length, 0,
    'the deleted video must not haunt the index');
  const fresh = await store.searchSummaries('gardening', 10);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].videoId, 'fresh0000001');
});
