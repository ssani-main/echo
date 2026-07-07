// Node 24 ships a built-in synchronous SQLite module — no native build needed.
// API mirrors better-sqlite3 closely: DatabaseSync, StatementSync, transaction().
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeHttpUrl } from './sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_FILE     = process.env.ECHO_DB_PATH || join(__dirname, 'data', 'library.db');
const DATA_DIR    = dirname(DB_FILE);
const LEGACY_JSON = join(DATA_DIR, 'library.json');

// Ensure the data directory exists before opening the DB file.
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

// Enable WAL mode and FK enforcement via plain PRAGMA SQL (node:sqlite has no
// separate pragma() method; exec() runs any SQL statement directly).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    videoId   TEXT PRIMARY KEY,
    url       TEXT NOT NULL,
    title     TEXT,
    savedAt   TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    segments  TEXT NOT NULL DEFAULT '[]',
    digest    TEXT,
    favorite  INTEGER NOT NULL DEFAULT 0,
    segment_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tags (
    videoId TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    UNIQUE(videoId, tag)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    videoId UNINDEXED,
    title,
    transcript_text,
    digest
  );

  CREATE TABLE IF NOT EXISTS follows (
    channelId     TEXT PRIMARY KEY,
    title         TEXT,
    url           TEXT NOT NULL,
    addedAt       TEXT NOT NULL,
    lastCheckedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS follow_seen (
    channelId TEXT NOT NULL,
    videoId   TEXT NOT NULL,
    seenAt    TEXT NOT NULL,
    UNIQUE(channelId, videoId)
  );

  CREATE INDEX IF NOT EXISTS idx_follow_seen_channel ON follow_seen(channelId);
`);

// ---------------------------------------------------------------------------
// One-time migration: add segment_count column to pre-existing DBs and
// backfill it from the segments JSON so listEntries() never has to parse
// the full transcript just to report a count. Idempotent: skips entirely
// once the column exists (guards against duplicate-column errors from
// concurrent processes touching the same DB file).
// ---------------------------------------------------------------------------

(function migrateSegmentCount() {
  const cols = db.prepare('PRAGMA table_info(videos)').all();
  const hasCol = cols.some((c) => c.name === 'segment_count');
  if (hasCol) return; // Already migrated (or created fresh with the column above)

  try {
    db.exec('ALTER TABLE videos ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    // Tolerate a race where another process added the column concurrently.
    if (!/duplicate column/i.test(err?.message || '')) throw err;
    return;
  }

  // Backfill existing rows (added before this column existed) once.
  const rows = db.prepare('SELECT videoId, segments FROM videos').all();
  const updateCount = db.prepare('UPDATE videos SET segment_count = ? WHERE videoId = ?');
  for (const row of rows) {
    let n = 0;
    try { n = JSON.parse(row.segments || '[]').length; } catch { n = 0; }
    updateCount.run(n, row.videoId);
  }
})();

// ---------------------------------------------------------------------------
// Internal DB helpers
// ---------------------------------------------------------------------------

/**
 * Reassemble a full normalized entry object from the four DB tables.
 * Returns null if the videoId does not exist in the videos table.
 */
function fetchFullEntry(videoId) {
  const row = db.prepare('SELECT * FROM videos WHERE videoId = ?').get(videoId);
  if (!row) return null;

  const tags = db.prepare(
    'SELECT tag FROM tags WHERE videoId = ? ORDER BY rowid'
  ).all(videoId);

  return {
    videoId:    row.videoId,
    url:        row.url,
    title:      row.title,
    savedAt:    row.savedAt,
    updatedAt:  row.updatedAt,
    segments:   JSON.parse(row.segments || '[]'),
    digest:     row.digest ?? null,
    favorite:   row.favorite === 1,
    tags:       tags.map((t) => t.tag),
  };
}

/**
 * Map a full entry to its metadata-only representation.
 * Identical logic to the original store.js toMeta().
 */
function toMeta(entry) {
  return {
    videoId:        entry.videoId,
    url:            entry.url,
    title:          entry.title,
    savedAt:        entry.savedAt,
    hasDigest:      !!entry.digest,
    segmentCount:   entry.segments?.length || 0,
    tags:           Array.isArray(entry.tags)       ? entry.tags             : [],
    favorite:       typeof entry.favorite === 'boolean' ? entry.favorite     : false,
  };
}

/**
 * (Re)populate the FTS5 row for a given videoId from the videos table.
 * Called after every write that may affect title, segments, or digest.
 */
function syncFts(videoId) {
  const row = db.prepare(
    'SELECT title, segments, digest FROM videos WHERE videoId = ?'
  ).get(videoId);
  if (!row) return;

  const transcriptText = JSON.parse(row.segments || '[]')
    .map((s) => s.text || '')
    .join(' ');

  db.prepare('DELETE FROM videos_fts WHERE videoId = ?').run(videoId);
  db.prepare(
    'INSERT INTO videos_fts(videoId, title, transcript_text, digest) VALUES (?, ?, ?, ?)'
  ).run(videoId, row.title ?? '', transcriptText, row.digest ?? '');
}

// ---------------------------------------------------------------------------
// One-time migration from library.json → SQLite
// Runs synchronously at module load; idempotent (skips if videos table is
// already populated). Does NOT delete library.json (left as backup).
// ---------------------------------------------------------------------------

(function migrate() {
  if (process.env.ECHO_DB_PATH) return;
  const count = db.prepare('SELECT COUNT(*) as n FROM videos').get().n;
  if (count > 0) return; // Already populated — nothing to migrate
  if (!existsSync(LEGACY_JSON)) return;

  let entries;
  try {
    const raw = readFileSync(LEGACY_JSON, 'utf8');
    entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) return;
  } catch {
    return; // Corrupt / unreadable — skip silently
  }

  const insertVideo = db.prepare(`
    INSERT OR IGNORE INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, favorite, segment_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)'
  );

  // node:sqlite's DatabaseSync has no transaction() wrapper — use raw SQL.
  let migrated = 0;
  db.exec('BEGIN');
  try {
    for (const entry of entries) {
      if (!entry.videoId) continue;

      insertVideo.run(
        entry.videoId,
        entry.url       ?? '',
        entry.title     ?? null,
        entry.savedAt   ?? new Date().toISOString(),
        entry.updatedAt ?? new Date().toISOString(),
        JSON.stringify(entry.segments || []),
        entry.digest    ?? null,
        entry.favorite  ? 1 : 0,
        Array.isArray(entry.segments) ? entry.segments.length : 0,
      );

      // Tags — dedup + cap at 20, matching setTags sanitization
      const rawTags = Array.isArray(entry.tags) ? entry.tags : [];
      const sanitizedTags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
      for (const tag of sanitizedTags) {
        insertTag.run(entry.videoId, tag);
      }

      syncFts(entry.videoId);
      migrated++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[store] Migration failed, rolled back:', err.message);
    return;
  }

  console.log(`[store] Migrated ${migrated} entr${migrated === 1 ? 'y' : 'ies'} from library.json to SQLite.`);
})();

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Return metadata for all saved entries, sorted by savedAt descending (newest first).
 * Uses batch queries to avoid N+1 round-trips.
 */
export async function listEntries() {
  const rows = db.prepare('SELECT * FROM videos ORDER BY savedAt DESC').all();

  // Batch-load related data in three queries instead of N per-video lookups
  const allTags        = db.prepare('SELECT videoId, tag FROM tags ORDER BY videoId, rowid').all();

  /** @type {Record<string, string[]>} */
  const tagsByVideo = {};
  for (const t of allTags) {
    if (!tagsByVideo[t.videoId]) tagsByVideo[t.videoId] = [];
    tagsByVideo[t.videoId].push(t.tag);
  }

  return rows.map((row) => ({
    videoId:        row.videoId,
    url:            row.url,
    title:          row.title,
    savedAt:        row.savedAt,
    hasDigest:      !!row.digest,
    segmentCount:   row.segment_count || 0,
    tags:           tagsByVideo[row.videoId]       || [],
    favorite:       row.favorite === 1,
  }));
}

/**
 * Return the full normalized entry object for a given videoId, or null if not found.
 */
export async function getEntry(videoId) {
  return fetchFullEntry(videoId);
}

/**
 * Upsert an entry by videoId.
 * Preserves existing digest, tags, favorite when the
 * incoming payload omits them.
 * Returns the metadata object for the saved entry.
 */
export async function saveEntry({ url, videoId, title, segments, digest, tags, favorite }) {
  const now      = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM videos WHERE videoId = ?').get(videoId);
  const safeUrl  = safeHttpUrl(url);

  if (!existing) {
    // ---- New entry --------------------------------------------------------
    db.prepare(`
      INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, favorite, segment_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      safeUrl,
      title  || null,
      now, now,
      JSON.stringify(segments || []),
      digest || null,
      typeof favorite === 'boolean' ? (favorite ? 1 : 0) : 0,
      Array.isArray(segments) ? segments.length : 0,
    );

    const initTags = Array.isArray(tags) ? tags : [];
    for (const tag of [...new Set(initTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)) {
      db.prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
    }
  } else {
    // ---- Existing entry — preserve savedAt and extension fields not in payload ----
    const keepDigest   = digest   ? digest   : existing.digest;
    const keepFavorite = typeof favorite === 'boolean' ? (favorite ? 1 : 0) : existing.favorite;

    db.prepare(`
      UPDATE videos
      SET url = ?, title = ?, updatedAt = ?, segments = ?, digest = ?, favorite = ?, segment_count = ?
      WHERE videoId = ?
    `).run(
      url != null ? safeUrl : existing.url,
      title || null,
      now,
      JSON.stringify(segments || []),
      keepDigest,
      keepFavorite,
      Array.isArray(segments) ? segments.length : 0,
      videoId,
    );

    // Replace tags only if a tags array was explicitly provided
    if (Array.isArray(tags)) {
      const sanitized = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
      db.prepare('DELETE FROM tags WHERE videoId = ?').run(videoId);
      for (const tag of sanitized) {
        db.prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
      }
    }
  }

  syncFts(videoId);

  return toMeta(fetchFullEntry(videoId));
}

/**
 * Remove the entry with the given videoId.
 * Returns true if an entry was removed, false if it wasn't found.
 */
export async function deleteEntry(videoId) {
  const result = db.prepare('DELETE FROM videos WHERE videoId = ?').run(videoId);
  if (result.changes === 0) return false;
  // FK ON DELETE CASCADE removes tags; clean up FTS manually.
  db.prepare('DELETE FROM videos_fts WHERE videoId = ?').run(videoId);
  return true;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Replace the tags array for an entry.
 * Sanitizes: trims strings, drops empties, deduplicates, caps at 20 tags.
 * Returns the updated full entry, or null if videoId not found.
 */
export async function setTags(videoId, tags) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const sanitized = Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
    : [];

  db.prepare('DELETE FROM tags WHERE videoId = ?').run(videoId);
  for (const tag of sanitized) {
    db.prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
  }
  db.prepare('UPDATE videos SET updatedAt = ? WHERE videoId = ?').run(new Date().toISOString(), videoId);

  return fetchFullEntry(videoId);
}

// ---------------------------------------------------------------------------
// Full-text search (FTS5)
// ---------------------------------------------------------------------------

/**
 * Search the library using FTS5 MATCH across title, transcript text, and digest.
 * Returns an array of full entry objects (same shape as getEntry) ranked by
 * relevance. Returns [] on empty/invalid queries or any FTS error.
 *
 * @param {string} query      - FTS5 query string (e.g. "germany worth it")
 * @param {number} [limit=20] - maximum results to return
 */
export async function searchLibrary(query, limit = 20) {
  if (!query || !String(query).trim()) return [];
  try {
    const rows = db.prepare(`
      SELECT f.videoId
      FROM   videos_fts f
      WHERE  videos_fts MATCH ?
      ORDER  BY rank
      LIMIT  ?
    `).all(String(query).trim(), Number(limit) || 20);

    return rows.map((r) => fetchFullEntry(r.videoId)).filter(Boolean);
  } catch {
    // Tolerate malformed FTS queries gracefully (bad operators, special chars)
    return [];
  }
}

// Small English stopword set used to strip low-signal tokens from natural-
// language questions before they're used as an FTS5 MATCH query. FTS5 ANDs
// all bareword tokens together, so leaving stopwords in ("what is about in")
// can force zero matches even when the library clearly has relevant content.
const FTS_STOPWORDS = new Set([
  'what', 'is', 'are', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'about', 'does', 'do', 'did', 'how', 'why', 'this', 'that',
  'with', 'from', 'your', 'my',
]);

/**
 * Build a safe, relevance-oriented FTS5 MATCH query from free-form text
 * (e.g. a natural-language question). Tokenizes on unicode word characters,
 * drops very short tokens and common English stopwords, quotes each
 * remaining token as an FTS5 phrase (avoiding syntax errors from special
 * characters), and OR-joins them for good recall (FTS5 `rank` still orders
 * results by relevance). Falls back to an unfiltered OR-joined query, and
 * finally to the raw trimmed text, if stripping leaves nothing usable.
 *
 * Does not alter searchLibrary()'s own semantics — callers opt into this by
 * passing its output as the `query` argument.
 *
 * @param {string} text - raw user input (question, phrase, keywords, etc.)
 * @returns {string} an FTS5 query string
 */
export function buildLibraryFtsQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const filtered = tokens.filter((t) => t.length > 2 && !FTS_STOPWORDS.has(t));

  if (filtered.length > 0) {
    return filtered.map((t) => `"${t}"`).join(' OR ');
  }

  if (tokens.length > 0) {
    return tokens.map((t) => `"${t}"`).join(' OR ');
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Channel / creator following
// ---------------------------------------------------------------------------

/**
 * Upsert a followed channel. Preserves the original addedAt on repeat calls
 * (e.g. re-adding a channel with an updated title), only refreshing
 * title/url. Returns the resulting follow row.
 *
 * @param {{ channelId: string, title?: string|null, url: string }} params
 */
export async function addFollow({ channelId, title, url }) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM follows WHERE channelId = ?').get(channelId);

  if (!existing) {
    db.prepare(`
      INSERT INTO follows (channelId, title, url, addedAt, lastCheckedAt)
      VALUES (?, ?, ?, ?, NULL)
    `).run(channelId, title || null, url, now);
  } else {
    db.prepare(`
      UPDATE follows SET title = ?, url = ? WHERE channelId = ?
    `).run(title || existing.title || null, url, channelId);
  }

  return db.prepare('SELECT * FROM follows WHERE channelId = ?').get(channelId);
}

/**
 * Remove a followed channel and its seen-video history.
 * Returns true if a follow was removed, false if it wasn't found.
 */
export async function removeFollow(channelId) {
  const result = db.prepare('DELETE FROM follows WHERE channelId = ?').run(channelId);
  if (result.changes === 0) return false;
  db.prepare('DELETE FROM follow_seen WHERE channelId = ?').run(channelId);
  return true;
}

/**
 * Return all followed channels, oldest-followed first.
 */
export async function listFollows() {
  return db.prepare('SELECT * FROM follows ORDER BY addedAt ASC').all();
}

/**
 * Return the set of videoIds already seen (surfaced/acknowledged) for a
 * given followed channel.
 * @returns {Promise<Set<string>>}
 */
export async function getSeenSet(channelId) {
  const rows = db.prepare('SELECT videoId FROM follow_seen WHERE channelId = ?').all(channelId);
  return new Set(rows.map((r) => r.videoId));
}

/**
 * Record a batch of videoIds as seen for a given channel. Deduplicates
 * against existing rows (INSERT OR IGNORE on the UNIQUE constraint) and
 * against duplicates within the input array itself.
 * @param {string} channelId
 * @param {string[]} videoIds
 */
export async function recordSeen(channelId, videoIds) {
  const ids = Array.isArray(videoIds) ? videoIds : [];
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO follow_seen (channelId, videoId, seenAt) VALUES (?, ?, ?)'
  );
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  for (const videoId of uniqueIds) {
    insert.run(channelId, videoId, now);
  }
  return uniqueIds.length;
}

/**
 * Update a followed channel's lastCheckedAt timestamp to now.
 */
export async function touchChecked(channelId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE follows SET lastCheckedAt = ? WHERE channelId = ?').run(now, channelId);
  return now;
}

