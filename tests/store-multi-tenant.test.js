import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, mkdirSync } from 'node:fs';

// A fresh data directory per run, set BEFORE store.js is imported — the module
// reads ECHO_DB_PATH once, at import.
const ROOT = join(tmpdir(), `echo-tenant-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
process.env.ECHO_DB_PATH = join(ROOT, 'library.db');

const store = await import('../store.js');
const { forOwner, DEFAULT_OWNER, dbPathFor, adoptDefaultLibrary, closeAllLibraries } = store;

// ---------------------------------------------------------------------------
// One library per person.
//
// Isolation here is a FILE boundary, not a WHERE clause — so the test that
// matters is not "does the filter work" but "can one owner observe another at
// all", through any of the read paths: the list, a direct fetch, search, the
// count, and tags.
// ---------------------------------------------------------------------------

const alice = forOwner('alice-0000-1111');
const bob = forOwner('bob-2222-3333');
const solo = forOwner();

const entry = (videoId, title, text) => ({
  url: `https://www.youtube.com/watch?v=${videoId}`,
  videoId,
  title,
  segments: [{ start: 0, text }],
  digest: `# ${title}\n\n${text}`,
  tags: [],
});

test.after(() => {
  closeAllLibraries();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('each owner gets their own file, and the default keeps the original path', () => {
  assert.equal(dbPathFor(DEFAULT_OWNER), join(ROOT, 'library.db'),
    'an install without accounts must not have its database moved');
  assert.equal(dbPathFor('alice-0000-1111'), join(ROOT, 'libraries', 'alice-0000-1111.db'));
  assert.notEqual(dbPathFor('alice-0000-1111'), dbPathFor('bob-2222-3333'));
});

test('an owner id that is not filename-safe is refused', () => {
  // The id becomes a path segment. A separator or a `..` would be a traversal
  // straight out of the data directory, so the guard is not cosmetic.
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', '.', '..', 'x'.repeat(65), 'a b']) {
    assert.throws(() => dbPathFor(bad), /Invalid library owner id/, `${JSON.stringify(bad)} must be refused`);
  }
});

test('one owner cannot see another through ANY read path', async () => {
  await alice.saveEntry(entry('alicevid001', 'Alice on lighthouses', 'the lamp room rotates'));
  await bob.saveEntry(entry('bobvid000001', 'Bob on bicycles', 'the chain needs oil'));

  // The list
  const aliceList = await alice.listEntries();
  assert.deepEqual(aliceList.map((e) => e.videoId), ['alicevid001']);
  const bobList = await bob.listEntries();
  assert.deepEqual(bobList.map((e) => e.videoId), ['bobvid000001']);

  // A direct fetch of a known-good id belonging to someone else
  assert.equal(await alice.getEntry('bobvid000001'), null, 'guessing an id must not work');
  assert.equal(await bob.getEntry('alicevid001'), null);

  // Full-text search, which reads transcripts and digests
  assert.deepEqual(await alice.searchSummaries('bicycles'), []);
  assert.deepEqual(await bob.searchSummaries('lighthouses'), []);
  assert.equal((await alice.searchSummaries('lighthouses')).length, 1, 'their own content is still findable');

  // The count
  assert.equal(await alice.countEntries(), 1);
  assert.equal(await bob.countEntries(), 1);

  // And the single-user library, which must have seen none of this
  assert.equal(await solo.countEntries(), 0);
});

test('the same video saved by two people is two independent entries', async () => {
  const shared = 'GRzaq5AHiV8';
  await alice.saveEntry({ ...entry(shared, 'Alice title', 'alice text'), tags: ['alice-tag'] });
  await bob.saveEntry({ ...entry(shared, 'Bob title', 'bob text'), tags: ['bob-tag'] });

  const a = await alice.getEntry(shared);
  const b = await bob.getEntry(shared);
  assert.equal(a.title, 'Alice title');
  assert.equal(b.title, 'Bob title');
  assert.deepEqual(a.tags, ['alice-tag'], 'tags do not bleed across owners either');
  assert.deepEqual(b.tags, ['bob-tag']);

  // Editing one must not touch the other — the case a shared primary key on
  // videoId would have silently collapsed into a single row.
  await alice.setTags(shared, ['edited-by-alice']);
  assert.deepEqual((await alice.getEntry(shared)).tags, ['edited-by-alice']);
  assert.deepEqual((await bob.getEntry(shared)).tags, ['bob-tag']);

  // As must deleting.
  assert.equal(await alice.deleteEntry(shared), true);
  assert.equal(await alice.getEntry(shared), null);
  assert.ok(await bob.getEntry(shared), "deleting one owner's copy must leave the other's");
});

test('adoption hands the pre-accounts library to an account, once', async () => {
  closeAllLibraries();
  const ROOT2 = join(tmpdir(), `echo-adopt-${process.pid}-${Date.now()}`);
  mkdirSync(ROOT2, { recursive: true });

  // A single-user library with something in it, at the default path.
  await solo.saveEntry(entry('legacyvid001', 'Saved before accounts', 'from the old days'));
  assert.equal(await solo.countEntries(), 1);

  const operator = forOwner('operator-9999');
  assert.equal(await operator.countEntries(), 0, 'a new account starts empty');

  closeAllLibraries();
  const result = adoptDefaultLibrary('operator-9999');
  assert.equal(result.adopted, true);

  // The whole library moved, contents intact.
  assert.equal(await operator.countEntries(), 1);
  assert.equal((await operator.getEntry('legacyvid001')).title, 'Saved before accounts');
  assert.ok(!existsSync(dbPathFor(DEFAULT_OWNER)), 'the default file is gone, not copied');

  // Idempotent: there is nothing left to adopt, so a second call is a no-op
  // rather than a second move.
  assert.deepEqual(adoptDefaultLibrary('someone-else-1'), { adopted: false, reason: 'nothing_to_adopt' });

  // And it must never overwrite an account that already has a library.
  await forOwner('has-a-library').saveEntry(entry('theirsvid001', 'Theirs', 'already here'));
  await solo.saveEntry(entry('newdefault01', 'New default', 'made after adoption'));
  closeAllLibraries();
  assert.deepEqual(adoptDefaultLibrary('has-a-library'), { adopted: false, reason: 'owner_has_library' });
  assert.equal((await forOwner('has-a-library').getEntry('theirsvid001')).title, 'Theirs');

  try { rmSync(ROOT2, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('open handles are bounded, and the default owner is never evicted', async () => {
  closeAllLibraries();

  // Comfortably past MAX_OPEN_LIBRARIES (64). Each of these opens a handle;
  // without the cap the process would hold one per person, forever.
  await solo.saveEntry(entry('defaultvid01', 'Default owner entry', 'still here'));
  for (let i = 0; i < 80; i++) {
    await forOwner(`bulk-owner-${String(i).padStart(3, '0')}`).countEntries();
  }

  // The evicted handles must reopen transparently — a closed handle that stayed
  // in the map would throw on the next request instead of just reopening.
  assert.equal(await forOwner('bulk-owner-000').countEntries(), 0);

  // And the single-user library must survive the churn: on an install without
  // accounts it is the only library there is. Asserted by content rather than
  // by count — an earlier test in this file also writes to the default library,
  // and a count here would be asserting test order, not behaviour.
  assert.equal((await solo.getEntry('defaultvid01')).title, 'Default owner entry');
});
