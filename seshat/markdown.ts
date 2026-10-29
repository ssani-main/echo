/**
 * Port of ../markdown.js: a saved Echo entry as clean, Obsidian-friendly
 * Markdown, and the vault's dashboard note. Pure, dependency-free, and
 * defensive against missing/partial fields. Checked against the original by
 * check/markdown.cases.ts.
 */

import { safeHttpUrl } from './sanitize.ts';
import { extractSummary } from './text.ts';

// extractSummary lives in text.ts (the port of common/text.js).
export { extractSummary };

// The original also takes junk types (tags: 'ai', segments: 42) and ignores them. Here the types are
// what store.js produces (tags from its own table, segments as stored JSON), so a wrong type is refused
// where the JSON is parsed (the route's trust boundary) instead of inside the formatter.

/** One transcript segment; only `text` is read. */
export interface Segment {
  text?: unknown;
}

/** A library entry as store.js returns it; every field may be missing. */
export interface Entry {
  title?: string | null;
  url?: string | null;
  videoId?: string | null;
  tags?: string[] | null;
  segments?: (Segment | null)[] | null;
  digest?: string | null;
  savedAt?: string | null;
}

/** One synced note, as vault.js hands it to buildVaultIndex. */
export interface VaultItem {
  link: string;
  title: string;
  savedAt?: string | null;
  tags?: string[] | null;
  summary?: string | null;
}

/** Escape double-quotes inside a YAML-quoted scalar. */
function escapeYamlString(str: unknown): string {
  return String(str || '').replace(/"/g, '\\"');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function wikilinkAlias(title: unknown): string {
  return String(title || '').replace(/[[\]]/g, '').replace(/\|/g, '-');
}

function renderBullet(item: VaultItem): string {
  const alias = wikilinkAlias(item.title);
  const summaryPart = item.summary ? ` — ${item.summary}` : '';
  return `- [[${item.link}|${alias}]]${summaryPart}`;
}

function truthyTags(tags: string[] | null | undefined): string[] {
  return Array.isArray(tags) ? tags.filter(Boolean) : [];
}

// shortcut: NFKC first, because Seshat's collation sorts ligatures, fullwidth letters and unit symbols
// (ﬁ, Ａ, ㎏) after every other letter (gap: localecompare-compat-chars); at base strength ICU already reads
// them as their NFKC form, so Node's order is unchanged. Drop the normalize() calls once fixed.
function compareBase(a: string, b: string): number {
  return a.normalize('NFKC').localeCompare(b.normalize('NFKC'), undefined, { sensitivity: 'base' });
}

interface Bucket {
  year: number;
  month: number;
  items: VaultItem[];
}

/**
 * Render the vault dashboard note ("Echo Library.md") for a set of synced
 * entries. Pure and deterministic given the same input.
 */
export function buildVaultIndex(items: VaultItem[] | null | undefined): string {
  const list: VaultItem[] = Array.isArray(items) ? items : [];

  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Echo Library');
  lines.push('tags: [echo/index]');
  lines.push('---');
  lines.push('');
  lines.push('# Echo Library');
  lines.push('');
  lines.push(`\`${list.length} saved video${list.length === 1 ? '' : 's'}\``);
  lines.push('');

  // --- By date ---
  const buckets = new Map<string, Bucket>();
  for (const item of list) {
    let label = 'Undated';
    let year = -Infinity;
    let month = -Infinity;
    const d = item.savedAt ? new Date(item.savedAt) : null;
    if (d && !isNaN(d.getTime())) {
      year = d.getUTCFullYear();
      month = d.getUTCMonth();
      label = `${MONTHS[month]} ${year}`;
    }
    if (!buckets.has(label)) {
      buckets.set(label, { year, month, items: [] });
    }
    buckets.get(label)!.items.push(item);
  }

  const bucketLabels = Array.from(buckets.keys()).sort((a, b) => {
    if (a === 'Undated') return 1;
    if (b === 'Undated') return -1;
    const ba = buckets.get(a)!;
    const bb = buckets.get(b)!;
    if (ba.year !== bb.year) return bb.year - ba.year;
    return bb.month - ba.month;
  });

  lines.push('## By date');
  lines.push('');
  for (const label of bucketLabels) {
    const bucket = buckets.get(label)!;
    const sorted = [...bucket.items];
    if (label !== 'Undated') {
      sorted.sort((a, b) => {
        const da = new Date(a.savedAt!).getTime();
        const db = new Date(b.savedAt!).getTime();
        return db - da;
      });
    }
    lines.push(`### ${label}`);
    lines.push('');
    for (const item of sorted) {
      lines.push(renderBullet(item));
    }
    lines.push('');
  }

  // --- By topic ---
  // Only surface tags that actually cluster (>= 2 videos). Singleton tags
  // would just recreate a flat wall here — they stay discoverable through
  // each note's frontmatter tags in Obsidian's built-in tag pane.
  const tagMap = new Map<string, VaultItem[]>();
  for (const item of list) {
    for (const tag of truthyTags(item.tags)) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(item);
    }
  }
  const clusteredTags = Array.from(tagMap.keys()).filter((t) => tagMap.get(t)!.length >= 2);
  if (clusteredTags.length > 0) {
    const tagNames = clusteredTags.sort((a, b) => {
      const countA = tagMap.get(a)!.length;
      const countB = tagMap.get(b)!.length;
      if (countA !== countB) return countB - countA;
      return a.localeCompare(b);
    });

    lines.push('## By topic');
    lines.push('');
    for (const tag of tagNames) {
      const members = [...tagMap.get(tag)!].sort((a, b) =>
        compareBase(a.title, b.title)
      );
      lines.push(`- **${tag}** (${members.length})`);
      for (const item of members) {
        const alias = wikilinkAlias(item.title);
        lines.push(`  - [[${item.link}|${alias}]]`);
      }
    }
    lines.push('');
  }

  // --- All notes ---
  lines.push('## All notes');
  lines.push('');
  const allSorted = [...list].sort((a, b) =>
    compareBase(a.title, b.title)
  );
  for (const item of allSorted) {
    const alias = wikilinkAlias(item.title);
    lines.push(`- [[${item.link}|${alias}]]`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function entryToMarkdown(entry: Entry | null | undefined, opts: { includeTranscript?: boolean } = {}): string {
  const includeTranscript = opts.includeTranscript !== false;
  const e: Entry = entry || {};
  const title = e.title || 'Untitled';
  const url = e.url || (e.videoId ? `https://www.youtube.com/watch?v=${e.videoId}` : '');
  const tags = truthyTags(e.tags);
  const segments = Array.isArray(e.segments) ? e.segments : [];

  const lines: string[] = [];

  // --- Frontmatter ---
  lines.push('---');
  lines.push(`title: "${escapeYamlString(title)}"`);
  lines.push(`url: "${escapeYamlString(safeHttpUrl(url))}"`);
  lines.push(`videoId: "${escapeYamlString(e.videoId || '')}"`);
  if (tags.length > 0) {
    const flowList = tags.map((t) => `"${escapeYamlString(t)}"`).join(', ');
    lines.push(`tags: [${flowList}]`);
  }
  const summary = extractSummary(e.digest);
  if (summary) lines.push(`summary: "${escapeYamlString(summary)}"`);
  lines.push(`savedAt: "${escapeYamlString(e.savedAt || '')}"`);
  lines.push('---');
  lines.push('');

  // --- Title & source ---
  lines.push(`# ${title}`);
  lines.push('');
  const safeSrc = safeHttpUrl(url);
  if (safeSrc) {
    lines.push(`**Source:** [${safeSrc}](${safeSrc})`);
    lines.push('');
  }

  // --- Digest ---
  if (e.digest && String(e.digest).trim()) {
    lines.push('## Digest');
    lines.push('');
    lines.push(String(e.digest).trim());
    lines.push('');
  }

  // --- Transcript ---
  if (includeTranscript && segments.length > 0) {
    lines.push('## Transcript');
    lines.push('');
    const text = segments
      .map((s) => String(s?.text || '').trim())
      .filter(Boolean)
      .join(' ');
    lines.push(text);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
