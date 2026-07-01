import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
const LIBRARY_FILE = join(DATA_DIR, 'library.json');

/**
 * Read the raw entries array from disk.
 * Returns [] on any error (missing file, empty file, parse failure).
 */
async function readEntries() {
  try {
    const raw = await readFile(LIBRARY_FILE, 'utf8');
    if (!raw.trim()) return [];
    return JSON.parse(raw);
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
 * Map a full entry to its metadata-only representation.
 */
function toMeta(entry) {
  return {
    videoId: entry.videoId,
    url: entry.url,
    title: entry.title,
    savedAt: entry.savedAt,
    hasDigest: !!entry.digest,
    segmentCount: entry.segments?.length || 0,
  };
}

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
 * Return the full entry object for a given videoId, or null if not found.
 */
export async function getEntry(videoId) {
  const entries = await readEntries();
  return entries.find((e) => e.videoId === videoId) ?? null;
}

/**
 * Upsert an entry by videoId.
 * Returns the metadata object for the saved entry.
 */
export async function saveEntry({ url, videoId, title, segments, digest }) {
  const entries = await readEntries();
  const now = new Date().toISOString();
  const idx = entries.findIndex((e) => e.videoId === videoId);

  if (idx === -1) {
    // New entry
    entries.push({
      videoId,
      url,
      title: title || null,
      savedAt: now,
      updatedAt: now,
      segments: segments || [],
      digest: digest || null,
    });
  } else {
    // Existing entry — keep savedAt, update the rest
    const existing = entries[idx];
    entries[idx] = {
      ...existing,
      url,
      title: title || null,
      updatedAt: now,
      segments: segments || [],
      // Keep existing digest if incoming digest is absent/empty
      digest: digest ? digest : existing.digest,
    };
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
