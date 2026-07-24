import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  openSyncDb, closeSyncDb, upsertUser, getUser,
  pullEntries, pushEntries, userBytes, deleteUser, bumpTokenVersion,
} from '../syncStore.js';

// ---------------------------------------------------------------------------
// The synced library: last-write-wins by updatedAt, per user, with tombstones.
//
// The cases that matter are the ones that make sync feel broken to a person
// with two devices: a stale device overwriting a newer edit, a deletion coming
// back to life, and one account being able to see another's library.
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-sync-${process.pid}-${Date.now()}.db`);

test('opens a fresh sync database', () => {
  openSyncDb(DB);
  assert.ok(true);
});

test.after(() => {
  closeSyncDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

const entry = (videoId, updatedAt, extra = {}) => ({
  videoId,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  title: `Video ${videoId}`,
  segments: [{ text: 'hello there', offset: 0 }],
  digest: 'A digest.',
  savedAt: updatedAt,
  updatedAt,
  ...extra,
});

// --- Users -----------------------------------------------------------------

test('upsertUser: the same Google sub always maps to the same user', () => {
  const first = upsertUser({ sub: 'google-1', email: 'a@b.com' });
  const again = upsertUser({ sub: 'google-1', email: 'a@b.com' });
  assert.equal(first.id, again.id);
});

test('upsertUser: a changed email updates without creating a second account', () => {
  // The sub is the join key precisely because emails change; keying on email
  // would fork someone's library the day they rename their Google account.
  const before = upsertUser({ sub: 'google-2', email: 'old@b.com' });
  const after = upsertUser({ sub: 'google-2', email: 'new@b.com' });
  assert.equal(before.id, after.id);
  assert.equal(getUser(after.id).email, 'new@b.com');
});

test('upsertUser: different subs are different people', () => {
  const a = upsertUser({ sub: 'google-3', email: 'a@b.com' });
  const b = upsertUser({ sub: 'google-4', email: 'a@b.com' }); // same email!
  assert.notEqual(a.id, b.id);
});

// --- Push / pull -----------------------------------------------------------

test('push then pull returns the entry', () => {
  const user = upsertUser({ sub: 'sync-1' });
  const result = pushEntries(user.id, [entry('vidAAAAAAA1', '2026-07-01T00:00:00.000Z')]);
  assert.equal(result.applied, 1);

  const { entries } = pullEntries(user.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, 'vidAAAAAAA1');
  assert.equal(entries[0].digest, 'A digest.');
  assert.equal(entries[0].deleted, false);
});

test('a newer edit wins over an older one', () => {
  const user = upsertUser({ sub: 'sync-2' });
  pushEntries(user.id, [entry('vidBBBBBBB1', '2026-07-01T00:00:00.000Z', { title: 'Old' })]);
  pushEntries(user.id, [entry('vidBBBBBBB1', '2026-07-02T00:00:00.000Z', { title: 'New' })]);

  const { entries } = pullEntries(user.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'New');
});

test('a stale device cannot overwrite a newer edit', () => {
  // The scenario: phone edits, then a laptop that has been offline pushes its
  // older copy. The laptop must lose.
  const user = upsertUser({ sub: 'sync-3' });
  pushEntries(user.id, [entry('vidCCCCCCC1', '2026-07-05T00:00:00.000Z', { title: 'Newer' })]);
  const result = pushEntries(user.id, [entry('vidCCCCCCC1', '2026-07-01T00:00:00.000Z', { title: 'Stale' })]);

  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(pullEntries(user.id).entries[0].title, 'Newer');
});

test('re-pushing an identical entry is a no-op, so sync is idempotent', () => {
  const user = upsertUser({ sub: 'sync-4' });
  const e = entry('vidDDDDDDD1', '2026-07-01T00:00:00.000Z');
  pushEntries(user.id, [e]);
  const second = pushEntries(user.id, [e]);
  assert.equal(second.applied, 0);
  assert.equal(second.skipped, 1);
});

test('pull since a timestamp returns only what changed after it', () => {
  const user = upsertUser({ sub: 'sync-5' });
  pushEntries(user.id, [entry('vidEEEEEEE1', '2026-07-01T00:00:00.000Z')]);
  pushEntries(user.id, [entry('vidEEEEEEE2', '2026-07-10T00:00:00.000Z')]);

  const { entries } = pullEntries(user.id, '2026-07-05T00:00:00.000Z');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, 'vidEEEEEEE2');
});

test('pull reports a server time the client can use as its next cursor', () => {
  const user = upsertUser({ sub: 'sync-6' });
  const { serverTime } = pullEntries(user.id);
  assert.match(serverTime, /^\d{4}-\d{2}-\d{2}T/);
});

// --- Deletions -------------------------------------------------------------

test('a deletion travels as a tombstone rather than vanishing', () => {
  // Without a tombstone, a device still holding the entry pushes it back and
  // the delete undoes itself on every other device.
  const user = upsertUser({ sub: 'sync-7' });
  pushEntries(user.id, [entry('vidFFFFFFF1', '2026-07-01T00:00:00.000Z')]);
  pushEntries(user.id, [{ videoId: 'vidFFFFFFF1', updatedAt: '2026-07-02T00:00:00.000Z', deleted: true }]);

  const { entries } = pullEntries(user.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].deleted, true);
  assert.equal(entries[0].videoId, 'vidFFFFFFF1');
});

test('an older copy cannot resurrect a deleted entry', () => {
  const user = upsertUser({ sub: 'sync-8' });
  pushEntries(user.id, [entry('vidGGGGGGG1', '2026-07-01T00:00:00.000Z')]);
  pushEntries(user.id, [{ videoId: 'vidGGGGGGG1', updatedAt: '2026-07-05T00:00:00.000Z', deleted: true }]);
  pushEntries(user.id, [entry('vidGGGGGGG1', '2026-07-02T00:00:00.000Z')]);

  assert.equal(pullEntries(user.id).entries[0].deleted, true);
});

test('a delete can be undone by a newer save', () => {
  const user = upsertUser({ sub: 'sync-9' });
  pushEntries(user.id, [{ videoId: 'vidHHHHHHH1', updatedAt: '2026-07-01T00:00:00.000Z', deleted: true }]);
  pushEntries(user.id, [entry('vidHHHHHHH1', '2026-07-02T00:00:00.000Z')]);
  assert.equal(pullEntries(user.id).entries[0].deleted, false);
});

// --- Paging ----------------------------------------------------------------

test('a truncated page reports hasMore and a cursor that does not skip the rest', () => {
  // The bug this guards: pullEntries used to return serverTime = now even when
  // it had truncated the page. The client stores that as its cursor and asks
  // for everything AFTER it, so on a first sync of a large library every entry
  // past the first page was skipped — silently, and permanently.
  const user = upsertUser({ sub: 'paging-1' });
  const entries = [];
  for (let i = 0; i < 600; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    entries.push({ videoId: `pg${String(i).padStart(9, '0')}`, title: `V${i}`, updatedAt: ts, savedAt: ts });
  }
  pushEntries(user.id, entries);

  const first = pullEntries(user.id);
  assert.equal(first.entries.length, 500);
  assert.equal(first.hasMore, true);

  // Following the cursor must reach everything that was held back.
  const second = pullEntries(user.id, first.serverTime);
  assert.equal(second.entries.length, 100, 'the remainder must still be reachable');
  assert.equal(second.hasMore, false);

  const seen = new Set([...first.entries, ...second.entries].map((e) => e.videoId));
  assert.equal(seen.size, 600, 'every entry must arrive across the pages');
});

test('a page that is not truncated reports hasMore false and a fresh cursor', () => {
  const user = upsertUser({ sub: 'paging-2' });
  pushEntries(user.id, [entry('pgsmall0001', '2026-07-01T00:00:00.000Z')]);
  const { hasMore, serverTime } = pullEntries(user.id);
  assert.equal(hasMore, false);
  // Now, not the last row's timestamp — so later writes are not re-delivered.
  assert.ok(serverTime > '2026-07-01T00:00:00.000Z');
});

// --- Isolation -------------------------------------------------------------

test('one account never sees another account\'s library', () => {
  const alice = upsertUser({ sub: 'iso-alice' });
  const bob = upsertUser({ sub: 'iso-bob' });

  pushEntries(alice.id, [entry('vidIIIIIII1', '2026-07-01T00:00:00.000Z', { title: "Alice's" })]);
  pushEntries(bob.id, [entry('vidJJJJJJJ1', '2026-07-01T00:00:00.000Z', { title: "Bob's" })]);

  const aliceIds = pullEntries(alice.id).entries.map((e) => e.videoId);
  const bobIds = pullEntries(bob.id).entries.map((e) => e.videoId);
  assert.deepEqual(aliceIds, ['vidIIIIIII1']);
  assert.deepEqual(bobIds, ['vidJJJJJJJ1']);
});

test('two accounts can hold the same videoId independently', () => {
  const a = upsertUser({ sub: 'same-vid-a' });
  const b = upsertUser({ sub: 'same-vid-b' });
  pushEntries(a.id, [entry('vidKKKKKKK1', '2026-07-01T00:00:00.000Z', { title: 'A copy' })]);
  pushEntries(b.id, [entry('vidKKKKKKK1', '2026-07-01T00:00:00.000Z', { title: 'B copy' })]);

  assert.equal(pullEntries(a.id).entries[0].title, 'A copy');
  assert.equal(pullEntries(b.id).entries[0].title, 'B copy');
});

// --- Session revocation ----------------------------------------------------

test('a new account starts at token version 0', () => {
  const user = upsertUser({ sub: 'tv-1' });
  assert.equal(user.tokenVersion, 0);
  assert.equal(getUser(user.id).tokenVersion, 0);
});

test('bumping the token version invalidates sessions issued before it', () => {
  // This is the whole point of the column: a stateless cookie cannot otherwise
  // be revoked before it expires, so a leaked one would stay valid for 30 days.
  const user = upsertUser({ sub: 'tv-2' });
  const next = bumpTokenVersion(user.id);
  assert.equal(next, 1);
  assert.equal(getUser(user.id).tokenVersion, 1);
  // A session minted at version 0 no longer matches, which is what the server
  // compares on every request.
  assert.notEqual(0, getUser(user.id).tokenVersion);
});

test('signing in again after a bump picks up the new version', () => {
  const user = upsertUser({ sub: 'tv-3' });
  bumpTokenVersion(user.id);
  const again = upsertUser({ sub: 'tv-3' });
  assert.equal(again.tokenVersion, 1, 'a fresh sign-in must mint a session that works');
});

test('one account\'s revocation does not touch another\'s', () => {
  const a = upsertUser({ sub: 'tv-a' });
  const b = upsertUser({ sub: 'tv-b' });
  bumpTokenVersion(a.id);
  assert.equal(getUser(a.id).tokenVersion, 1);
  assert.equal(getUser(b.id).tokenVersion, 0);
});

// --- Storage hygiene -------------------------------------------------------

test('only allow-listed fields are stored', () => {
  // A client sending extra fields must not be able to park arbitrary data in a
  // row the server then hands to every other device.
  const user = upsertUser({ sub: 'strip-1' });
  pushEntries(user.id, [entry('vidLLLLLLL1', '2026-07-01T00:00:00.000Z', {
    apiKey: 'sk-ant-should-never-be-stored',
    __proto__polluted: true,
    hugeJunk: 'x'.repeat(1000),
  })]);

  const stored = pullEntries(user.id).entries[0];
  assert.equal(stored.apiKey, undefined, 'an API key must never be persisted server-side');
  assert.equal(stored.hugeJunk, undefined);
  assert.equal(stored.title, 'Video vidLLLLLLL1');
});

test('entries with no videoId are skipped rather than stored', () => {
  const user = upsertUser({ sub: 'skip-1' });
  const result = pushEntries(user.id, [
    { updatedAt: '2026-07-01T00:00:00.000Z' },
    { videoId: '', updatedAt: '2026-07-01T00:00:00.000Z' },
    { videoId: 'x'.repeat(100), updatedAt: '2026-07-01T00:00:00.000Z' },
  ]);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 3);
});

test('userBytes reflects stored payloads and is per-user', () => {
  const user = upsertUser({ sub: 'bytes-1' });
  assert.equal(userBytes(user.id), 0);
  pushEntries(user.id, [entry('vidMMMMMMM1', '2026-07-01T00:00:00.000Z')]);
  assert.ok(userBytes(user.id) > 0);
});

test('deleting an account removes its entries too', () => {
  const user = upsertUser({ sub: 'delete-me' });
  pushEntries(user.id, [entry('vidNNNNNNN1', '2026-07-01T00:00:00.000Z')]);
  deleteUser(user.id);

  assert.equal(getUser(user.id), null);
  assert.equal(userBytes(user.id), 0, 'ON DELETE CASCADE must take the library with it');
});
