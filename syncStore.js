// The only server-side storage a hosted Echo has: who you are, and the library
// that follows you between devices.
//
// Kept entirely separate from store.js. That file is the local/desktop
// single-user library and its routes are blockInWeb'd; this one exists only for
// hosted sync and is keyed by user. Sharing a table between them would have
// meant adding a user column to the local library for the benefit of a mode
// that cannot reach it — and local mode's behaviour is the one thing that must
// not change.
//
// Three tables. No sessions table (sessions are signed cookies) and no API keys
// (they never leave the browser). There IS one credential table now:
// atproto_sessions holds sealed Bluesky refresh tokens, because that provider —
// unlike Google — is one Echo goes on to act through. Nothing of Google's is
// kept, and no password of anyone's ever is.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

let db = null;

/**
 * Open (and create) the sync database. Called lazily by the routes rather than
 * at import time, so a deployment with sync switched off never creates a file
 * and local/desktop never touches this module at all.
 *
 * @param {string} path
 */
export function openSyncDb(path) {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      -- Exactly one of google_sub / did is set, per the provider column. Both are
      -- nullable because a user arrives through one identity provider or the
      -- other, never both; UNIQUE still holds because SQLite treats NULLs as
      -- distinct, so any number of rows may leave either column empty.
      provider    TEXT NOT NULL DEFAULT 'google',
      google_sub  TEXT UNIQUE,
      did         TEXT UNIQUE,
      handle      TEXT,
      email       TEXT,
      createdAt   TEXT NOT NULL,

      -- Approval. Signing in proves who someone is; it does not decide whether
      -- they may use this instance. Everyone lands on 'pending' and an admin
      -- moves them to 'approved' or 'rejected'.
      status          TEXT NOT NULL DEFAULT 'pending',
      motivation      TEXT,   -- why they want access, in their words
      referral_source TEXT,   -- where they found Echo
      contact         TEXT,   -- optional, how to reach them
      requested_at    TEXT,   -- null until they actually submit the form
      decided_at      TEXT,
      decided_by      TEXT,   -- the admin DID that decided
      admin_note      TEXT,
      last_seen       TEXT,   -- throttled; see touchLastSeen()

      -- Mirroring a library into an atproto repo PUBLISHES it, so this is
      -- off until the person says otherwise, per account. Never inferred.
      pds_sync        INTEGER NOT NULL DEFAULT 0,

      -- Bumping this invalidates every session already issued for the account.
      -- It is the one column that buys back what stateless cookies give up:
      -- without it a leaked cookie stays valid for its full 30 days and there
      -- is nothing anyone can do about it. One integer, not a sessions table.
      tokenVersion INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entries (
      userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      videoId   TEXT NOT NULL,
      payload   TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deleted   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, videoId)
    );

    CREATE INDEX IF NOT EXISTS entries_by_updated ON entries(userId, updatedAt);

    -- Bluesky credentials, one row per signed-in account.
    --
    -- Separate from the users table because it is the only one holding a
    -- secret: it
    -- can be emptied to sign everyone out of Bluesky without touching an
    -- account, a library, or an approval decision. refreshJwt is sealed with
    -- ECHO_ATPROTO_SECRET (see atproto.js) and is useless without it.
    CREATE TABLE IF NOT EXISTS atproto_sessions (
      userId     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      did        TEXT NOT NULL,
      pdsUrl     TEXT NOT NULL,
      refreshJwt TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );
  `);

  migrateUsersForAtproto(db);

  migrateUsersForApproval(db);

  // Idempotent migration for databases created before tokenVersion existed.
  // Mirrors store.js's PRAGMA-check + duplicate-column tolerance.
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some((c) => c.name === 'tokenVersion')) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      if (!/duplicate column/i.test(err?.message || '')) throw err;
    }
  }

  return db;
}

/**
 * Bring a pre-Bluesky `users` table up to the current schema.
 *
 * A plain ALTER cannot do this: the original `google_sub` is `NOT NULL`, and
 * SQLite has no way to drop a NOT NULL constraint. The table has to be rebuilt,
 * which is the documented procedure — foreign keys off, swap, keys back on.
 *
 * Fresh databases never reach the rebuild: `CREATE TABLE IF NOT EXISTS` above
 * already created the current shape, so `did` exists and this returns
 * immediately. In practice accounts have never been switched on anywhere, so
 * this path is expected to run against zero real databases — it exists so that
 * the one instance where it does run does not lose a library.
 *
 * @param {import('node:sqlite').DatabaseSync} handle
 */
function migrateUsersForAtproto(handle) {
  const cols = handle.prepare('PRAGMA table_info(users)').all();
  if (cols.some((c) => c.name === 'did')) return;

  // `handle` is shadowed inside the SQL only as a column name; no ambiguity.
  handle.exec('PRAGMA foreign_keys = OFF');
  try {
    handle.exec('BEGIN');
    handle.exec(`
      CREATE TABLE users_new (
        id          TEXT PRIMARY KEY,
        provider    TEXT NOT NULL DEFAULT 'google',
        google_sub  TEXT UNIQUE,
        did         TEXT UNIQUE,
        handle      TEXT,
        email       TEXT,
        createdAt   TEXT NOT NULL,
        tokenVersion INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new (id, provider, google_sub, email, createdAt, tokenVersion)
        SELECT id, 'google', google_sub, email, createdAt, COALESCE(tokenVersion, 0) FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    // Fails the migration rather than committing a database whose entries point
    // at users that no longer exist.
    const orphans = handle.prepare('PRAGMA foreign_key_check').all();
    if (orphans.length) throw new Error(`foreign key check failed after users migration (${orphans.length} rows)`);
    handle.exec('COMMIT');
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    handle.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Add the registration and approval columns.
 *
 * Plain ALTERs, unlike the atproto migration above: every one of these is
 * nullable or has a default, and none of them relaxes a constraint, so the
 * table does not need rebuilding.
 *
 * The subtle part is the backfill. `status` defaults to 'pending' because that
 * is right for everyone who signs up from now on — but applying it to rows that
 * already exist would lock out accounts that predate approval entirely, on an
 * instance whose admin may not even have a UI to unlock them with yet. Anyone
 * already in the table got in before there was a gate, so they are grandfathered
 * to 'approved'. That UPDATE is safe to run unconditionally here because it only
 * executes on the pass that adds the column, when every row is by definition a
 * pre-existing one.
 *
 * @param {import('node:sqlite').DatabaseSync} handle
 */
function migrateUsersForApproval(handle) {
  // Per-COLUMN, not all-or-nothing. An earlier version returned early if
  // `status` existed and then added the whole list — which silently skipped any
  // column introduced later, because by then `status` was always present. A
  // database created between the two releases ended up with `status` and no
  // `last_seen`, and every query naming that column failed. This shape
  // self-heals for the next column too.
  const columns = [
    ['status', "status TEXT NOT NULL DEFAULT 'pending'"],
    ['motivation', 'motivation TEXT'],
    ['referral_source', 'referral_source TEXT'],
    ['contact', 'contact TEXT'],
    ['requested_at', 'requested_at TEXT'],
    ['decided_at', 'decided_at TEXT'],
    ['decided_by', 'decided_by TEXT'],
    ['admin_note', 'admin_note TEXT'],
    ['last_seen', 'last_seen TEXT'],
    ['pds_sync', 'pds_sync INTEGER NOT NULL DEFAULT 0'],
  ];

  const existing = new Set(handle.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  let addedStatus = false;

  for (const [name, spec] of columns) {
    if (existing.has(name)) continue;
    try {
      handle.exec(`ALTER TABLE users ADD COLUMN ${spec}`);
      if (name === 'status') addedStatus = true;
    } catch (err) {
      if (!/duplicate column/i.test(err?.message || '')) throw err;
    }
  }

  // Only when `status` itself was just added: every row present at that moment
  // predates the gate, and locking those people out on an instance whose admin
  // may have no UI to unlock them with would be a self-inflicted outage. Running
  // this on any later pass would silently approve the entire pending queue.
  if (addedStatus) handle.exec("UPDATE users SET status = 'approved'");
}

/** Test seam: drop the handle so a suite can point at a fresh file. */
export function closeSyncDb() {
  if (db) { db.close(); db = null; }
}

/**
 * Find or create the user behind a Google `sub`.
 *
 * The `sub` is the join key, never the email: Google's sub is stable for the
 * life of the account, while an email can be changed and even reassigned. The
 * email is stored only so the UI can say who is signed in.
 *
 * @param {{ sub: string, email?: string }} identity
 * @returns {{ id: string, email: string }}
 */
export function upsertUser({ sub, email }) {
  const existing = db.prepare('SELECT id, email, tokenVersion FROM users WHERE google_sub = ?').get(sub);
  if (existing) {
    // Keep the displayed address current if they changed it at Google.
    if (email && email !== existing.email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, existing.id);
    }
    return { id: existing.id, email: email || existing.email || '', tokenVersion: existing.tokenVersion || 0 };
  }
  const id = randomUUID();
  // Approved on creation, unlike the Bluesky path. The two providers serve two
  // different products: Google sign-in exists for the hosted BYOK web app,
  // where registration is open by design and each library is already isolated
  // per user in this table. Bluesky sign-in exists for a personal instance
  // someone runs on their own machine, which is the one that needs a gate.
  //
  // It is also the only workable answer: ECHO_ADMIN_DIDS is a list of DIDs, and
  // a Google account has none — so a Google-only instance could never have an
  // admin, and gating it would leave every user pending forever with nobody
  // able to approve them.
  db.prepare("INSERT INTO users (id, provider, google_sub, email, createdAt, status) VALUES (?, 'google', ?, ?, ?, 'approved')")
    .run(id, sub, email || null, new Date().toISOString());
  return { id, email: email || '', tokenVersion: 0 };
}

/**
 * Find or create the user behind a Bluesky DID.
 *
 * The DID is the join key, never the handle. Handles are rented: they can be
 * changed at will and released back to the pool, so keying on one would let a
 * later owner of @alice.bsky.social inherit the previous owner's library. The
 * handle is stored for display and refreshed on every sign-in.
 *
 * @param {{ did: string, handle?: string }} identity
 * @returns {{ id: string, did: string, handle: string, tokenVersion: number }}
 */
export function upsertAtprotoUser({ did, handle }) {
  const existing = db.prepare('SELECT id, handle, tokenVersion FROM users WHERE did = ?').get(did);
  if (existing) {
    if (handle && handle !== existing.handle) {
      db.prepare('UPDATE users SET handle = ? WHERE id = ?').run(handle, existing.id);
    }
    return {
      id: existing.id,
      did,
      handle: handle || existing.handle || '',
      tokenVersion: existing.tokenVersion || 0,
    };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, provider, did, handle, createdAt) VALUES (?, \'atproto\', ?, ?, ?)')
    .run(id, did, handle || null, new Date().toISOString());
  return { id, did, handle: handle || '', tokenVersion: 0 };
}

/** @returns {{id, provider, email, did, handle, status, submitted, adminNote, tokenVersion}|null} */
export function getUser(userId) {
  const row = db.prepare(`
    SELECT id, provider, email, did, handle, status, requested_at, admin_note, tokenVersion, pds_sync
    FROM users WHERE id = ?
  `).get(userId);
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider || 'google',
    email: row.email || '',
    did: row.did || '',
    handle: row.handle || '',
    status: row.status || 'pending',
    submitted: Boolean(row.requested_at),
    adminNote: row.admin_note || '',
    pdsSync: row.pds_sync === 1,
    tokenVersion: row.tokenVersion || 0,
  };
}

// ---------------------------------------------------------------------------
// Registration and approval
// ---------------------------------------------------------------------------

/** Longest each free-text field may be. Enough to say something real, bounded
 *  so one submission cannot be used to write a novel into the database. */
const FIELD_LIMITS = { motivation: 2000, referralSource: 200, contact: 200 };

export { FIELD_LIMITS };

/** @returns {{status: string, submitted: boolean, adminNote: string}|null} */
export function getApproval(userId) {
  const row = db.prepare('SELECT status, requested_at, admin_note FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  return {
    status: row.status || 'pending',
    submitted: Boolean(row.requested_at),
    adminNote: row.admin_note || '',
  };
}

/**
 * Record someone's request for access.
 *
 * Re-submittable while pending — someone who realises their first answer was
 * thin should be able to improve it rather than being stuck with it forever.
 * NOT re-submittable once rejected: a decision that can be reopened by the
 * applicant at will is not a decision, and it would turn the admin queue into
 * something anyone could flood.
 *
 * @param {string} userId
 * @param {{motivation: string, referralSource?: string, contact?: string}} form
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function submitRegistration(userId, { motivation, referralSource, contact }) {
  const row = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, reason: 'no_such_user' };
  if (row.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (row.status === 'approved') return { ok: false, reason: 'already_approved' };

  const text = String(motivation || '').trim();
  if (!text) return { ok: false, reason: 'motivation_required' };

  db.prepare(`
    UPDATE users SET motivation = ?, referral_source = ?, contact = ?, requested_at = ?
    WHERE id = ?
  `).run(
    text.slice(0, FIELD_LIMITS.motivation),
    String(referralSource || '').trim().slice(0, FIELD_LIMITS.referralSource) || null,
    String(contact || '').trim().slice(0, FIELD_LIMITS.contact) || null,
    new Date().toISOString(),
    userId
  );
  return { ok: true };
}

/**
 * Approve or reject a request.
 *
 * @param {string} userId
 * @param {{status: 'approved'|'rejected', decidedBy: string, adminNote?: string}} decision
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function decideRegistration(userId, { status, decidedBy, adminNote }) {
  if (status !== 'approved' && status !== 'rejected') return { ok: false, reason: 'bad_status' };
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, reason: 'no_such_user' };

  db.prepare(`
    UPDATE users SET status = ?, decided_at = ?, decided_by = ?, admin_note = ?
    WHERE id = ?
  `).run(
    status,
    new Date().toISOString(),
    String(decidedBy || '').slice(0, 200),
    String(adminNote || '').trim().slice(0, FIELD_LIMITS.motivation) || null,
    userId
  );
  return { ok: true };
}

/**
 * Set a status directly, bypassing the queue. Used to auto-approve admins at
 * sign-in — an instance whose own operator is stuck in the pending queue has
 * nobody left who can approve anyone.
 */
export function setStatus(userId, status) {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
}

/**
 * The admin queue.
 *
 * Paged from the start. A queue is exactly the kind of "everything of a kind"
 * read that has gone wrong seven times in this codebase by being fine at ten
 * rows — and an open instance collects pending rows faster than anything else
 * here, because signing up costs a stranger nothing.
 *
 * @param {{status?: string, limit?: number, offset?: number}} [opts]
 * @returns {{entries: object[], total: number, hasMore: boolean}}
 */
export function listRegistrations({ status = 'pending', limit = 50, offset = 0 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  const from = Math.max(0, Number(offset) || 0);

  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE status = ?').get(status).n) || 0;

  // LEFT JOIN, so a row without stored credentials still appears. hasSession
  // answers "does this account have a working credential", NOT "is this person
  // here right now" — sessions are stateless signed cookies with no table, so
  // nothing on this server knows who has a tab open. Labelling it "online"
  // would be a lie the schema cannot back.
  const rows = db.prepare(`
    SELECT u.id, u.provider, u.did, u.handle, u.email, u.status, u.motivation,
           u.referral_source, u.contact, u.requested_at, u.decided_at, u.decided_by,
           u.admin_note, u.createdAt, u.last_seen,
           (s.userId IS NOT NULL) AS hasSession
    FROM users u
    LEFT JOIN atproto_sessions s ON s.userId = u.id
    WHERE u.status = ?
    ORDER BY COALESCE(u.requested_at, u.createdAt) ASC
    LIMIT ? OFFSET ?
  `).all(status, capped, from);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      provider: r.provider || 'google',
      did: r.did || '',
      handle: r.handle || '',
      email: r.email || '',
      status: r.status,
      motivation: r.motivation || '',
      referralSource: r.referral_source || '',
      contact: r.contact || '',
      requestedAt: r.requested_at || null,
      decidedAt: r.decided_at || null,
      decidedBy: r.decided_by || '',
      adminNote: r.admin_note || '',
      createdAt: r.createdAt,
      lastSeen: r.last_seen || null,
      hasSession: Boolean(r.hasSession),
    })),
    total,
    counts: statusCounts(),
    hasMore: from + rows.length < total,
  };
}

/** How many accounts sit in each status — the admin's at-a-glance figure. */
export function statusCounts() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM users GROUP BY status').all();
  const out = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) out[r.status] = Number(r.n) || 0;
  return out;
}

/**
 * Record that an account was active, at most once every THROTTLE_MS.
 *
 * The naive version writes a row on EVERY authorised request, which puts a
 * SQLite write on the hot path of an app whose whole point is streaming long
 * transcripts. Throttling in memory means the timestamp is accurate to the
 * quarter hour, which is all "last seen" ever needs to be, and the counter
 * resets on restart — losing at most one write per user, which costs nothing.
 *
 * @param {string} userId
 * @param {number} [now]
 */
const lastSeenWrites = new Map();
const LAST_SEEN_THROTTLE_MS = 15 * 60_000;

export function touchLastSeen(userId, now = Date.now()) {
  const previous = lastSeenWrites.get(userId) || 0;
  if (now - previous < LAST_SEEN_THROTTLE_MS) return false;
  lastSeenWrites.set(userId, now);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
  return true;
}

/**
 * End every session for an account and forget its Bluesky credentials.
 *
 * The two halves are both needed: bumping tokenVersion invalidates the signed
 * cookies (which cannot otherwise be revoked before they expire), and dropping
 * the stored refresh token stops the server acting for them afterwards.
 *
 * @param {string} userId
 */
export function forceSignOut(userId) {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, reason: 'no_such_user' };
  db.prepare('UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM atproto_sessions WHERE userId = ?').run(userId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Bluesky credentials
// ---------------------------------------------------------------------------

/**
 * Store (or replace) a user's sealed refresh token.
 *
 * Called on every refresh, not just at sign-in: atproto refresh tokens rotate,
 * so the previous one stops working the moment a new pair is issued. Persist
 * first, use second — the other order loses the session on a crash.
 *
 * @param {{ userId: string, did: string, pdsUrl: string, refreshJwt: string }} spec
 */
export function saveAtprotoTokens({ userId, did, pdsUrl, refreshJwt }) {
  db.prepare(`
    INSERT INTO atproto_sessions (userId, did, pdsUrl, refreshJwt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET
      did = excluded.did,
      pdsUrl = excluded.pdsUrl,
      refreshJwt = excluded.refreshJwt,
      updatedAt = excluded.updatedAt
  `).run(userId, did, pdsUrl, refreshJwt, new Date().toISOString());
}

/** @returns {{did: string, pdsUrl: string, refreshJwt: string}|null} */
export function getAtprotoTokens(userId) {
  const row = db.prepare('SELECT did, pdsUrl, refreshJwt FROM atproto_sessions WHERE userId = ?').get(userId);
  return row ? { did: row.did, pdsUrl: row.pdsUrl, refreshJwt: row.refreshJwt } : null;
}

/** Forget a user's Bluesky credentials without touching their account. */
export function deleteAtprotoTokens(userId) {
  db.prepare('DELETE FROM atproto_sessions WHERE userId = ?').run(userId);
}

/**
 * Invalidate every session issued for this account — "sign out everywhere".
 *
 * @param {string} userId
 * @returns {number} the new token version
 */
export function bumpTokenVersion(userId) {
  db.prepare('UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?').run(userId);
  const row = db.prepare('SELECT tokenVersion FROM users WHERE id = ?').get(userId);
  return row ? row.tokenVersion : 0;
}

/**
 * Everything that changed for this user since `since` (an ISO string), including
 * tombstones.
 *
 * Deletions have to travel: without a tombstone, a device that still holds a
 * deleted entry would push it back on the next sync and it would rise from the
 * dead on every other device.
 *
 * @param {string} userId
 * @param {string} [since] - ISO timestamp; omit for everything
 * @param {number} [limit]
 * @returns {{ entries: object[], serverTime: string }}
 */
export function pullEntries(userId, since, limit = 500) {
  const rows = since
    ? db.prepare('SELECT videoId, payload, updatedAt, deleted FROM entries WHERE userId = ? AND updatedAt > ? ORDER BY updatedAt LIMIT ?').all(userId, since, limit)
    : db.prepare('SELECT videoId, payload, updatedAt, deleted FROM entries WHERE userId = ? ORDER BY updatedAt LIMIT ?').all(userId, limit);

  const entries = rows.map((r) => {
    if (r.deleted) return { videoId: r.videoId, updatedAt: r.updatedAt, deleted: true };
    let payload = null;
    try { payload = JSON.parse(r.payload); } catch { payload = null; }
    return payload
      ? { ...payload, videoId: r.videoId, updatedAt: r.updatedAt, deleted: false }
      : { videoId: r.videoId, updatedAt: r.updatedAt, deleted: true };
  });

  // The cursor must NOT jump to "now" when the page was truncated: the client
  // stores it and asks for everything after it next time, so advancing past
  // rows we never sent loses them permanently and silently. When there is more
  // to come, the cursor is the last row we actually delivered.
  const hasMore = rows.length === limit;
  const serverTime = hasMore && rows.length > 0
    ? rows[rows.length - 1].updatedAt
    : new Date().toISOString();

  return { entries, serverTime, hasMore };
}

/**
 * Apply a batch of client changes. Last write wins, per entry, by `updatedAt`.
 *
 * Chosen over a merge because the conflict it has to survive is one person on
 * two devices, where the later edit is essentially always the one they meant.
 * A CRDT would be the right answer for collaborators, and there are none here.
 *
 * @param {string} userId
 * @param {object[]} entries
 * @returns {{ applied: number, skipped: number }}
 */
export function pushEntries(userId, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const select = db.prepare('SELECT updatedAt FROM entries WHERE userId = ? AND videoId = ?');
  const upsert = db.prepare(`
    INSERT INTO entries (userId, videoId, payload, updatedAt, deleted)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(userId, videoId) DO UPDATE SET
      payload = excluded.payload,
      updatedAt = excluded.updatedAt,
      deleted = excluded.deleted
  `);

  let applied = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const raw of list) {
      const videoId = raw && typeof raw.videoId === 'string' ? raw.videoId.trim() : '';
      if (!videoId || videoId.length > 64) { skipped++; continue; }

      const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt
        ? raw.updatedAt
        : new Date().toISOString();

      const existing = select.get(userId, videoId);
      // Strictly newer wins. Equal timestamps are a no-op, which makes a
      // repeated push idempotent instead of rewriting rows for nothing.
      if (existing && String(existing.updatedAt) >= updatedAt) { skipped++; continue; }

      const deleted = raw.deleted ? 1 : 0;
      const payload = deleted ? '' : JSON.stringify(stripForStorage(raw));
      upsert.run(userId, videoId, payload, updatedAt, deleted);
      applied++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { applied, skipped };
}

/**
 * What actually gets stored for an entry.
 *
 * An allow-list, not a blocklist: a client is free to send extra fields, and
 * storing whatever arrives would mean an old or hostile client could park
 * arbitrary data — including, one day, something that should never have been on
 * the server — in a row we then hand back to every other device.
 */
function stripForStorage(raw) {
  return {
    videoId: raw.videoId,
    url: typeof raw.url === 'string' ? raw.url.slice(0, 2000) : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : null,
    channel: typeof raw.channel === 'string' ? raw.channel.slice(0, 300) : null,
    channelUrl: typeof raw.channelUrl === 'string' ? raw.channelUrl.slice(0, 2000) : null,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    segments: Array.isArray(raw.segments)
      ? raw.segments.slice(0, 20000).map((s) => ({
        text: String((s && s.text) || '').slice(0, 2000),
        offset: Number((s && s.offset) || 0),
      }))
      : [],
    digest: typeof raw.digest === 'string' ? raw.digest : null,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 20).map((t) => String(t).slice(0, 40)) : [],
    transcriptSource: typeof raw.transcriptSource === 'string' ? raw.transcriptSource : null,
    whisperModel: typeof raw.whisperModel === 'string' ? raw.whisperModel : null,
  };
}

/** Rough per-user footprint, for the storage guard in the push route. */
export function userBytes(userId) {
  const row = db.prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM entries WHERE userId = ?').get(userId);
  return Number(row.bytes) || 0;
}

/** Wipe a user and everything of theirs. The account-deletion path. */
export function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return true;
}

/**
 * Turn repository mirroring on or off for one account.
 *
 * Per account and default OFF, because mirroring PUBLISHES a library: atproto
 * records and their blobs are readable by anyone with no credentials, and they
 * cross the firehose on write, so a later delete removes your copy and not
 * anyone else's. An app password is consent for Echo to act on an account. It
 * is not consent to publish a reading history, and nothing may infer one from
 * the other.
 *
 * @param {string} userId
 * @param {boolean} on
 */
export function setPdsSync(userId, on) {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, reason: 'no_such_user' };
  db.prepare('UPDATE users SET pds_sync = ? WHERE id = ?').run(on ? 1 : 0, userId);
  return { ok: true, enabled: Boolean(on) };
}

/** Is mirroring switched on for this account? */
export function getPdsSync(userId) {
  const row = db.prepare('SELECT pds_sync FROM users WHERE id = ?').get(userId);
  return row ? row.pds_sync === 1 : false;
}
