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
// Two tables. No sessions table (sessions are signed cookies), no tokens table
// (Google is the only provider and we keep nothing of Google's), no API keys
// (they never leave the browser).

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
      google_sub  TEXT NOT NULL UNIQUE,
      email       TEXT,
      createdAt   TEXT NOT NULL
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
  `);
  return db;
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
  const existing = db.prepare('SELECT id, email FROM users WHERE google_sub = ?').get(sub);
  if (existing) {
    // Keep the displayed address current if they changed it at Google.
    if (email && email !== existing.email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, existing.id);
    }
    return { id: existing.id, email: email || existing.email || '' };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, google_sub, email, createdAt) VALUES (?, ?, ?, ?)')
    .run(id, sub, email || null, new Date().toISOString());
  return { id, email: email || '' };
}

/** @returns {{id: string, email: string}|null} */
export function getUser(userId) {
  const row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  return row ? { id: row.id, email: row.email || '' } : null;
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
