// Node 24 ships a built-in synchronous SQLite module — no native build needed.
// API mirrors better-sqlite3 closely: DatabaseSync, StatementSync, transaction().
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    favorite  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tags (
    videoId TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    UNIQUE(videoId, tag)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id        TEXT PRIMARY KEY,
    videoId   TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id        TEXT PRIMARY KEY,
    videoId   TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    note      TEXT,
    color     TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    videoId UNINDEXED,
    title,
    transcript_text,
    digest
  );
`);

// Embeddings persistence table — added separately to avoid touching the existing
// schema block.  FK ON DELETE CASCADE keeps it tidy when a video is removed.
db.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    videoId   TEXT PRIMARY KEY REFERENCES videos(videoId) ON DELETE CASCADE,
    vector    TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Monotonic ID generator — same semantics as the original file-based store.js
// ---------------------------------------------------------------------------

let _idCounter = 0;

/**
 * Generate a collision-safe ID string: "<timestamp>-<counter>".
 * Uses Date.now() plus a per-process counter so rapid successive calls
 * never produce the same value.
 */
function generateId() {
  _idCounter += 1;
  return `${Date.now()}-${_idCounter}`;
}

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

  const notes = db.prepare(
    'SELECT id, text, createdAt FROM notes WHERE videoId = ? ORDER BY createdAt'
  ).all(videoId);

  const highlights = db.prepare(
    'SELECT id, text, note, color, createdAt FROM highlights WHERE videoId = ? ORDER BY createdAt'
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
    notes:      notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt })),
    highlights: highlights.map((h) => {
      // Omit note/color entirely when null — matches sanitizeHighlight's undefined semantics
      const obj = { id: h.id, text: h.text, createdAt: h.createdAt };
      if (h.note  != null) obj.note  = h.note;
      if (h.color != null) obj.color = h.color;
      return obj;
    }),
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
    noteCount:      Array.isArray(entry.notes)      ? entry.notes.length     : 0,
    highlightCount: Array.isArray(entry.highlights) ? entry.highlights.length : 0,
  };
}

/**
 * Sanitize a single raw highlight object into the canonical shape.
 * Assigns id and createdAt if missing; requires text to be a non-empty string.
 * Returns null if text is absent or empty.
 */
function sanitizeHighlight(raw) {
  const text = String(raw?.text ?? '').trim();
  if (!text) return null;
  return {
    id:        raw.id    ?? generateId(),
    text,
    note:      raw.note  != null ? String(raw.note)  : undefined,
    color:     raw.color != null ? String(raw.color) : undefined,
    createdAt: raw.createdAt ?? new Date().toISOString(),
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
    INSERT OR IGNORE INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)'
  );
  const insertNote = db.prepare(
    'INSERT OR IGNORE INTO notes (id, videoId, text, createdAt) VALUES (?, ?, ?, ?)'
  );
  const insertHighlight = db.prepare(
    'INSERT OR IGNORE INTO highlights (id, videoId, text, note, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
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
      );

      // Tags — dedup + cap at 20, matching setTags sanitization
      const rawTags = Array.isArray(entry.tags) ? entry.tags : [];
      const sanitizedTags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
      for (const tag of sanitizedTags) {
        insertTag.run(entry.videoId, tag);
      }

      for (const note of (Array.isArray(entry.notes) ? entry.notes : [])) {
        if (!note.id || !note.text) continue;
        insertNote.run(note.id, entry.videoId, note.text, note.createdAt ?? new Date().toISOString());
      }

      for (const h of (Array.isArray(entry.highlights) ? entry.highlights : [])) {
        if (!h.id || !h.text) continue;
        insertHighlight.run(h.id, entry.videoId, h.text, h.note ?? null, h.color ?? null, h.createdAt ?? new Date().toISOString());
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
  const noteCounts     = db.prepare('SELECT videoId, COUNT(*) as n FROM notes GROUP BY videoId').all();
  const highlightCounts = db.prepare('SELECT videoId, COUNT(*) as n FROM highlights GROUP BY videoId').all();

  /** @type {Record<string, string[]>} */
  const tagsByVideo = {};
  for (const t of allTags) {
    if (!tagsByVideo[t.videoId]) tagsByVideo[t.videoId] = [];
    tagsByVideo[t.videoId].push(t.tag);
  }
  const noteCountMap       = Object.fromEntries(noteCounts.map((r) => [r.videoId, r.n]));
  const highlightCountMap  = Object.fromEntries(highlightCounts.map((r) => [r.videoId, r.n]));

  return rows.map((row) => ({
    videoId:        row.videoId,
    url:            row.url,
    title:          row.title,
    savedAt:        row.savedAt,
    hasDigest:      !!row.digest,
    segmentCount:   JSON.parse(row.segments || '[]').length,
    tags:           tagsByVideo[row.videoId]       || [],
    favorite:       row.favorite === 1,
    noteCount:      noteCountMap[row.videoId]      || 0,
    highlightCount: highlightCountMap[row.videoId] || 0,
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
 * Preserves existing digest, tags, favorite, notes, highlights when the
 * incoming payload omits them.
 * Returns the metadata object for the saved entry.
 */
export async function saveEntry({ url, videoId, title, segments, digest, tags, favorite, notes, highlights }) {
  const now      = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM videos WHERE videoId = ?').get(videoId);

  if (!existing) {
    // ---- New entry --------------------------------------------------------
    db.prepare(`
      INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, favorite)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      url    ?? '',
      title  || null,
      now, now,
      JSON.stringify(segments || []),
      digest || null,
      typeof favorite === 'boolean' ? (favorite ? 1 : 0) : 0,
    );

    const initTags = Array.isArray(tags) ? tags : [];
    for (const tag of [...new Set(initTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)) {
      db.prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
    }

    for (const n of (Array.isArray(notes) ? notes : [])) {
      if (!n.id || !n.text) continue;
      db.prepare('INSERT OR IGNORE INTO notes (id, videoId, text, createdAt) VALUES (?, ?, ?, ?)')
        .run(n.id, videoId, n.text, n.createdAt ?? now);
    }

    for (const h of (Array.isArray(highlights) ? highlights : [])) {
      const s = sanitizeHighlight(h);
      if (!s) continue;
      db.prepare('INSERT OR IGNORE INTO highlights (id, videoId, text, note, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.id, videoId, s.text, s.note ?? null, s.color ?? null, s.createdAt);
    }
  } else {
    // ---- Existing entry — preserve savedAt and extension fields not in payload ----
    const keepDigest   = digest   ? digest   : existing.digest;
    const keepFavorite = typeof favorite === 'boolean' ? (favorite ? 1 : 0) : existing.favorite;

    db.prepare(`
      UPDATE videos
      SET url = ?, title = ?, updatedAt = ?, segments = ?, digest = ?, favorite = ?
      WHERE videoId = ?
    `).run(
      url ?? existing.url,
      title || null,
      now,
      JSON.stringify(segments || []),
      keepDigest,
      keepFavorite,
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

    // Replace notes only if a notes array was explicitly provided
    if (Array.isArray(notes)) {
      db.prepare('DELETE FROM notes WHERE videoId = ?').run(videoId);
      for (const n of notes) {
        if (!n.id || !n.text) continue;
        db.prepare('INSERT OR IGNORE INTO notes (id, videoId, text, createdAt) VALUES (?, ?, ?, ?)')
          .run(n.id, videoId, n.text, n.createdAt ?? now);
      }
    }

    // Replace highlights only if a highlights array was explicitly provided
    if (Array.isArray(highlights)) {
      db.prepare('DELETE FROM highlights WHERE videoId = ?').run(videoId);
      for (const h of highlights) {
        const s = sanitizeHighlight(h);
        if (!s) continue;
        db.prepare('INSERT OR IGNORE INTO highlights (id, videoId, text, note, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
          .run(s.id, videoId, s.text, s.note ?? null, s.color ?? null, s.createdAt);
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
  // FK ON DELETE CASCADE removes tags/notes/highlights; clean up FTS manually.
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
// Favorite
// ---------------------------------------------------------------------------

/**
 * Set the favorite boolean for an entry.
 * Returns the updated full entry, or null if videoId not found.
 */
export async function setFavorite(videoId, favorite) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  db.prepare('UPDATE videos SET favorite = ?, updatedAt = ? WHERE videoId = ?').run(
    Boolean(favorite) ? 1 : 0,
    new Date().toISOString(),
    videoId,
  );

  return fetchFullEntry(videoId);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Append a new note to an entry's notes array.
 * Returns the created note object (not the full entry), or null if not found.
 */
export async function addNote(videoId, text) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const note = {
    id:        generateId(),
    text:      String(text ?? '').trim(),
    createdAt: new Date().toISOString(),
  };

  db.prepare('INSERT INTO notes (id, videoId, text, createdAt) VALUES (?, ?, ?, ?)')
    .run(note.id, videoId, note.text, note.createdAt);

  return note;
}

/**
 * Remove a note by id from an entry.
 * Returns true if the note was found and removed, false if the note didn't
 * exist (but the entry did), or null if the videoId wasn't found.
 */
export async function deleteNote(videoId, noteId) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const result = db.prepare('DELETE FROM notes WHERE id = ? AND videoId = ?').run(noteId, videoId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/**
 * Replace the highlights array for an entry.
 * Sanitizes each highlight (must have text; assigns id/createdAt if missing).
 * Drops any highlight missing a text value.
 * Returns the updated full entry, or null if videoId not found.
 */
export async function setHighlights(videoId, highlights) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const sanitized = Array.isArray(highlights)
    ? highlights.map(sanitizeHighlight).filter(Boolean)
    : [];

  db.prepare('DELETE FROM highlights WHERE videoId = ?').run(videoId);
  for (const h of sanitized) {
    db.prepare('INSERT INTO highlights (id, videoId, text, note, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(h.id, videoId, h.text, h.note ?? null, h.color ?? null, h.createdAt);
  }
  db.prepare('UPDATE videos SET updatedAt = ? WHERE videoId = ?').run(new Date().toISOString(), videoId);

  return fetchFullEntry(videoId);
}

/**
 * Append a single highlight to an entry's highlights array.
 * Returns the created highlight object, or null if videoId not found.
 * Throws if text is empty (same behaviour as original store.js).
 */
export async function addHighlight(videoId, { text, note, color } = {}) {
  const highlight = sanitizeHighlight({ text, note, color });
  if (!highlight) throw new Error('highlight.text is required and must be a non-empty string');

  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  db.prepare('INSERT INTO highlights (id, videoId, text, note, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(highlight.id, videoId, highlight.text, highlight.note ?? null, highlight.color ?? null, highlight.createdAt);

  return highlight;
}

/**
 * Remove a highlight by id from an entry.
 * Returns true if the highlight was found and removed, false if the highlight
 * didn't exist (but the entry did), or null if the videoId wasn't found.
 */
export async function deleteHighlight(videoId, highlightId) {
  if (!db.prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const result = db.prepare('DELETE FROM highlights WHERE id = ? AND videoId = ?').run(highlightId, videoId);
  return result.changes > 0;
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

// ---------------------------------------------------------------------------
// Embeddings persistence
// ---------------------------------------------------------------------------

/**
 * Retrieve a stored embedding for a videoId.
 * Returns { vector: number[], dim: number } or null if not found.
 * These are synchronous because node:sqlite is synchronous.
 * @param {string} videoId
 * @returns {{ vector: number[], dim: number } | null}
 */
export function getEmbedding(videoId) {
  const row = db.prepare('SELECT vector, dim FROM embeddings WHERE videoId = ?').get(videoId);
  if (!row) return null;
  try {
    return { vector: JSON.parse(row.vector), dim: row.dim };
  } catch {
    return null;
  }
}

/**
 * Upsert an embedding for a videoId.
 * @param {string} videoId
 * @param {number[]} vector
 * @param {number}   dim
 */
export function setEmbedding(videoId, vector, dim) {
  db.prepare(`
    INSERT INTO embeddings (videoId, vector, dim, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(videoId) DO UPDATE SET
      vector    = excluded.vector,
      dim       = excluded.dim,
      updatedAt = excluded.updatedAt
  `).run(videoId, JSON.stringify(vector), dim, new Date().toISOString());
}

/**
 * Return all stored embeddings as an array of { videoId, vector: number[], dim }.
 * Used for in-memory cosine similarity scoring at query time.
 * @returns {Array<{ videoId: string, vector: number[], dim: number }>}
 */
export function allEmbeddings() {
  return db.prepare('SELECT videoId, vector, dim FROM embeddings').all()
    .map((row) => {
      try {
        return { videoId: row.videoId, vector: JSON.parse(row.vector), dim: row.dim };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
