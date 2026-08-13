import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  openSyncDb, closeSyncDb, upsertUser, upsertAtprotoUser, getUser,
  saveAtprotoTokens, getAtprotoTokens, deleteAtprotoTokens, pushEntries, pullEntries, deleteUser,
} from '../syncStore.js';

// ---------------------------------------------------------------------------
// Bluesky accounts in the sync database.
//
// Two things here are worth more than the CRUD: that the DID rather than the
// handle is the identity (handles are rented and get reassigned), and that a
// database created before this provider existed survives the schema change with
// its libraries intact — `google_sub` was NOT NULL, which SQLite cannot relax
// without rebuilding the table.
// ---------------------------------------------------------------------------

const paths = [];
function freshPath(tag) {
  const p = join(tmpdir(), `echo-test-atp-${tag}-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  return p;
}

test.after(() => {
  closeSyncDb();
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(p + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
});

test('creates and finds a user by DID', () => {
  openSyncDb(freshPath('basic'));

  const a = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  assert.ok(a.id);
  assert.equal(a.did, 'did:plc:alice');

  const again = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  assert.equal(again.id, a.id, 'the same DID is the same account');

  const stored = getUser(a.id);
  assert.equal(stored.provider, 'atproto');
  assert.equal(stored.handle, 'alice.bsky.social');
  assert.equal(stored.email, '', 'a Bluesky account has no email here');
});

test('a renamed handle updates in place; a reused handle does not steal the account', () => {
  closeSyncDb();
  openSyncDb(freshPath('handles'));

  const alice = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  pushEntries(alice.id, [{ videoId: 'v1', payload: { videoId: 'v1', title: 'Alice video' }, updatedAt: '2026-01-01T00:00:00Z' }]);

  // Alice renames herself. Same account, new display handle.
  const renamed = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.example.com' });
  assert.equal(renamed.id, alice.id);
  assert.equal(getUser(alice.id).handle, 'alice.example.com');

  // Someone else takes the handle Alice released. Different DID, so it must be
  // a different account with a different library — this is the whole reason the
  // DID is the join key.
  const impostor = upsertAtprotoUser({ did: 'did:plc:bob', handle: 'alice.bsky.social' });
  assert.notEqual(impostor.id, alice.id);
  assert.equal(pullEntries(impostor.id).entries.length, 0, 'must not inherit the previous holder\'s library');
  assert.equal(pullEntries(alice.id).entries.length, 1);
});

test('Google and Bluesky accounts coexist', () => {
  closeSyncDb();
  openSyncDb(freshPath('mixed'));

  const g = upsertUser({ sub: 'google-123', email: 'g@example.com' });
  const b = upsertAtprotoUser({ did: 'did:plc:bee', handle: 'bee.bsky.social' });

  assert.notEqual(g.id, b.id);
  assert.equal(getUser(g.id).provider, 'google');
  assert.equal(getUser(b.id).provider, 'atproto');

  // Both leave the other's identity column NULL, which UNIQUE must tolerate
  // across any number of rows.
  const b2 = upsertAtprotoUser({ did: 'did:plc:cee', handle: 'cee.bsky.social' });
  const g2 = upsertUser({ sub: 'google-456', email: 'g2@example.com' });
  assert.equal(new Set([g.id, b.id, b2.id, g2.id]).size, 4);
});

test('stores, replaces and forgets sealed tokens', () => {
  closeSyncDb();
  openSyncDb(freshPath('tokens'));

  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  assert.equal(getAtprotoTokens(u.id), null);

  saveAtprotoTokens({ userId: u.id, did: 'did:plc:alice', pdsUrl: 'https://pds.example.com', refreshJwt: 'sealed-1' });
  assert.equal(getAtprotoTokens(u.id).refreshJwt, 'sealed-1');

  // Refresh tokens rotate, so overwriting in place is the normal path.
  saveAtprotoTokens({ userId: u.id, did: 'did:plc:alice', pdsUrl: 'https://pds.example.com', refreshJwt: 'sealed-2' });
  assert.equal(getAtprotoTokens(u.id).refreshJwt, 'sealed-2');

  deleteAtprotoTokens(u.id);
  assert.equal(getAtprotoTokens(u.id), null, 'sign-out leaves no live credential behind');
});

test('deleting an account takes its credentials with it', () => {
  closeSyncDb();
  openSyncDb(freshPath('cascade'));

  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  saveAtprotoTokens({ userId: u.id, did: 'did:plc:alice', pdsUrl: 'https://pds.example.com', refreshJwt: 'sealed' });

  deleteUser(u.id);
  assert.equal(getAtprotoTokens(u.id), null, 'ON DELETE CASCADE must reach the credential table');
});

test('migrates a database created before Bluesky sign-in existed', () => {
  closeSyncDb();
  const path = freshPath('migrate');

  // The exact pre-Bluesky schema, including the NOT NULL that forces a rebuild.
  const old = new DatabaseSync(path);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id          TEXT PRIMARY KEY,
      google_sub  TEXT NOT NULL UNIQUE,
      email       TEXT,
      createdAt   TEXT NOT NULL,
      tokenVersion INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE entries (
      userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      videoId   TEXT NOT NULL,
      payload   TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deleted   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, videoId)
    );
    INSERT INTO users (id, google_sub, email, createdAt, tokenVersion)
      VALUES ('u1', 'google-sub-1', 'old@example.com', '2026-01-01T00:00:00Z', 3);
    INSERT INTO entries (userId, videoId, payload, updatedAt)
      VALUES ('u1', 'v1', '{"videoId":"v1","title":"Kept"}', '2026-01-01T00:00:00Z');
  `);
  old.close();

  openSyncDb(path);

  // The existing account survives whole — including tokenVersion, which is what
  // keeps already-issued sessions valid across the upgrade.
  const user = getUser('u1');
  assert.equal(user.email, 'old@example.com');
  assert.equal(user.provider, 'google');
  assert.equal(user.tokenVersion, 3);

  // And so does its library: the rebuild drops and recreates `users`, so a
  // mistake here would cascade every entry away.
  assert.equal(pullEntries('u1').entries.length, 1, 'the library must survive the table rebuild');

  // The new provider works against the migrated table.
  const b = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  assert.equal(getUser(b.id).provider, 'atproto');

  // Re-opening must not migrate a second time.
  closeSyncDb();
  openSyncDb(path);
  assert.equal(getUser('u1').email, 'old@example.com');
  assert.equal(pullEntries('u1').entries.length, 1);
});
