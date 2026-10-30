// Port of ../vault.js: slugify and monthFolder (checked by check/vault.cases.ts) and syncVault, which
// writes the library to a folder of Markdown notes (checked through POST /api/vault/sync by check/routes.sh).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { forOwner, type Entry, type Library } from './store.ts';
import { jsString } from './js.ts';
import { entryToMarkdown, extractSummary, buildVaultIndex, type Entry as MarkdownEntry, type Segment, type VaultItem } from './markdown.ts';
import { EchoError } from './errors.ts';

const MAX_SLUG_LEN = 60;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * Turn an arbitrary string into a filesystem-safe slug: lowercase,
 * non-alphanumeric runs collapsed to a single '-', leading/trailing '-'
 * trimmed, capped at MAX_SLUG_LEN chars; 'untitled' if nothing is left.
 */
export function slugify(str: string | null | undefined): string {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Bucket an entry into a `YYYY-MM` subfolder by its save date (UTC);
 * invalid/missing dates go to `Undated`.
 */
export function monthFolder(savedAt: string | null | undefined): string {
  const d = savedAt ? new Date(savedAt) : null;
  if (!d || isNaN(d.getTime())) return 'Undated';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * A segment's text as markdown.ts's String() turns it into text.
 * shortcut: an array as JavaScript's String() writes it, because Seshat's writes a nested null as "null"
 * (gap: string-of-nested-array); the value as it is once fixed.
 */
function textOf(text: unknown): unknown {
  return Array.isArray(text) ? jsString(text) : text;
}

/** A stored entry as entryToMarkdown reads it: a segment that isn't an object has no text, so it reads as null. */
export function markdownEntry(entry: Entry): MarkdownEntry {
  const segments = Array.isArray(entry.segments)
    ? entry.segments.map((s): Segment | null => (typeof s === 'object' && s !== null && !Array.isArray(s) ? { text: textOf((s as Record<string, unknown>).text) } : null))
    : [];
  return { title: entry.title, url: entry.url, videoId: entry.videoId, tags: entry.tags, segments, digest: entry.digest, savedAt: entry.savedAt };
}

/** Read a file as UTF-8, or null if it can't be read. */
function readOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export interface VaultResult { dir: string; total: number; written: number; unchanged: number; failed: number; index: string }

/**
 * Sync the whole library to `dir`, one Markdown file per entry in YYYY-MM folders, plus the
 * "Echo Library.md" index. Unchanged files aren't rewritten; a bad entry counts as failed and is skipped.
 */
export async function syncVault(dir: unknown, opts: { includeTranscript?: unknown; library?: Library } = {}): Promise<VaultResult> {
  const lib = opts.library ?? forOwner();
  if (typeof dir !== 'string' || !dir.trim()) throw new EchoError('A vault folder path is required.', 'INVALID_URL');

  const target = resolve(dir.trim());
  mkdirSync(target, { recursive: true });

  const includeTranscript = opts.includeTranscript !== false;
  const metas = await lib.listEntries();

  let written = 0;
  let unchanged = 0;
  let failed = 0;
  const indexItems: VaultItem[] = [];

  for (const meta of metas) {
    try {
      const videoId = meta.videoId;
      if (!videoId || !VIDEO_ID_RE.test(videoId)) {
        failed++;
        continue;
      }
      const entry = await lib.getEntry(videoId);
      if (!entry) {
        failed++;
        continue;
      }

      const filename = `${slugify(entry.title || videoId)}-${videoId}.md`;
      indexItems.push({
        link: filename.replace(/\.md$/, ''),
        title: entry.title || videoId,
        savedAt: entry.savedAt || '',
        tags: entry.tags.filter((t) => t !== ''),
        summary: extractSummary(entry.digest),
      });

      const md = entryToMarkdown(markdownEntry(entry), { includeTranscript });
      const subDir = join(target, monthFolder(entry.savedAt));
      mkdirSync(subDir, { recursive: true });
      const filePath = join(subDir, filename);
      if (readOrNull(filePath) === md) {
        unchanged++;
      } else {
        writeFileSync(filePath, md, 'utf8');
        written++;
      }
    } catch {
      failed++;
    }
  }

  let index = 'skipped';
  if (indexItems.length > 0) {
    const indexMd = buildVaultIndex(indexItems);
    const indexPath = join(target, 'Echo Library.md');
    if (readOrNull(indexPath) === indexMd) {
      index = 'unchanged';
    } else {
      writeFileSync(indexPath, indexMd, 'utf8');
      index = 'written';
    }
  }

  return { dir: target, total: metas.length, written, unchanged, failed, index };
}
