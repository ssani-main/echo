// Port of ../store.js on bun:sqlite: the saved library, one database file per owner, FTS5 search.
// Checked against the original by check/store.cases.ts, and through the routes by check/routes.sh.
// Not ported: adoptDefaultLibrary (only accounts call it; they come in step 8, and it needs rename, gap
// fs-rename). The comments on why it is built this way are in store.js; the ones here are about the port.

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safeHttpUrl } from './sanitize.ts';

// The repo root is one up from seshat/, so the default file is the one store.js opens.
const DB_FILE = process.env.ECHO_DB_PATH || join(dirname(import.meta.dirname), 'data', 'library.db');
const DATA_DIR = dirname(DB_FILE);
const LEGACY_JSON = join(DATA_DIR, 'library.json');

export const DEFAULT_OWNER = 'local';
const LIBRARIES_DIR = join(DATA_DIR, 'libraries');

/** A saved entry. `segments` is whatever JSON the client saved: the app sends {text, offset, duration} objects. */
export interface Entry {
  videoId: string;
  url: string;
  title: string | null;
  savedAt: string;
  updatedAt: string;
  segments: unknown;
  digest: string | null;
  tags: string[];
  channel: string | null;
  channelUrl: string | null;
  transcriptSource: string | null;
  whisperModel: string | null;
}

/** What a library card shows. */
export interface Meta {
  videoId: string;
  url: string;
  title: string | null;
  savedAt: string;
  hasDigest: boolean;
  segmentCount: number;
  tags: string[];
  channel: string | null;
  channelUrl: string | null;
  transcriptSource: string | null;
  whisperModel: string | null;
}

export interface SearchResult { videoId: string; title: string | null; url: string; snippet: string; tags: string[] }

/** What saveEntry takes. The route has checked the types (see server.ts); `tags` only the legacy import passes. */
export interface SaveInput {
  url?: string | null;
  videoId: string;
  title?: string | null;
  segments?: unknown[] | null;
  digest?: string | null;
  tags?: unknown[] | null;
  channel?: string | null;
  channelUrl?: string | null;
  transcriptSource?: string | null;
  whisperModel?: string | null;
}

interface VideoRow {
  videoId: string; url: string; title: string | null; savedAt: string; updatedAt: string; segments: string;
  digest: string | null; channel: string | null; channelUrl: string | null; transcript_source: string | null;
  whisper_model: string | null;
}
interface ListRow {
  videoId: string; url: string; title: string | null; savedAt: string; segment_count: number; channel: string | null;
  channelUrl: string | null; transcript_source: string | null; whisper_model: string | null; hasDigest: number;
}
interface TagRow { videoId: string; tag: string }
interface Count { n: number }
interface Column { name: string }

const handles = new Map<string, Database>();

export function dbPathFor(owner: string): string {
  if (owner === DEFAULT_OWNER) return DB_FILE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner)) {
    throw new Error(`Invalid library owner id: ${JSON.stringify(String(owner).slice(0, 40))}`);
  }
  return join(LIBRARIES_DIR, `${owner}.db`);
}

const MAX_OPEN_LIBRARIES = 64;

function getDb(owner: string = DEFAULT_OWNER): Database {
  const existing = handles.get(owner);
  if (existing) {
    handles.delete(owner);
    handles.set(owner, existing);
    return existing;
  }
  while (handles.size >= MAX_OPEN_LIBRARIES) {
    const oldest = [...handles.keys()].find((k) => k !== DEFAULT_OWNER);
    if (oldest === undefined) break;
    try { handles.get(oldest)!.close(); } catch { /* already gone */ }
    handles.delete(oldest);
  }

  const file = dbPathFor(owner);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  handles.set(owner, db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  initSchema(owner);
  migrateSegmentCount(owner);
  migrateChannelColumns(owner);
  migrateTranscriptSourceColumns(owner);
  migrateFtsRowids(owner);
  if (owner === DEFAULT_OWNER) migrateFromLegacyJson(owner);
  return db;
}

export function closeAllLibraries(): void {
  for (const handle of handles.values()) {
    try { handle.close(); } catch { /* already gone */ }
  }
  handles.clear();
}

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

function initSchema(owner: string): void {
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

function columnNames(owner: string): Set<string> {
  return new Set(getDb(owner).query('PRAGMA table_info(videos)').all<Column>().map((c) => c.name));
}

function isDuplicateColumn(err: unknown): boolean {
  return err instanceof Error && /duplicate column/i.test(err.message || '');
}

/** The length of a JSON array, 0 for anything else, as `JSON.parse(x || '[]').length` with a catch reads it. */
function jsonArrayLength(text: string | null): number {
  try {
    const v: unknown = JSON.parse(text || '[]');
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

function migrateSegmentCount(owner: string): void {
  if (columnNames(owner).has('segment_count')) return;
  try {
    getDb(owner).exec('ALTER TABLE videos ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
    return;
  }
  const rows = getDb(owner).query('SELECT videoId, segments FROM videos').all<{ videoId: string; segments: string | null }>();
  const updateCount = getDb(owner).query('UPDATE videos SET segment_count = ? WHERE videoId = ?');
  for (const row of rows) updateCount.run(jsonArrayLength(row.segments), row.videoId);
}

function addTextColumns(owner: string, cols: string[]): void {
  const have = columnNames(owner);
  for (const col of cols) {
    if (have.has(col)) continue;
    try {
      getDb(owner).exec(`ALTER TABLE videos ADD COLUMN ${col} TEXT`);
    } catch (err) {
      if (!isDuplicateColumn(err)) throw err;
    }
  }
}

function migrateChannelColumns(owner: string): void {
  addTextColumns(owner, ['channel', 'channelUrl']);
}

function migrateTranscriptSourceColumns(owner: string): void {
  addTextColumns(owner, ['transcript_source', 'whisper_model']);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** JavaScript's String(v) for a JSON value: arrays joined with commas (null as ''), objects as [object Object]. */
export function jsString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((e) => (e === null || e === undefined ? '' : jsString(e))).join(',');
  return '[object Object]';
}

/** `[...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)` */
function sanitizeTags(tags: unknown[]): string[] {
  return [...new Set(tags.map((t) => jsString(t).trim()).filter((t) => t !== ''))].slice(0, 20);
}

function fetchFullEntry(owner: string, videoId: string): Entry | null {
  const row = getDb(owner).query('SELECT * FROM videos WHERE videoId = ?').get<VideoRow>(videoId);
  if (!row) return null;
  const tags = getDb(owner).query('SELECT tag FROM tags WHERE videoId = ? ORDER BY rowid').all<{ tag: string }>(videoId);
  const segments: unknown = JSON.parse(row.segments || '[]');
  return {
    videoId: row.videoId,
    url: row.url,
    title: row.title,
    savedAt: row.savedAt,
    updatedAt: row.updatedAt,
    segments,
    digest: row.digest ?? null,
    tags: tags.map((t) => t.tag),
    channel: row.channel ?? null,
    channelUrl: row.channelUrl ?? null,
    transcriptSource: row.transcript_source ?? null,
    whisperModel: row.whisper_model ?? null,
  };
}

function toMeta(entry: Entry): Meta {
  return {
    videoId: entry.videoId,
    url: entry.url,
    title: entry.title,
    savedAt: entry.savedAt,
    hasDigest: !!entry.digest,
    segmentCount: Array.isArray(entry.segments) ? entry.segments.length : 0,
    tags: entry.tags,
    channel: entry.channel ?? null,
    channelUrl: entry.channelUrl ?? null,
    transcriptSource: entry.transcriptSource ?? null,
    whisperModel: entry.whisperModel ?? null,
  };
}

function metaFromRow(row: ListRow, tags: string[] | undefined): Meta {
  return {
    videoId: row.videoId,
    url: row.url,
    title: row.title,
    savedAt: row.savedAt,
    hasDigest: !!row.hasDigest,
    segmentCount: row.segment_count || 0,
    tags: tags ?? [],
    channel: row.channel ?? null,
    channelUrl: row.channelUrl ?? null,
    transcriptSource: row.transcript_source ?? null,
    whisperModel: row.whisper_model ?? null,
  };
}

/**
 * One segment's `s.text || ''`. A null segment throws, as reading `.text` off it does in store.js; anything
 * else without a text field (a number, a string, an array) gives ''.
 */
function segmentText(s: unknown): string {
  if (s === null || s === undefined) throw new TypeError(`Cannot read properties of ${s === null ? 'null' : 'undefined'} (reading 'text')`);
  if (typeof s !== 'object' || Array.isArray(s)) return '';
  const text = (s as Record<string, unknown>).text;
  return text ? jsString(text) : '';
}

function syncFts(owner: string, videoId: string): void {
  const row = getDb(owner).query('SELECT rowid, title, segments, digest FROM videos WHERE videoId = ?')
    .get<{ rowid: number; title: string | null; segments: string | null; digest: string | null }>(videoId);
  if (!row) return;
  const segments: unknown = JSON.parse(row.segments || '[]');
  // store.js calls .map on whatever was stored; the routes only ever store arrays.
  const transcriptText = Array.isArray(segments) ? segments.map(segmentText).join(' ') : '';
  getDb(owner).query('DELETE FROM videos_fts WHERE rowid = ?').run(row.rowid);
  getDb(owner).query('INSERT INTO videos_fts(rowid, videoId, title, transcript_text, digest) VALUES (?, ?, ?, ?, ?)')
    .run(row.rowid, videoId, row.title ?? '', transcriptText, row.digest ?? '');
}

const FTS_ROWID_SCHEMA_VERSION = 1;

function migrateFtsRowids(owner: string): void {
  const version = getDb(owner).query('PRAGMA user_version').get<{ user_version: number }>()!.user_version;
  if (version >= FTS_ROWID_SCHEMA_VERSION) return;
  getDb(owner).exec('DELETE FROM videos_fts');
  const ids = getDb(owner).query('SELECT videoId FROM videos ORDER BY rowid').all<{ videoId: string }>();
  for (const { videoId } of ids) syncFts(owner, videoId);
  getDb(owner).exec(`PRAGMA user_version = ${FTS_ROWID_SCHEMA_VERSION}`);
}

/** A legacy library.json value as store.js binds it: strings and null as they are, anything else refused. */
function legacyText(v: unknown, fallback: string | null): string | null {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v;
  // shortcut: node:sqlite would store a number (as REAL text, "5.0") and refuse the rest; old Echo only wrote strings.
  throw new TypeError('Provided value cannot be bound to SQLite parameter.');
}

function migrateFromLegacyJson(owner: string): void {
  if (process.env.ECHO_DB_PATH) return;
  const count = getDb(owner).query('SELECT COUNT(*) as n FROM videos').get<Count>()!.n;
  if (count > 0) return;
  if (!existsSync(LEGACY_JSON)) return;

  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(LEGACY_JSON, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    entries = parsed;
  } catch {
    return;
  }

  const insertVideo = getDb(owner).query(`
    INSERT OR IGNORE INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, segment_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = getDb(owner).query('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)');

  let migrated = 0;
  getDb(owner).exec('BEGIN');
  try {
    for (const raw of entries) {
      const entry: Record<string, unknown> = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (!entry.videoId) continue;
      const videoId = legacyText(entry.videoId, null)!;
      // shortcut: locals, because Seshat neither types `x || []` with x unknown nor narrows `Array.isArray(entry.tags)`
      // on a field (gaps: unknown-or-empty-array, isarray-field-narrowing); store.js's expressions once fixed.
      const segments = entry.segments;
      const tags = entry.tags;
      const none: unknown[] = [];
      insertVideo.run(
        videoId,
        legacyText(entry.url, ''),
        legacyText(entry.title, null),
        legacyText(entry.savedAt, new Date().toISOString()),
        legacyText(entry.updatedAt, new Date().toISOString()),
        JSON.stringify(segments || none),
        legacyText(entry.digest, null),
        Array.isArray(segments) ? segments.length : 0,
      );
      for (const tag of sanitizeTags(Array.isArray(tags) ? tags : none)) insertTag.run(videoId, tag);
      syncFts(owner, videoId);
      migrated++;
    }
    getDb(owner).exec('COMMIT');
  } catch (err) {
    getDb(owner).exec('ROLLBACK');
    console.error('[store] Migration failed, rolled back:', err instanceof Error ? err.message : String(err));
    return;
  }
  console.log(`[store] Migrated ${migrated} entr${migrated === 1 ? 'y' : 'ies'} from library.json to SQLite.`);
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

async function countEntriesFor(owner: string): Promise<number> {
  return getDb(owner).query('SELECT COUNT(*) AS n FROM videos').get<Count>()!.n;
}

export interface ListOptions { limit?: number; offset?: number }

function tagsByVideo(rows: TagRow[]): Map<string, string[]> {
  const byVideo = new Map<string, string[]>();
  for (const t of rows) {
    const list = byVideo.get(t.videoId);
    if (list) list.push(t.tag); else byVideo.set(t.videoId, [t.tag]);
  }
  return byVideo;
}

async function listEntriesFor(owner: string, opts: ListOptions = {}): Promise<Meta[]> {
  const optLimit = opts.limit;
  const optOffset = opts.offset;
  const paged = optLimit !== undefined && Number.isFinite(optLimit) && optLimit > 0;
  const limit = paged ? Math.floor(optLimit) : -1;
  const offset = optOffset !== undefined && Number.isFinite(optOffset) && optOffset > 0 ? Math.floor(optOffset) : 0;

  const rows = getDb(owner).query(`
    SELECT videoId, url, title, savedAt, segment_count, channel, channelUrl,
           transcript_source, whisper_model, (digest IS NOT NULL) AS hasDigest
    FROM videos
    ORDER BY savedAt DESC
    LIMIT ? OFFSET ?
  `).all<ListRow>(limit, offset);
  if (rows.length === 0) return [];

  const allTags = paged
    ? getDb(owner)
      .query(`SELECT videoId, tag FROM tags WHERE videoId IN (${rows.map(() => '?').join(',')}) ORDER BY videoId, rowid`)
      .all<TagRow>(...rows.map((r) => r.videoId))
    : getDb(owner).query('SELECT videoId, tag FROM tags ORDER BY videoId, rowid').all<TagRow>();
  const byVideo = tagsByVideo(allTags);
  return rows.map((row) => metaFromRow(row, byVideo.get(row.videoId)));
}

async function getEntryFor(owner: string, videoId: string): Promise<Entry | null> {
  return fetchFullEntry(owner, videoId);
}

async function saveEntryFor(owner: string, input: SaveInput): Promise<Meta> {
  const { url, videoId, title, segments, digest, tags, channel, channelUrl, transcriptSource, whisperModel } = input;
  const now = new Date().toISOString();
  const existing = getDb(owner).query('SELECT * FROM videos WHERE videoId = ?').get<VideoRow>(videoId);
  const safeUrl = safeHttpUrl(url);

  if (!existing) {
    getDb(owner).query(`
      INSERT INTO videos (videoId, url, title, savedAt, updatedAt, segments, digest, segment_count, channel, channelUrl, transcript_source, whisper_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      safeUrl,
      title || null,
      now, now,
      JSON.stringify(segments || []),
      digest || null,
      Array.isArray(segments) ? segments.length : 0,
      channel || null,
      channelUrl || null,
      transcriptSource || null,
      whisperModel || null,
    );
    for (const tag of sanitizeTags(Array.isArray(tags) ? tags : [])) {
      getDb(owner).query('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
    }
  } else {
    const keepDigest = digest ? digest : existing.digest;
    const keepChannel = channel !== undefined ? (channel || null) : existing.channel;
    const keepChannelUrl = channelUrl !== undefined ? (channelUrl || null) : existing.channelUrl;
    const keepTranscriptSource = transcriptSource != null ? transcriptSource : existing.transcript_source;
    const keepWhisperModel = whisperModel != null ? whisperModel : existing.whisper_model;

    getDb(owner).query(`
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
    if (Array.isArray(tags)) {
      const sanitized = sanitizeTags(tags);
      getDb(owner).query('DELETE FROM tags WHERE videoId = ?').run(videoId);
      for (const tag of sanitized) {
        getDb(owner).query('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
      }
    }
  }

  syncFts(owner, videoId);
  return toMeta(fetchFullEntry(owner, videoId)!);
}

async function deleteEntryFor(owner: string, videoId: string): Promise<boolean> {
  const row = getDb(owner).query('SELECT rowid FROM videos WHERE videoId = ?').get<{ rowid: number }>(videoId);
  if (!row) return false;
  const result = getDb(owner).query('DELETE FROM videos WHERE videoId = ?').run(videoId);
  if (result.changes === 0) return false;
  getDb(owner).query('DELETE FROM videos_fts WHERE rowid = ?').run(row.rowid);
  return true;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

async function setTagsFor(owner: string, videoId: string, tags: unknown): Promise<Entry | null> {
  if (!getDb(owner).query('SELECT videoId FROM videos WHERE videoId = ?').get<{ videoId: string }>(videoId)) return null;
  const sanitized = Array.isArray(tags) ? sanitizeTags(tags) : [];
  getDb(owner).query('DELETE FROM tags WHERE videoId = ?').run(videoId);
  for (const tag of sanitized) {
    getDb(owner).query('INSERT OR IGNORE INTO tags (videoId, tag) VALUES (?, ?)').run(videoId, tag);
  }
  getDb(owner).query('UPDATE videos SET updatedAt = ? WHERE videoId = ?').run(new Date().toISOString(), videoId);
  return fetchFullEntry(owner, videoId);
}

// ---------------------------------------------------------------------------
// Full-text search (FTS5)
// ---------------------------------------------------------------------------

async function searchSummariesFor(owner: string, query: string, limit: number = 20): Promise<SearchResult[]> {
  if (!query || !query.trim()) return [];
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);

  let rows: { videoId: string; title: string | null; url: string; snippet: string | null }[];
  try {
    rows = getDb(owner).query(`
      SELECT f.videoId,
             v.title,
             v.url,
             snippet(videos_fts, -1, '', '', '…', 24) AS snippet
      FROM   videos_fts f
      JOIN   videos v ON v.videoId = f.videoId
      WHERE  videos_fts MATCH ?
      ORDER  BY rank
      LIMIT  ?
    `).all<{ videoId: string; title: string | null; url: string; snippet: string | null }>(query.trim(), capped);
  } catch (err) {
    console.error('[store] searchSummariesFor query failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.videoId);
  const tagRows = getDb(owner)
    .query(`SELECT videoId, tag FROM tags WHERE videoId IN (${ids.map(() => '?').join(',')}) ORDER BY videoId, rowid`)
    .all<TagRow>(...ids);
  const byVideo = tagsByVideo(tagRows);
  return rows.map((r) => ({
    videoId: r.videoId,
    title: r.title,
    url: r.url,
    snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
    tags: byVideo.get(r.videoId) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Library {
  countEntries: () => Promise<number>;
  listEntries: (opts?: ListOptions) => Promise<Meta[]>;
  getEntry: (videoId: string) => Promise<Entry | null>;
  saveEntry: (entry: SaveInput) => Promise<Meta>;
  deleteEntry: (videoId: string) => Promise<boolean>;
  setTags: (videoId: string, tags: unknown) => Promise<Entry | null>;
  searchSummaries: (query: string, limit?: number) => Promise<SearchResult[]>;
}

export function forOwner(owner: string = DEFAULT_OWNER): Library {
  return {
    countEntries: () => countEntriesFor(owner),
    listEntries: (opts?: ListOptions) => listEntriesFor(owner, opts),
    getEntry: (videoId: string) => getEntryFor(owner, videoId),
    saveEntry: (entry: SaveInput) => saveEntryFor(owner, entry),
    deleteEntry: (videoId: string) => deleteEntryFor(owner, videoId),
    setTags: (videoId: string, tags: unknown) => setTagsFor(owner, videoId, tags),
    searchSummaries: (query: string, limit?: number) => searchSummariesFor(owner, query, limit),
  };
}

const defaultLibrary = forOwner(DEFAULT_OWNER);
export const countEntries = defaultLibrary.countEntries;
export const listEntries = defaultLibrary.listEntries;
export const getEntry = defaultLibrary.getEntry;
export const saveEntry = defaultLibrary.saveEntry;
export const deleteEntry = defaultLibrary.deleteEntry;
export const setTags = defaultLibrary.setTags;
export const searchSummaries = defaultLibrary.searchSummaries;
