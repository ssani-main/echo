import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// pruneShares() / getShare({ maxAgeMs }) coverage — split into its own file
// (rather than appended to store-shares.test.js) so it gets a dedicated,
// otherwise-empty DB: pruneShares({ maxCount }) assertions need to count
// exactly how many share rows exist, and sharing that DB with
// store-shares.test.js's round-trip fixtures would pollute the count.
//
// store.js does not export its `db` handle, so createdAt values (which
// createShare stamps as `new Date().toISOString()` at insert time) cannot be
// backdated through the public API. Instead, a second node:sqlite
// DatabaseSync connection is opened directly onto the same DB file to
// UPDATE createdAt after the fact — the same pattern tests/store.test.js
// already uses for its segment_count migration test (raw DatabaseSync onto
// a throwaway file, sequential/non-concurrent access, so WAL visibility
// between connections is not a concern here).
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-store-shares-prune-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');

// Raw second connection onto the same file, used only to backdate createdAt.
const raw = new DatabaseSync(DB);

function backdate(id, msAgo) {
  const iso = new Date(Date.now() - msAgo).toISOString();
  raw.prepare('UPDATE shares SET createdAt = ? WHERE id = ?').run(iso, id);
}

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(() => {
  try { raw.close(); } catch { /* ignore */ }
  cleanupDb();
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// pruneShares({ maxAgeMs }) — deletes only rows older than the cutoff.
// ---------------------------------------------------------------------------

test('pruneShares({ maxAgeMs }) deletes only rows older than the cutoff, keeps newer rows', async () => {
  const old1 = await store.createShare({ videoId: 'prune-age-old-1', digestMd: 'old share 1' });
  const old2 = await store.createShare({ videoId: 'prune-age-old-2', digestMd: 'old share 2' });
  const fresh = await store.createShare({ videoId: 'prune-age-fresh', digestMd: 'fresh share' });

  // Backdate both "old" rows to 10 days ago; leave `fresh` at its real,
  // just-now createdAt.
  backdate(old1.id, 10 * DAY_MS);
  backdate(old2.id, 10 * DAY_MS);

  const result = await store.pruneShares({ maxAgeMs: 5 * DAY_MS });
  assert.equal(result.deleted, 2);

  assert.equal(await store.getShare(old1.id), null);
  assert.equal(await store.getShare(old2.id), null);
  assert.ok(await store.getShare(fresh.id), 'the fresh row should survive age-pruning');
});

// ---------------------------------------------------------------------------
// pruneShares({ maxCount }) — trims to at most maxCount rows.
// ---------------------------------------------------------------------------
//
// createShare stamps createdAt at millisecond resolution, so two shares
// created back-to-back in the same test process can land on the same
// timestamp; ORDER BY createdAt ASC does not guarantee stable tie-breaking
// in that case. Rather than assert *which* specific rows survive (which
// could flake on a fast machine), this only asserts the surviving *count*,
// which is deterministic regardless of tie-breaking.
// ---------------------------------------------------------------------------

test('pruneShares({ maxCount }) trims the table down to at most maxCount rows', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const created = await store.createShare({ videoId: `prune-count-${i}`, digestMd: `share ${i}` });
    ids.push(created.id);
  }

  await store.pruneShares({ maxCount: 3 });

  let survivors = 0;
  for (const id of ids) {
    if (await store.getShare(id)) survivors++;
  }
  assert.equal(survivors, 3);
});

// ---------------------------------------------------------------------------
// pruneShares() with no args — no-op.
// ---------------------------------------------------------------------------

test('pruneShares() with no args is a no-op (deletes 0, all rows survive)', async () => {
  const a = await store.createShare({ videoId: 'prune-noop-a', digestMd: 'noop share a' });
  const b = await store.createShare({ videoId: 'prune-noop-b', digestMd: 'noop share b' });

  const result = await store.pruneShares();
  assert.equal(result.deleted, 0);

  assert.ok(await store.getShare(a.id));
  assert.ok(await store.getShare(b.id));
});

// ---------------------------------------------------------------------------
// getShare(id, { maxAgeMs }) — lazy expiry.
// ---------------------------------------------------------------------------

test('getShare(id, { maxAgeMs }) returns null and lazily deletes a row older than maxAgeMs; a second lookup with no opts also returns null', async () => {
  const created = await store.createShare({ videoId: 'expire-me', digestMd: 'this will expire' });
  backdate(created.id, 10 * DAY_MS);

  const expired = await store.getShare(created.id, { maxAgeMs: 5 * DAY_MS });
  assert.equal(expired, null);

  // Lazily deleted by the call above — a plain getShare (no opts, which
  // never expires on its own) should also now come back null because the
  // row itself is gone.
  const afterLazyDelete = await store.getShare(created.id);
  assert.equal(afterLazyDelete, null);
});

test('getShare(id) with no opts never expires, no matter how old the row is', async () => {
  const created = await store.createShare({ videoId: 'ancient-but-permanent', digestMd: 'very old share' });
  backdate(created.id, 10 * 365 * DAY_MS); // ~10 years ago

  const share = await store.getShare(created.id);
  assert.ok(share, 'getShare with no maxAgeMs option must never treat a row as expired');
  assert.equal(share.id, created.id);
});

test('getShare(id, { maxAgeMs: 0 }) is treated as "no expiry" (0 is not > 0), even for a very old row', async () => {
  const created = await store.createShare({ videoId: 'zero-maxagems', digestMd: 'old share, zero maxAgeMs' });
  backdate(created.id, 10 * DAY_MS);

  const share = await store.getShare(created.id, { maxAgeMs: 0 });
  assert.ok(share, 'maxAgeMs: 0 must not expire the row (impl guards on maxAgeMs > 0)');
});
