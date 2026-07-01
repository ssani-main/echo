import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
const LIBRARY_FILE = join(DATA_DIR, 'library.json');

// Monotonic counter used alongside Date.now() to guarantee unique IDs within
// a single process even when multiple calls land in the same millisecond.
let _idCounter = 0;

/**
 * Generate a collision-safe ID string: "<timestamp>-<counter>".
 * Uses Date.now() (safe in Node.js server context) plus a per-process counter
 * so rapid successive calls never produce the same value.
 */
function generateId() {
  _idCounter += 1;
  return `${Date.now()}-${_idCounter}`;
}

/**
 * Apply default values for the four optional extension fields so that old
 * entries stored on disk before these fields existed continue to work.
 * Returns a new object — does NOT mutate the original.
 */
function normalizeEntry(entry) {
  return {
    ...entry,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    favorite: typeof entry.favorite === 'boolean' ? entry.favorite : false,
    notes: Array.isArray(entry.notes) ? entry.notes : [],
    highlights: Array.isArray(entry.highlights) ? entry.highlights : [],
  };
}

/**
 * Read the raw entries array from disk, normalizing each entry.
 * Returns [] on any error (missing file, empty file, parse failure).
 */
async function readEntries() {
  try {
    const raw = await readFile(LIBRARY_FILE, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return parsed.map(normalizeEntry);
  } catch {
    return [];
  }
}

/**
 * Write the entries array to disk as pretty JSON.
 * Ensures the data directory exists first.
 */
async function writeEntries(entries) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LIBRARY_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Read-modify-write helper for single-entry mutations.
 * Calls mutatorFn(entry) — mutatorFn may mutate in place or return a new
 * object; the return value is used as the replacement.
 * Throws if videoId is not found (same error style as deleteEntry returning false).
 * Returns the updated (normalized) entry.
 */
async function updateEntry(videoId, mutatorFn) {
  const entries = await readEntries();
  const idx = entries.findIndex((e) => e.videoId === videoId);
  if (idx === -1) return null;
  const updated = normalizeEntry(await mutatorFn(entries[idx]) ?? entries[idx]);
  entries[idx] = updated;
  await writeEntries(entries);
  return updated;
}

/**
 * Map a full entry to its metadata-only representation.
 * Includes tags, favorite, and derived counts for notes/highlights.
 * Does NOT include segments, notes bodies, highlights bodies, or digest text.
 */
function toMeta(entry) {
  return {
    videoId: entry.videoId,
    url: entry.url,
    title: entry.title,
    savedAt: entry.savedAt,
    hasDigest: !!entry.digest,
    segmentCount: entry.segments?.length || 0,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    favorite: typeof entry.favorite === 'boolean' ? entry.favorite : false,
    noteCount: Array.isArray(entry.notes) ? entry.notes.length : 0,
    highlightCount: Array.isArray(entry.highlights) ? entry.highlights.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Return metadata for all saved entries, sorted by savedAt descending (newest first).
 */
export async function listEntries() {
  const entries = await readEntries();
  return entries
    .slice()
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
    .map(toMeta);
}

/**
 * Return the full normalized entry object for a given videoId, or null if not found.
 */
export async function getEntry(videoId) {
  const entries = await readEntries();
  return entries.find((e) => e.videoId === videoId) ?? null;
}

/**
 * Upsert an entry by videoId.
 * Preserves existing digest, tags, favorite, notes, highlights when the
 * incoming payload omits them.
 * Returns the metadata object for the saved entry.
 */
export async function saveEntry({ url, videoId, title, segments, digest, tags, favorite, notes, highlights }) {
  const entries = await readEntries();
  const now = new Date().toISOString();
  const idx = entries.findIndex((e) => e.videoId === videoId);

  if (idx === -1) {
    // New entry
    entries.push(normalizeEntry({
      videoId,
      url,
      title: title || null,
      savedAt: now,
      updatedAt: now,
      segments: segments || [],
      digest: digest || null,
      tags: Array.isArray(tags) ? tags : [],
      favorite: typeof favorite === 'boolean' ? favorite : false,
      notes: Array.isArray(notes) ? notes : [],
      highlights: Array.isArray(highlights) ? highlights : [],
    }));
  } else {
    // Existing entry — preserve savedAt and any fields not included in payload
    const existing = entries[idx];
    entries[idx] = normalizeEntry({
      ...existing,
      url,
      title: title || null,
      updatedAt: now,
      segments: segments || [],
      // Keep existing digest if incoming digest is absent/empty
      digest: digest ? digest : existing.digest,
      // Preserve existing extension fields unless explicitly provided
      tags: Array.isArray(tags) ? tags : existing.tags,
      favorite: typeof favorite === 'boolean' ? favorite : existing.favorite,
      notes: Array.isArray(notes) ? notes : existing.notes,
      highlights: Array.isArray(highlights) ? highlights : existing.highlights,
    });
  }

  await writeEntries(entries);

  const saved = entries.find((e) => e.videoId === videoId);
  return toMeta(saved);
}

/**
 * Remove the entry with the given videoId.
 * Returns true if an entry was removed, false if it wasn't found.
 */
export async function deleteEntry(videoId) {
  const entries = await readEntries();
  const idx = entries.findIndex((e) => e.videoId === videoId);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  await writeEntries(entries);
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
  const sanitized = Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
    : [];

  return updateEntry(videoId, (entry) => {
    entry.tags = sanitized;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Favorite
// ---------------------------------------------------------------------------

/**
 * Set the favorite boolean for an entry.
 * Returns the updated full entry, or null if videoId not found.
 */
export async function setFavorite(videoId, favorite) {
  return updateEntry(videoId, (entry) => {
    entry.favorite = Boolean(favorite);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Append a new note to an entry's notes array.
 * Returns the created note object (not the full entry), or null if not found.
 */
export async function addNote(videoId, text) {
  const note = {
    id: generateId(),
    text: String(text ?? '').trim(),
    createdAt: new Date().toISOString(),
  };

  const updated = await updateEntry(videoId, (entry) => {
    entry.notes.push(note);
    return entry;
  });

  return updated === null ? null : note;
}

/**
 * Remove a note by id from an entry.
 * Returns true if the note was found and removed, false if the note didn't
 * exist (but the entry did), or null if the videoId wasn't found.
 */
export async function deleteNote(videoId, noteId) {
  let removed = false;

  const updated = await updateEntry(videoId, (entry) => {
    const before = entry.notes.length;
    entry.notes = entry.notes.filter((n) => n.id !== noteId);
    removed = entry.notes.length < before;
    return entry;
  });

  if (updated === null) return null;
  return removed;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/**
 * Sanitize a single raw highlight object into the canonical shape.
 * Assigns id and createdAt if missing; requires text to be a non-empty string.
 * Returns null if text is absent or empty.
 */
function sanitizeHighlight(raw) {
  const text = String(raw?.text ?? '').trim();
  if (!text) return null;
  return {
    id: raw.id ?? generateId(),
    text,
    note: raw.note != null ? String(raw.note) : undefined,
    color: raw.color != null ? String(raw.color) : undefined,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Replace the highlights array for an entry.
 * Sanitizes each highlight (must have text; assigns id/createdAt if missing).
 * Drops any highlight missing a text value.
 * Returns the updated full entry, or null if videoId not found.
 */
export async function setHighlights(videoId, highlights) {
  const sanitized = Array.isArray(highlights)
    ? highlights.map(sanitizeHighlight).filter(Boolean)
    : [];

  return updateEntry(videoId, (entry) => {
    entry.highlights = sanitized;
    return entry;
  });
}

/**
 * Append a single highlight to an entry's highlights array.
 * Returns the created highlight object, or null if videoId not found.
 */
export async function addHighlight(videoId, { text, note, color } = {}) {
  const highlight = sanitizeHighlight({ text, note, color });
  if (!highlight) throw new Error('highlight.text is required and must be a non-empty string');

  const updated = await updateEntry(videoId, (entry) => {
    entry.highlights.push(highlight);
    return entry;
  });

  return updated === null ? null : highlight;
}

/**
 * Remove a highlight by id from an entry.
 * Returns true if the highlight was found and removed, false if the highlight
 * didn't exist (but the entry did), or null if the videoId wasn't found.
 */
export async function deleteHighlight(videoId, highlightId) {
  let removed = false;

  const updated = await updateEntry(videoId, (entry) => {
    const before = entry.highlights.length;
    entry.highlights = entry.highlights.filter((h) => h.id !== highlightId);
    removed = entry.highlights.length < before;
    return entry;
  });

  if (updated === null) return null;
  return removed;
}
