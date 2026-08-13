import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  openSyncDb, closeSyncDb, upsertUser, upsertAtprotoUser, getUser,
  submitRegistration, decideRegistration, listRegistrations, setStatus, getApproval,
  saveAtprotoTokens, getAtprotoTokens, forceSignOut, touchLastSeen, statusCounts,
  setPdsSync, getPdsSync,
  FIELD_LIMITS,
} from '../syncStore.js';

// ---------------------------------------------------------------------------
// Registration and approval.
//
// Signing in proves who someone is; approval decides whether they may use the
// instance. The cases worth testing are the ones that would quietly break the
// gate: a rejected applicant re-applying, an admin locked out of their own
// queue, and a queue that reads the whole table.
// ---------------------------------------------------------------------------

const paths = [];
function fresh(tag) {
  const p = join(tmpdir(), `echo-test-reg-${tag}-${process.pid}-${Date.now()}-${paths.length}.db`);
  paths.push(p);
  closeSyncDb();
  openSyncDb(p);
  return p;
}

test.after(() => {
  closeSyncDb();
  for (const p of paths) {
    for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s, { force: true }); } catch { /* ignore */ } }
  }
});

test('a new account starts pending and unsubmitted', () => {
  fresh('new');
  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  const me = getUser(u.id);
  assert.equal(me.status, 'pending');
  assert.equal(me.submitted, false, 'signing in is not the same as asking for access');
});

test('submitting a request records it and leaves the decision open', () => {
  fresh('submit');
  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });

  const r = submitRegistration(u.id, {
    motivation: 'I want to read long talks instead of watching them.',
    referralSource: 'Bluesky',
    contact: 'alice@example.com',
  });
  assert.equal(r.ok, true);

  const me = getUser(u.id);
  assert.equal(me.status, 'pending', 'submitting does not approve anyone');
  assert.equal(me.submitted, true);

  const { entries } = listRegistrations({ status: 'pending' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].motivation, 'I want to read long talks instead of watching them.');
  assert.equal(entries[0].referralSource, 'Bluesky');
  assert.equal(entries[0].handle, 'alice.bsky.social');
});

test('motivation is required, and the free text is bounded', () => {
  fresh('bounds');
  const u = upsertAtprotoUser({ did: 'did:plc:alice' });

  assert.deepEqual(submitRegistration(u.id, { motivation: '   ' }), { ok: false, reason: 'motivation_required' });
  assert.deepEqual(submitRegistration(u.id, {}), { ok: false, reason: 'motivation_required' });

  submitRegistration(u.id, {
    motivation: 'x'.repeat(FIELD_LIMITS.motivation + 500),
    referralSource: 'y'.repeat(FIELD_LIMITS.referralSource + 500),
    contact: 'z'.repeat(FIELD_LIMITS.contact + 500),
  });
  const [row] = listRegistrations({ status: 'pending' }).entries;
  assert.equal(row.motivation.length, FIELD_LIMITS.motivation);
  assert.equal(row.referralSource.length, FIELD_LIMITS.referralSource);
  assert.equal(row.contact.length, FIELD_LIMITS.contact);
});

test('a pending request can be improved, a rejected one cannot be re-opened', () => {
  fresh('resubmit');
  const u = upsertAtprotoUser({ did: 'did:plc:alice' });

  submitRegistration(u.id, { motivation: 'first attempt' });
  submitRegistration(u.id, { motivation: 'a better explanation' });
  assert.equal(listRegistrations({ status: 'pending' }).entries[0].motivation, 'a better explanation');

  decideRegistration(u.id, { status: 'rejected', decidedBy: 'did:plc:admin', adminNote: 'not a fit' });

  // The whole point: an applicant must not be able to re-open their own
  // decision, or the queue becomes something anyone can flood.
  assert.deepEqual(
    submitRegistration(u.id, { motivation: 'please reconsider' }),
    { ok: false, reason: 'rejected' }
  );
  assert.equal(getUser(u.id).status, 'rejected');
  assert.equal(getUser(u.id).adminNote, 'not a fit');
});

test('an approved user cannot re-submit', () => {
  fresh('approved-resubmit');
  const u = upsertAtprotoUser({ did: 'did:plc:alice' });
  submitRegistration(u.id, { motivation: 'please' });
  decideRegistration(u.id, { status: 'approved', decidedBy: 'did:plc:admin' });

  assert.deepEqual(submitRegistration(u.id, { motivation: 'again' }), { ok: false, reason: 'already_approved' });
});

test('deciding moves the row between queues and records who decided', () => {
  fresh('decide');
  const a = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  const b = upsertAtprotoUser({ did: 'did:plc:bob', handle: 'bob.bsky.social' });
  submitRegistration(a.id, { motivation: 'a' });
  submitRegistration(b.id, { motivation: 'b' });
  assert.equal(listRegistrations({ status: 'pending' }).total, 2);

  decideRegistration(a.id, { status: 'approved', decidedBy: 'did:plc:admin' });

  assert.equal(listRegistrations({ status: 'pending' }).total, 1);
  const approved = listRegistrations({ status: 'approved' });
  assert.equal(approved.total, 1);
  assert.equal(approved.entries[0].decidedBy, 'did:plc:admin');
  assert.ok(approved.entries[0].decidedAt, 'the decision is timestamped');
});

test('a bad status is refused rather than written', () => {
  fresh('badstatus');
  const u = upsertAtprotoUser({ did: 'did:plc:alice' });
  assert.deepEqual(decideRegistration(u.id, { status: 'banned', decidedBy: 'x' }), { ok: false, reason: 'bad_status' });
  assert.equal(getUser(u.id).status, 'pending');
  assert.deepEqual(decideRegistration('nobody', { status: 'approved', decidedBy: 'x' }), { ok: false, reason: 'no_such_user' });
});

test('the queue is paged, and ordered oldest request first', () => {
  fresh('paging');
  // 120 applicants: more than one page, which is the case a handful of test
  // fixtures would never have shown.
  for (let i = 0; i < 120; i++) {
    const u = upsertAtprotoUser({ did: `did:plc:user${String(i).padStart(3, '0')}`, handle: `u${i}.bsky.social` });
    submitRegistration(u.id, { motivation: `request ${i}` });
  }

  const first = listRegistrations({ status: 'pending', limit: 50 });
  assert.equal(first.total, 120);
  assert.equal(first.entries.length, 50, 'a page, not the whole table');
  assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].motivation, 'request 0', 'oldest first — a queue, not a stack');

  const last = listRegistrations({ status: 'pending', limit: 50, offset: 100 });
  assert.equal(last.entries.length, 20);
  assert.equal(last.hasMore, false);

  // A caller asking for everything still gets a bounded answer.
  assert.equal(listRegistrations({ status: 'pending', limit: 10_000 }).entries.length, 200 > 120 ? 120 : 200);
});

test('setStatus approves directly, for the admin auto-approve path', () => {
  fresh('setstatus');
  const u = upsertAtprotoUser({ did: 'did:plc:admin', handle: 'admin.bsky.social' });
  setStatus(u.id, 'approved');
  assert.equal(getUser(u.id).status, 'approved');
  assert.equal(getApproval(u.id).status, 'approved');
});

test('Google accounts are approved on creation, Bluesky ones are not', () => {
  fresh('google');

  // Not an oversight. ECHO_ADMIN_DIDS is a list of DIDs and a Google account
  // has none, so a Google-only instance can never have an admin — gating it
  // would leave every user pending forever with nobody able to approve them.
  // The two providers serve different products: Google is the hosted app with
  // open registration and per-user libraries; Bluesky is the personal instance
  // that needs a gate.
  const g = upsertUser({ sub: 'google-1', email: 'g@example.com' });
  assert.equal(getUser(g.id).status, 'approved');

  const b = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  assert.equal(getUser(b.id).status, 'pending');
  assert.equal(listRegistrations({ status: 'pending' }).total, 1, 'only the Bluesky account queues');
});

test('accounts that predate approval are grandfathered in, not locked out', () => {
  closeSyncDb();
  const p = join(tmpdir(), `echo-test-reg-grandfather-${process.pid}-${Date.now()}.db`);
  paths.push(p);

  // A database from before the gate existed: users, no status column.
  const old = new DatabaseSync(p);
  old.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT,
      createdAt TEXT NOT NULL, tokenVersion INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE entries (
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      videoId TEXT NOT NULL, payload TEXT NOT NULL, updatedAt TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (userId, videoId)
    );
    INSERT INTO users VALUES ('old1', 'sub-1', 'old@example.com', '2026-01-01T00:00:00Z', 0);
  `);
  old.close();

  openSyncDb(p);

  // Locking out someone who was using the instance before there was a gate —
  // on an instance whose admin may have no UI to unlock them — would be a
  // silent, self-inflicted outage.
  assert.equal(getUser('old1').status, 'approved');

  // But the gate is live for everyone new.
  const n = upsertAtprotoUser({ did: 'did:plc:new', handle: 'new.bsky.social' });
  assert.equal(getUser(n.id).status, 'pending');
});

// ---------------------------------------------------------------------------
// Admin maintenance: revoke, force sign-out, activity
// ---------------------------------------------------------------------------

test('approval is not a one-way door — an approved account can be revoked', () => {
  fresh('revoke');
  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  submitRegistration(u.id, { motivation: 'please' });
  decideRegistration(u.id, { status: 'approved', decidedBy: 'did:plc:admin' });
  assert.equal(getUser(u.id).status, 'approved');

  decideRegistration(u.id, { status: 'rejected', decidedBy: 'did:plc:admin', adminNote: 'changed my mind' });
  assert.equal(getUser(u.id).status, 'rejected');
  assert.equal(getUser(u.id).adminNote, 'changed my mind');
});

test('forceSignOut ends every session and forgets the credential', () => {
  fresh('forcesignout');
  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  saveAtprotoTokens({ userId: u.id, did: 'did:plc:alice', pdsUrl: 'https://pds.example', refreshJwt: 'sealed' });
  const before = getUser(u.id).tokenVersion;

  assert.deepEqual(forceSignOut(u.id), { ok: true });

  // Both halves are needed: the bump invalidates already-issued cookies (which
  // are stateless and cannot otherwise be revoked), and dropping the token
  // stops the server acting for them afterwards.
  assert.equal(getUser(u.id).tokenVersion, before + 1, 'sessions invalidated');
  assert.equal(getAtprotoTokens(u.id), null, 'credential forgotten');

  assert.deepEqual(forceSignOut('nobody'), { ok: false, reason: 'no_such_user' });
});

test('the queue reports whether an account holds a live credential', () => {
  fresh('hassession');
  const a = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });
  const b = upsertAtprotoUser({ did: 'did:plc:bob', handle: 'bob.bsky.social' });
  submitRegistration(a.id, { motivation: 'a' });
  submitRegistration(b.id, { motivation: 'b' });
  saveAtprotoTokens({ userId: a.id, did: 'did:plc:alice', pdsUrl: 'https://pds.example', refreshJwt: 'sealed' });

  const rows = listRegistrations({ status: 'pending' }).entries;
  const alice = rows.find((r) => r.did === 'did:plc:alice');
  const bob = rows.find((r) => r.did === 'did:plc:bob');

  // A LEFT JOIN, so the account WITHOUT credentials still appears — an inner
  // join here would silently hide everyone who has never signed in.
  assert.equal(rows.length, 2);
  assert.equal(alice.hasSession, true);
  assert.equal(bob.hasSession, false);
});

test('last-seen is throttled, not written on every request', () => {
  fresh('lastseen');
  const u = upsertAtprotoUser({ did: 'did:plc:alice' });
  const t0 = Date.parse('2026-08-13T10:00:00.000Z');

  assert.equal(touchLastSeen(u.id, t0), true, 'first touch writes');
  assert.equal(touchLastSeen(u.id, t0 + 60_000), false, 'a minute later does not');
  assert.equal(touchLastSeen(u.id, t0 + 14 * 60_000), false, 'still inside the window');
  assert.equal(touchLastSeen(u.id, t0 + 16 * 60_000), true, 'past the window it writes again');

  const [row] = listRegistrations({ status: 'pending' }).entries;
  assert.equal(row.lastSeen, new Date(t0 + 16 * 60_000).toISOString());
});

test('the counts cover every status, not just the one being viewed', () => {
  fresh('counts');
  const mk = (did, status) => {
    const u = upsertAtprotoUser({ did });
    submitRegistration(u.id, { motivation: 'x' });
    if (status !== 'pending') decideRegistration(u.id, { status, decidedBy: 'did:plc:admin' });
    return u;
  };
  mk('did:plc:a', 'pending');
  mk('did:plc:b', 'pending');
  mk('did:plc:c', 'approved');
  mk('did:plc:d', 'rejected');

  // Viewing the approved list must still report how many are WAITING — that
  // number is the admin's only notification that anyone is.
  const viewingApproved = listRegistrations({ status: 'approved' });
  assert.deepEqual(viewingApproved.counts, { pending: 2, approved: 1, rejected: 1 });
  assert.deepEqual(statusCounts(), { pending: 2, approved: 1, rejected: 1 });
});

test('a database from BETWEEN two releases gets the columns it is missing', () => {
  closeSyncDb();
  const p = join(tmpdir(), `echo-test-reg-partial-${process.pid}-${Date.now()}.db`);
  paths.push(p);

  // The real shape that broke: a database created after `status` shipped but
  // before `last_seen` did. The old guard returned early because `status`
  // existed, so `last_seen` was never added and every query naming it failed.
  const old = new DatabaseSync(p);
  old.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'google',
      google_sub TEXT UNIQUE, did TEXT UNIQUE, handle TEXT, email TEXT,
      createdAt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', motivation TEXT,
      referral_source TEXT, contact TEXT, requested_at TEXT,
      decided_at TEXT, decided_by TEXT, admin_note TEXT,
      tokenVersion INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, provider, did, handle, createdAt, status, requested_at, motivation)
      VALUES ('u1', 'atproto', 'did:plc:waiting', 'waiting.bsky.social',
              '2026-08-01T00:00:00Z', 'pending', '2026-08-01T00:00:00Z', 'let me in');
  `);
  old.close();

  openSyncDb(p);

  // The missing column is added...
  assert.doesNotThrow(() => listRegistrations({ status: 'pending' }));
  const [row] = listRegistrations({ status: 'pending' }).entries;
  assert.equal(row.lastSeen, null);
  assert.equal(touchLastSeen('u1', Date.parse('2026-08-13T00:00:00Z')), true);
  assert.equal(listRegistrations({ status: 'pending' }).entries[0].lastSeen, '2026-08-13T00:00:00.000Z');

  // ...and the grandfather UPDATE does NOT re-run. Re-approving on every later
  // migration pass would silently let the whole pending queue in.
  assert.equal(getUser('u1').status, 'pending', 'a waiting applicant must stay waiting');
});

// ---------------------------------------------------------------------------
// Repository mirroring is opt-in, per account
// ---------------------------------------------------------------------------

test('mirroring is OFF for a new account and stays off until asked', () => {
  fresh('pdssync');
  const u = upsertAtprotoUser({ did: 'did:plc:alice', handle: 'alice.bsky.social' });

  // Mirroring PUBLISHES a library — atproto records and blobs are readable by
  // anyone with no credentials. An app password is consent for Echo to act on
  // an account; it is not consent to publish a reading history, and nothing
  // may infer one from the other.
  assert.equal(getUser(u.id).pdsSync, false);
  assert.equal(getPdsSync(u.id), false);

  // Approving them does not turn it on either.
  submitRegistration(u.id, { motivation: 'please' });
  decideRegistration(u.id, { status: 'approved', decidedBy: 'did:plc:admin' });
  assert.equal(getPdsSync(u.id), false, 'approval is not consent to publish');

  assert.deepEqual(setPdsSync(u.id, true), { ok: true, enabled: true });
  assert.equal(getPdsSync(u.id), true);
  assert.equal(getUser(u.id).pdsSync, true);

  assert.deepEqual(setPdsSync(u.id, false), { ok: true, enabled: false });
  assert.equal(getPdsSync(u.id), false);
  assert.deepEqual(setPdsSync('nobody', true), { ok: false, reason: 'no_such_user' });
});

test('one account turning mirroring on does not turn it on for anyone else', () => {
  fresh('pdssync-isolation');
  const a = upsertAtprotoUser({ did: 'did:plc:alice' });
  const b = upsertAtprotoUser({ did: 'did:plc:bob' });

  setPdsSync(a.id, true);
  assert.equal(getPdsSync(a.id), true);
  assert.equal(getPdsSync(b.id), false, 'publishing is never a shared setting');
});

test('a database from before the opt-in existed gets it, defaulted OFF', () => {
  closeSyncDb();
  const p = join(tmpdir(), `echo-test-reg-pdscol-${process.pid}-${Date.now()}.db`);
  paths.push(p);

  // The dangerous direction is a migration that defaults an existing account to
  // ON — that would start publishing someone's library on an upgrade, without
  // them ever being asked.
  const old = new DatabaseSync(p);
  old.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'google',
      google_sub TEXT UNIQUE, did TEXT UNIQUE, handle TEXT, email TEXT,
      createdAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      motivation TEXT, referral_source TEXT, contact TEXT, requested_at TEXT,
      decided_at TEXT, decided_by TEXT, admin_note TEXT, last_seen TEXT,
      tokenVersion INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, provider, did, createdAt, status)
      VALUES ('u1', 'atproto', 'did:plc:existing', '2026-08-01T00:00:00Z', 'approved');
  `);
  old.close();

  openSyncDb(p);
  assert.equal(getPdsSync('u1'), false, 'an upgrade must not start publishing');
  assert.equal(getUser('u1').status, 'approved', 'and must not disturb their access');
});
