// Node 24 ships a built-in synchronous SQLite module — no native build needed.
// API mirrors better-sqlite3 closely: DatabaseSync, StatementSync, transaction().
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeHttpUrl } from './sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_FILE     = process.env.ECHO_DB_PATH || join(__dirname, 'data', 'library.db');
const DATA_DIR    = dirname(DB_FILE);
const LEGACY_JSON = join(DATA_DIR, 'library.json');

// Opened on FIRST USE, not at import.
//
// server.js imports this module in every mode, but in web mode every route
// that touches it is blockInWeb'd — so eager initialisation created a SQLite
// file that could never be read, in a container that is meant to be stateless,
// and would fail outright on a read-only filesystem. Local and desktop reach a
// library route within moments of starting, so nothing there is deferred in
// any way a user could notice.
// One database FILE per owner, not one table with an ownerId column.
//
// The column approach needs a WHERE on every query, a composite primary key, a
// rebuilt tags foreign key and an FTS reindex — and then it is correct only for
// as long as nobody forgets the WHERE. This codebase has SEVEN recorded bugs of
// the shape "a query that was fine because the fixture was small"; a filter that
// must be remembered at thirty call sites is that shape again, with a worse
// failure mode: the bug is not a slow page, it is one person reading another's
// library.
//
// Separate files make the isolation structural. A query cannot reach across an
// owner boundary because there is nothing to reach across — the other library is
// a different file that this connection has never opened. Deleting an account
// becomes deleting a file, and backing one up becomes copying it.
//
// The costs, honestly: no cross-owner query is possible (nothing here wants
// one), and a handle is held per active owner (bounded below).
const DEFAULT_OWNER = 'local';
const LIBRARIES_DIR = join(DATA_DIR, 'libraries');

/** @type {Map<string, import('node:sqlite').DatabaseSync>} */
const handles = new Map();

/**
 * Where an owner's library lives.
 *
 * The default owner keeps the ORIGINAL path, untouched: an install that never
 * turns accounts on must not notice this change, and the operator's existing
 * library must not move out from under them.
 *
 * @param {string} owner
 */
function dbPathFor(owner) {
  if (owner === DEFAULT_OWNER) return DB_FILE;

  // The owner id becomes a filename, so it is validated as one. Ids are UUIDs
  // from randomUUID today, but "today" is not a security property — a path
  // separator or a `..` here would be a traversal straight out of the data
  // directory.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner)) {
    throw new Error(`Invalid library owner id: ${JSON.stringify(String(owner).slice(0, 40))}`);
  }
  return join(LIBRARIES_DIR, `${owner}.db`);
}

// Most-recently-used cap on open handles. With accounts on, every person who
// makes a request opens one and nothing releases it — fine for the handful of
// people a personal instance approves, but "fine at ten" is the exact shape of
// bug this codebase has recorded seven times, so it gets a bound rather than an
// assumption. Reopening is a file open plus a few no-op migrations.
const MAX_OPEN_LIBRARIES = 64;

function getDb(owner = DEFAULT_OWNER) {
  const existing = handles.get(owner);
  if (existing) {
    // Refresh recency: delete + set moves the key to the end of Map iteration
    // order, so the first key is always the least recently used.
    handles.delete(owner);
    handles.set(owner, existing);
    return existing;
  }

  // Evict before opening, and never evict the default owner — on a
  // single-user install it is the only library there is.
  while (handles.size >= MAX_OPEN_LIBRARIES) {
    const oldest = [...handles.keys()].find((k) => k !== DEFAULT_OWNER);
    if (!oldest) break;
    try { handles.get(oldest).close(); } catch { /* already gone */ }
    handles.delete(oldest);
  }

  const file = dbPathFor(owner);
  mkdirSync(dirname(file), { recursive: true });
  const _db = new DatabaseSync(file);
  handles.set(owner, _db);

  // Enable WAL mode and FK enforcement via plain PRAGMA SQL (node:sqlite has no
  // separate pragma() method; exec() runs any SQL statement directly).
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');

  initSchema(owner);
  migrateSegmentCount(owner);
  migrateChannelColumns(owner);
  migrateTranscriptSourceColumns(owner);
  migrateFtsRowids(owner);

  // Only the default owner has a legacy JSON library to import. A per-account
  // file is new by definition, and pulling the operator's old library into a
  // visitor's would be the exact leak this design exists to prevent.
  if (owner === DEFAULT_OWNER) migrateFromLegacyJson(owner);

  return _db;
}

/**
 * Close every open handle. Test seam, and the tidy-up path for a long-running
 * instance that has accumulated handles for people who have gone home.
 */
export function closeAllLibraries() {
  for (const [, handle] of handles) {
    try { handle.close(); } catch { /* already gone */ }
  }
  handles.clear();
}

/**
 * Close one owner's handle, if open. Narrower sibling of closeAllLibraries()
 * for callers (adoptDefaultLibrary) that must not disturb every other
 * approved user's in-flight connection just to shut the two handles they
 * actually touch.
 *
 * @param {string} owner
 */
function closeLibrary(owner) {
  const handle = handles.get(owner);
  if (!handle) return;
  try { handle.close(); } catch { /* already gone */ }
  handles.delete(owner);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function initSchema(owner) {
  getDb(owner).exec(`
  CREATE TABLE IF NOT EXISTS videos (
    videoId   TEXT PRIMARY KEY,
    url       TEXT NOT NULL,
    title     TEXT,
    savedAt   TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    segments  TEXT NOT NULL DEFAULT '[]',
    digest    TEXT,
    favorite  INTEGER NOT NULL DEFAULT 0,
    segment_count INTEGER NOT NULL DEFAULT 0,
    channel   TEXT,
    channelUrl TEXT,
    transcript_source TEXT,
    whisper_model TEXT
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
`);
}

// ---------------------------------------------------------------------------
// One-time migration: add segment_count column to pre-existing DBs and
// backfill it from the segments JSON so listEntries() never has to parse
// the full transcript just to report a count. Idempotent: skips entirely
// once the column exists (guards against duplicate-column errors from
// concurrent processes touching the same DB file).
// ---------------------------------------------------------------------------

function migrateSegmentCount(owner) {
  const cols = getDb(owner).prepare('PRAGMA table_info(videos)').all();
  const hasCol = cols.some((c) => c.name === 'segment_count');
  if (hasCol) return; // Already migrated (or created fresh with the column above)

  try {
    getDb(owner).exec('ALTER TABLE videos ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    // Tolerate a race where another process added the column concurrently.
    if (!/duplicate column/i.test(err?.message || '')) throw err;
    return;
  }

  // Backfill existing rows (added before this column existed) once.
  const rows = getDb(owner).prepare('SELECT videoId, segments FROM videos').all();
  const updateCount = getDb(owner).prepare('UPDATE videos SET segment_count = ? WHERE videoId = ?');
  for (const row of rows) {
    let n = 0;
    try { n = JSON.parse(row.segments || '[]').length; } catch { n = 0; }
    updateCount.run(n, row.videoId);
  }
}

// ---------------------------------------------------------------------------
// One-time migration: add channel/channelUrl columns to pre-existing DBs so
// a saved entry can carry its source channel's name + URL (enables one-click
// "Follow channel" from the library). Existing rows get NULL. Idempotent:
// mirrors migrateSegmentCount()'s PRAGMA-check + duplicate-column tolerance.
// ---------------------------------------------------------------------------

function migrateChannelColumns(owner) {
  const cols = getDb(owner).prepare('PRAGMA table_info(videos)').all();
  const colNames = new Set(cols.map((c) => c.name));

  for (const col of ['channel', 'channelUrl']) {
    if (colNames.has(col)) continue; // Already migrated (or created fresh with the column above)
    try {
      getDb(owner).exec(`ALTER TABLE videos ADD COLUMN ${col} TEXT`);
    } catch (err) {
      // Tolerate a race where another process added the column concurrently.
      if (!/duplicate column/i.test(err?.message || '')) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// One-time migration: add transcript_source/whisper_model columns to
// pre-existing DBs so a saved entry can record how its transcript was
// produced ('captions' | 'whisper') and, if whisper, which model
// ('base'|'small'). Existing rows get NULL, treated as 'captions'
// downstream. Idempotent: mirrors migrateChannelColumns()'s PRAGMA-check +
// duplicate-column tolerance.
// ---------------------------------------------------------------------------

function migrateTranscriptSourceColumns(owner) {
  const cols = getDb(owner).prepare('PRAGMA table_info(videos)').all();
  const colNames = new Set(cols.map((c) => c.name));

  for (const col of ['transcript_source', 'whisper_model']) {
    if (colNames.has(col)) continue; // Already migrated (or created fresh with the column above)
    try {
      getDb(owner).exec(`ALTER TABLE videos ADD COLUMN ${col} TEXT`);
    } catch (err) {
      // Tolerate a race where another process added the column concurrently.
      if (!/duplicate column/i.test(err?.message || '')) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal DB helpers
// ---------------------------------------------------------------------------

/**
 * Reassemble a full normalized entry object from the four DB tables.
 * Returns null if the videoId does not exist in the videos table.
 */
function fetchFullEntry(owner, videoId) {
  const row = getDb(owner).prepare('SELECT * FROM videos WHERE videoId = ?').get(videoId);
  if (!row) return null;

  const tags = getDb(owner).prepare(
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
    tags:       tags.map((t) => t.tag),
    channel:    row.channel ?? null,
    channelUrl: row.channelUrl ?? null,
    transcriptSource: row.transcript_source ?? null,
    whisperModel:     row.whisper_model ?? null,
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
    channel:        entry.channel    ?? null,
    channelUrl:     entry.channelUrl ?? null,
    transcriptSource: entry.transcriptSource ?? null,
    whisperModel:     entry.whisperModel     ?? null,
  };
}

/**
 * Map a raw (unparsed, snake_case) videos-table row — as produced by the
 * projected listEntries() SELECT — plus its tags array to the same 11-field
 * metadata shape toMeta() produces. Kept in sync with toMeta() by hand;
 * listEntries()'s own row→object mapping used to drift from it.
 */
function metaFromRow(row, tags) {
  return {
    videoId:        row.videoId,
    url:            row.url,
    title:          row.title,
    savedAt:        row.savedAt,
    hasDigest:      !!row.hasDigest,
    segmentCount:   row.segment_count || 0,
    tags:           Array.isArray(tags) ? tags : [],
    channel:        row.channel ?? null,
    channelUrl:     row.channelUrl ?? null,
    transcriptSource: row.transcript_source ?? null,
    whisperModel:     row.whisper_model ?? null,
  };
}

/**
 * (Re)populate the FTS5 row for a given videoId from the videos table.
 * Called after every write that may affect title, segments, or digest.
 *
 * The FTS row is keyed by the *videos* rowid, not by videoId. That is the whole
 * point: `videoId` is an UNINDEXED column in an FTS5 table, so deleting by it
 * plans as `SCAN videos_fts VIRTUAL TABLE` — a linear pass over every stored
 * transcript, on every single save. Measured: 10.5 ms/save at 100 entries,
 * 18.6 at 400, 23.7 at 800. Deleting by rowid is a B-tree lookup and does not
 * grow with the library (27.7 ms → 9.1 ms at 600 entries in isolation).
 *
 * Reusing videos.rowid rather than inventing a mapping table is safe because
 * the two rows are always deleted together (see deleteEntry) — so a rowid
 * SQLite recycles for a new video can never collide with a live FTS row.
 */
function syncFts(owner, videoId) {
  const row = getDb(owner).prepare(
    'SELECT rowid, title, segments, digest FROM videos WHERE videoId = ?'
  ).get(videoId);
  if (!row) return;

  const transcriptText = JSON.parse(row.segments || '[]')
    .map((s) => s.text || '')
    .join(' ');

  getDb(owner).prepare('DELETE FROM videos_fts WHERE rowid = ?').run(row.rowid);
  getDb(owner).prepare(
    'INSERT INTO videos_fts(rowid, videoId, title, transcript_text, digest) VALUES (?, ?, ?, ?, ?)'
  ).run(row.rowid, videoId, row.title ?? '', transcriptText, row.digest ?? '');
}

// ---------------------------------------------------------------------------
// One-time migration: re-key the FTS index by videos.rowid.
//
// Rows written before this change carry whatever rowid FTS5 auto-assigned, so
// they do not line up with videos.rowid and a rowid-keyed delete would miss
// them — leaving stale documents that search would keep returning. The index
// is derived data, so the fix is simply to rebuild it once.
//
// Gated on PRAGMA user_version, and deliberately NOT wrapped in one giant
// transaction: `DELETE FROM videos_fts` runs first, so a crash midway just
// means user_version is still 0 and the next boot redoes the whole thing. That
// is cheaper than holding a multi-hundred-megabyte write transaction open.
// ---------------------------------------------------------------------------

const FTS_ROWID_SCHEMA_VERSION = 1;

function migrateFtsRowids(owner) {
  const { user_version: version } = getDb(owner).prepare('PRAGMA user_version').get();
  if (version >= FTS_ROWID_SCHEMA_VERSION) return;

  getDb(owner).exec('DELETE FROM videos_fts');

  // Ids first, then one entry at a time — never hold every transcript at once.
  const ids = getDb(owner).prepare('SELECT videoId FROM videos ORDER BY rowid').all();
  for (const { videoId } of ids) syncFts(owner, videoId);

  getDb(owner).exec(`PRAGMA user_version = ${FTS_ROWID_SCHEMA_VERSION}`);
}

// ---------------------------------------------------------------------------
// One-time migration from library.json → SQLite
// Runs synchronously at module load; idempotent (skips if videos table is
// already populated). Does NOT delete library.json (left as backup).
// ---------------------------------------------------------------------------

function migrateFromLegacyJson(owner) {
  if (process.env.ECHO_DB_PATH) return;
  const count = getDb(owner).prepare('SELECT COUNT(*) as n FROM videos').get().n;
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

  const insertVideo = getDb(owner).prepare(`
    INSERT OR IGNORE INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, segment_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = getDb(owner).prepare(
    'INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)'
  );

  // node:sqlite's DatabaseSync has no transaction() wrapper — use raw SQL.
  let migrated = 0;
  getDb(owner).exec('BEGIN');
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
        Array.isArray(entry.segments) ? entry.segments.length : 0,
      );

      // Tags — dedup + cap at 20, matching setTags sanitization
      const rawTags = Array.isArray(entry.tags) ? entry.tags : [];
      const sanitizedTags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
      for (const tag of sanitizedTags) {
        insertTag.run(entry.videoId, tag);
      }

      syncFts(owner, entry.videoId);
      migrated++;
    }
    getDb(owner).exec('COMMIT');
  } catch (err) {
    getDb(owner).exec('ROLLBACK');
    console.error('[store] Migration failed, rolled back:', err.message);
    return;
  }

  console.log(`[store] Migrated ${migrated} entr${migrated === 1 ? 'y' : 'ies'} from library.json to SQLite.`);
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/** Total number of saved entries. Cheap — SQLite answers it from the index. */
async function countEntriesFor(owner) {
  return getDb(owner).prepare('SELECT COUNT(*) AS n FROM videos').get().n;
}

/**
 * Return metadata for all saved entries, sorted by savedAt descending (newest first).
 * Uses batch queries to avoid N+1 round-trips. Projects only the columns
 * needed for the metadata shape — does NOT select segments/digest (the full
 * transcript JSON / digest markdown blobs), since those are discarded anyway.
 *
 * Pass `{ limit, offset }` to fetch one page. Callers that pass neither get the
 * whole library exactly as before — the page's first paint only needs a screen
 * or two of cards, but the export, the vault sync and the Obsidian plugin all
 * genuinely want everything, and it would be a poor trade to make them ask
 * twice.
 *
 * @param {{limit?: number, offset?: number}} [opts]
 */
async function listEntriesFor(owner, opts = {}) {
  const paged = Number.isFinite(opts.limit) && opts.limit > 0;
  const limit = paged ? Math.floor(opts.limit) : -1;         // -1 = no limit, in SQLite
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? Math.floor(opts.offset) : 0;

  const rows = getDb(owner).prepare(`
    SELECT videoId, url, title, savedAt, segment_count, channel, channelUrl,
           transcript_source, whisper_model, (digest IS NOT NULL) AS hasDigest
    FROM videos
    ORDER BY savedAt DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  if (rows.length === 0) return [];

  // Tags for exactly the rows being returned. Reading the whole tags table is
  // right when the whole library is being returned anyway, but for a 60-row
  // page it would mean loading every tag in the library to decorate one
  // screenful. The unpaged branch also avoids binding one variable per row —
  // an IN list over a big library would run into SQLITE_MAX_VARIABLE_NUMBER,
  // which is exactly the kind of works-at-500-breaks-at-40k this code keeps
  // having to unlearn.
  const allTags = paged
    ? getDb(owner)
        .prepare(`SELECT videoId, tag FROM tags WHERE videoId IN (${rows.map(() => '?').join(',')}) ORDER BY videoId, rowid`)
        .all(...rows.map((r) => r.videoId))
    : getDb(owner).prepare('SELECT videoId, tag FROM tags ORDER BY videoId, rowid').all();

  /** @type {Record<string, string[]>} */
  const tagsByVideo = {};
  for (const t of allTags) {
    if (!tagsByVideo[t.videoId]) tagsByVideo[t.videoId] = [];
    tagsByVideo[t.videoId].push(t.tag);
  }

  return rows.map((row) => metaFromRow(row, tagsByVideo[row.videoId]));
}

/**
 * Return the full normalized entry object for a given videoId, or null if not found.
 */
async function getEntryFor(owner, videoId) {
  return fetchFullEntry(owner, videoId);
}

/**
 * Upsert an entry by videoId.
 * Preserves existing digest, tags when the
 * incoming payload omits them.
 * Returns the metadata object for the saved entry.
 */
async function saveEntryFor(owner, { url, videoId, title, segments, digest, tags, channel, channelUrl, transcriptSource, whisperModel }) {
  const now      = new Date().toISOString();
  const existing = getDb(owner).prepare('SELECT * FROM videos WHERE videoId = ?').get(videoId);
  const safeUrl  = safeHttpUrl(url);

  if (!existing) {
    // ---- New entry --------------------------------------------------------
    getDb(owner).prepare(`
      INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, segment_count, channel, channelUrl, transcript_source, whisper_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      safeUrl,
      title  || null,
      now, now,
      JSON.stringify(segments || []),
      digest || null,
      Array.isArray(segments) ? segments.length : 0,
      channel    || null,
      channelUrl || null,
      transcriptSource || null,
      whisperModel     || null,
    );

    const initTags = Array.isArray(tags) ? tags : [];
    for (const tag of [...new Set(initTags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)) {
      getDb(owner).prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
    }
  } else {
    // ---- Existing entry — preserve savedAt and extension fields not in payload ----
    const keepDigest     = digest   ? digest   : existing.digest;
    const keepChannel    = channel    !== undefined ? (channel    || null) : existing.channel;
    const keepChannelUrl = channelUrl !== undefined ? (channelUrl || null) : existing.channelUrl;
    const keepTranscriptSource = transcriptSource != null ? transcriptSource : existing.transcript_source;
    const keepWhisperModel     = whisperModel     != null ? whisperModel     : existing.whisper_model;

    getDb(owner).prepare(`
      UPDATE videos
      SET url = ?, title = ?, updatedAt = ?, segments = ?, digest = ?, segment_count = ?, channel = ?, channelUrl = ?, transcript_source = ?, whisper_model = ?
      WHERE videoId = ?
    `).run(
      url != null ? safeUrl : existing.url,
      title || null,
      now,
      JSON.stringify(segments || []),
      keepDigest,
      Array.isArray(segments) ? segments.length : 0,
      keepChannel,
      keepChannelUrl,
      keepTranscriptSource,
      keepWhisperModel,
      videoId,
    );

    // Replace tags only if a tags array was explicitly provided
    if (Array.isArray(tags)) {
      const sanitized = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
      getDb(owner).prepare('DELETE FROM tags WHERE videoId = ?').run(videoId);
      for (const tag of sanitized) {
        getDb(owner).prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
      }
    }
  }

  syncFts(owner, videoId);

  return toMeta(fetchFullEntry(owner, videoId));
}

/**
 * Remove the entry with the given videoId.
 * Returns true if an entry was removed, false if it wasn't found.
 */
async function deleteEntryFor(owner, videoId) {
  // Read the rowid *before* the delete — it is the FTS row's key, and once the
  // videos row is gone there is no cheap way back to it. Deleting both rows
  // together is also what makes rowid reuse safe (see syncFts).
  const row = getDb(owner).prepare('SELECT rowid FROM videos WHERE videoId = ?').get(videoId);
  if (!row) return false;

  const result = getDb(owner).prepare('DELETE FROM videos WHERE videoId = ?').run(videoId);
  if (result.changes === 0) return false;
  // FK ON DELETE CASCADE removes tags; clean up FTS manually.
  getDb(owner).prepare('DELETE FROM videos_fts WHERE rowid = ?').run(row.rowid);
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
async function setTagsFor(owner, videoId, tags) {
  if (!getDb(owner).prepare('SELECT videoId FROM videos WHERE videoId = ?').get(videoId)) return null;

  const sanitized = Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
    : [];

  getDb(owner).prepare('DELETE FROM tags WHERE videoId = ?').run(videoId);
  for (const tag of sanitized) {
    getDb(owner).prepare('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
  }
  getDb(owner).prepare('UPDATE videos SET updatedAt = ? WHERE videoId = ?').run(new Date().toISOString(), videoId);

  return fetchFullEntry(owner, videoId);
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
/**
 * Search, returning only what a result list actually shows.
 *
 * This replaced a searchLibrary() that hydrated every hit into a full entry —
 * transcript segments and all — which the search route then used purely to cut
 * a ~200 character snippet from. Measured on a 300-entry library: 2.0 MB of transcript
 * text read to produce about 4 KB of output, per search.
 *
 * FTS5 can cut the snippet itself, inside SQLite, from the index it already
 * has. The result is the same shape the route was building by hand, without any
 * transcript crossing into JS. `-1` lets FTS5 choose the best-matching column,
 * so a title hit snippets the title and a transcript hit snippets the
 * transcript — which the hand-rolled version could not do at all.
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<{videoId, title, url, snippet, tags}>}
 */
async function searchSummariesFor(owner, query, limit = 20) {
  if (!query || !String(query).trim()) return [];
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);

  let rows;
  try {
    rows = getDb(owner).prepare(`
      SELECT f.videoId,
             v.title,
             v.url,
             snippet(videos_fts, -1, '', '', '…', 24) AS snippet
      FROM   videos_fts f
      JOIN   videos v ON v.videoId = f.videoId
      WHERE  videos_fts MATCH ?
      ORDER  BY rank
      LIMIT  ?
    `).all(String(query).trim(), capped);
  } catch (err) {
    // Tolerate malformed FTS queries gracefully (bad operators, special
    // chars) — but log first, because a bare `return []` here also swallows a
    // genuine SQLite lock/corruption/disk error and makes it indistinguishable
    // from "no results", both to the user and in the logs.
    console.error('[store] searchSummariesFor query failed:', err.message);
    return [];
  }

  if (rows.length === 0) return [];

  // Tags in one query for the whole result set rather than one per hit.
  const ids = rows.map((r) => r.videoId);
  const placeholders = ids.map(() => '?').join(',');
  const tagRows = getDb(owner)
    .prepare(`SELECT videoId, tag FROM tags WHERE videoId IN (${placeholders}) ORDER BY videoId, rowid`)
    .all(...ids);

  const tagsByVideo = {};
  for (const t of tagRows) {
    if (!tagsByVideo[t.videoId]) tagsByVideo[t.videoId] = [];
    tagsByVideo[t.videoId].push(t.tag);
  }

  return rows.map((r) => ({
    videoId: r.videoId,
    title: r.title,
    url: r.url,
    snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
    tags: tagsByVideo[r.videoId] || [],
  }));
}




// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The library belonging to one owner.
 *
 * @param {string} owner an account id, or DEFAULT_OWNER
 */
export function forOwner(owner = DEFAULT_OWNER) {
  return {
    countEntries: () => countEntriesFor(owner),
    listEntries: (opts) => listEntriesFor(owner, opts),
    getEntry: (videoId) => getEntryFor(owner, videoId),
    saveEntry: (entry) => saveEntryFor(owner, entry),
    deleteEntry: (videoId) => deleteEntryFor(owner, videoId),
    setTags: (videoId, tags) => setTagsFor(owner, videoId, tags),
    searchSummaries: (query, limit) => searchSummariesFor(owner, query, limit),
  };
}

// The bare exports are the DEFAULT owner's library — which is exactly what an
// install with no accounts has, and what every existing caller means. Keeping
// them is not backwards-compatibility theatre: single-user local mode is the
// one behaviour that must not change, and this is the shape it already had.
export const countEntries = (...a) => countEntriesFor(DEFAULT_OWNER, ...a);
export const listEntries = (...a) => listEntriesFor(DEFAULT_OWNER, ...a);
export const getEntry = (...a) => getEntryFor(DEFAULT_OWNER, ...a);
export const saveEntry = (...a) => saveEntryFor(DEFAULT_OWNER, ...a);
export const deleteEntry = (...a) => deleteEntryFor(DEFAULT_OWNER, ...a);
export const setTags = (...a) => setTagsFor(DEFAULT_OWNER, ...a);
export const searchSummaries = (...a) => searchSummariesFor(DEFAULT_OWNER, ...a);

export { DEFAULT_OWNER, dbPathFor };

/**
 * Hand the pre-accounts library to an account.
 *
 * Turning accounts on otherwise looks like data loss: the operator signs in,
 * their account gets a brand-new empty file, and every video they ever saved is
 * still sitting in the default owner's library where nothing will show it to
 * them again. This moves the file itself rather than copying rows — one rename,
 * no reindex, and nothing can half-succeed.
 *
 * Refuses when the target already has a library, so it can never overwrite one,
 * and is a no-op once done because there is no longer a default file to adopt.
 *
 * @param {string} owner
 * @returns {{adopted: boolean, reason?: string}}
 */
export function adoptDefaultLibrary(owner) {
  if (owner === DEFAULT_OWNER) return { adopted: false, reason: 'already_default' };

  const from = dbPathFor(DEFAULT_OWNER);
  const to = dbPathFor(owner);
  if (!existsSync(from)) return { adopted: false, reason: 'nothing_to_adopt' };

  // "Has a library" means HAS ENTRIES, not "has a file". Reading an empty
  // library creates its file — so an existence check would refuse to adopt for
  // anyone who had merely loaded the page once, which is everyone who just
  // signed in. An empty file is not data and is safe to replace.
  if (existsSync(to)) {
    const { n } = getDb(owner).prepare('SELECT COUNT(*) AS n FROM videos').get();
    if (n > 0) return { adopted: false, reason: 'owner_has_library' };
    // Only the target owner's handle is open on `to` at this point — closing
    // every open handle here would also force-close any OTHER approved user's
    // in-flight connection for no reason (adoptDefaultLibrary fires from
    // admin sign-in, which has nothing to do with anyone else's request).
    closeLibrary(owner);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(to + suffix)) rmSync(to + suffix, { force: true });
    }
  }

  // Both handles must be shut before the file moves, or SQLite keeps writing
  // through a descriptor pointing at a path that no longer means what it did.
  // Narrowed to just these two owners for the same reason as above — every
  // other approved user's handle must survive this untouched.
  closeLibrary(DEFAULT_OWNER);
  closeLibrary(owner);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  // WAL and shared-memory siblings travel with it; a checkpointed database can
  // be missing either, so their absence is not an error.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  }
  return { adopted: true };
}
