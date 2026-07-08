import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-store-shares-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// createShare / getShare round-trip
// ---------------------------------------------------------------------------

test('createShare then getShare round-trips videoId, title, sourceUrl, digestMd, and claims (parsed back to an array)', async () => {
  const claims = [
    { claim: 'The earth is round.', status: 'supported' },
    { claim: 'Foo is bar.', status: 'unverifiable' },
  ];

  const created = await store.createShare({
    videoId: 'share-vid-001',
    title: 'A Shared Digest',
    sourceUrl: 'https://www.youtube.com/watch?v=share-vid-001',
    digestMd: '# Heading\n\nSome digest body text.',
    claims,
  });

  assert.ok(created.id, 'createShare should return a generated id');
  assert.ok(created.createdAt, 'createShare should return a createdAt timestamp');

  const share = await store.getShare(created.id);
  assert.ok(share);
  assert.equal(share.id, created.id);
  assert.equal(share.videoId, 'share-vid-001');
  assert.equal(share.title, 'A Shared Digest');
  assert.equal(share.sourceUrl, 'https://www.youtube.com/watch?v=share-vid-001');
  assert.equal(share.digestMd, '# Heading\n\nSome digest body text.');
  assert.equal(share.createdAt, created.createdAt);
  assert.ok(Array.isArray(share.claims));
  assert.deepEqual(share.claims, claims);
});

test('createShare generates a distinct id per call', async () => {
  const a = await store.createShare({ digestMd: 'digest A' });
  const b = await store.createShare({ digestMd: 'digest B' });
  assert.notEqual(a.id, b.id);
});

// ---------------------------------------------------------------------------
// claims omitted / empty -> stored/returned as null
// ---------------------------------------------------------------------------

test('createShare with claims omitted stores/returns claims as null', async () => {
  const created = await store.createShare({
    videoId: 'share-vid-noclaims',
    digestMd: 'A digest with no claims field at all.',
  });
  const share = await store.getShare(created.id);
  assert.ok(share);
  assert.equal(share.claims, null);
});

test('createShare with an empty claims array stores/returns claims as null', async () => {
  const created = await store.createShare({
    videoId: 'share-vid-emptyclaims',
    digestMd: 'A digest with an empty claims array.',
    claims: [],
  });
  const share = await store.getShare(created.id);
  assert.ok(share);
  assert.equal(share.claims, null);
});

// ---------------------------------------------------------------------------
// getShare on a missing id
// ---------------------------------------------------------------------------

test('getShare returns null for an id that does not exist', async () => {
  const share = await store.getShare('this-id-does-not-exist');
  assert.equal(share, null);
});

// ---------------------------------------------------------------------------
// deleteShare
// ---------------------------------------------------------------------------

test('deleteShare returns true then getShare returns null; deleteShare on a missing id returns false', async () => {
  const created = await store.createShare({
    videoId: 'share-vid-delete-me',
    digestMd: 'This share will be deleted.',
  });

  // Sanity: it exists before deletion.
  assert.ok(await store.getShare(created.id));

  const deleted = await store.deleteShare(created.id);
  assert.equal(deleted, true);

  const afterDelete = await store.getShare(created.id);
  assert.equal(afterDelete, null);

  // Deleting again (already gone) reports false.
  const deletedAgain = await store.deleteShare(created.id);
  assert.equal(deletedAgain, false);
});

test('deleteShare on an id that never existed returns false', async () => {
  const deleted = await store.deleteShare('never-existed-id-xyz');
  assert.equal(deleted, false);
});
