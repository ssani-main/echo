// Markdown vault sync — writes every saved library entry to a folder of
// plain .md files (Obsidian-friendly), so a user's saved videos live as
// real files on disk they fully own. Pure sync fs, mirrors store.js's style.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listEntries, getEntry } from './store.js';
import { entryToMarkdown } from './markdown.js';

const MAX_SLUG_LEN = 60;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * Turn an arbitrary string into a filesystem-safe slug: lowercase,
 * non-alphanumeric runs collapsed to a single '-', leading/trailing '-'
 * trimmed, capped at MAX_SLUG_LEN chars. Falls back to 'untitled' if the
 * result would be empty.
 *
 * @param {string} str
 * @returns {string}
 */
export function slugify(str) {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Sync the full saved library to `dir` as one Markdown file per entry.
 * Idempotent: re-running with no changes reports files as `unchanged`
 * rather than rewriting them. Never aborts on a single bad entry — those
 * are tallied as `failed` and skipped.
 *
 * @param {string} dir - target directory (created if missing)
 * @param {{ includeTranscript?: boolean }} [opts]
 * @returns {Promise<{ dir: string, total: number, written: number, unchanged: number, failed: number }>}
 */
export async function syncVault(dir, opts = {}) {
  if (typeof dir !== 'string' || !dir.trim()) {
    const err = new Error('A vault folder path is required.');
    err.echoCode = 'INVALID_URL';
    throw err;
  }

  const target = resolve(dir.trim());
  mkdirSync(target, { recursive: true });

  const includeTranscript = opts.includeTranscript !== false;
  const metas = await listEntries();

  let written = 0;
  let unchanged = 0;
  let failed = 0;

  for (const meta of metas) {
    try {
      const videoId = meta?.videoId;
      if (!videoId || !VIDEO_ID_RE.test(videoId)) {
        failed++;
        continue;
      }

      const entry = await getEntry(videoId);
      if (!entry) {
        failed++;
        continue;
      }

      const filename = `${slugify(entry.title || videoId)}-${videoId}.md`;
      const md = entryToMarkdown(entry, { includeTranscript });
      const filePath = join(target, filename);

      let existingContents = null;
      if (existsSync(filePath)) {
        try {
          existingContents = readFileSync(filePath, 'utf8');
        } catch {
          existingContents = null;
        }
      }

      if (existingContents === md) {
        unchanged++;
      } else {
        writeFileSync(filePath, md, 'utf8');
        written++;
      }
    } catch {
      failed++;
    }
  }

  return { dir: target, total: metas.length, written, unchanged, failed };
}
