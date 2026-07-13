/**
 * Convert a saved Echo entry into clean, Obsidian-friendly Markdown.
 * Pure, dependency-free, and defensive against missing/partial fields.
 */

import { safeHttpUrl } from './sanitize.js';

/** Escape double-quotes inside a YAML-quoted scalar. */
function escapeYamlString(str) {
  return String(str || '').replace(/"/g, '\\"');
}

/**
 * Pull a short, human-friendly summary out of a digest — prefers a TL;DR
 * section, falls back to the first non-heading paragraph. Pure/deterministic.
 *
 * @param {string} digest
 * @param {number} [maxLen]
 * @returns {string}
 */
export function extractSummary(digest, maxLen = 240) {
  const text = String(digest || '').trim();
  if (!text) return '';

  const lines = text.split('\n');
  const tldrRe = /^#{1,6}\s*tl;?dr/i;
  const headingRe = /^#{1,6}\s/;

  let collected = [];
  const tldrIdx = lines.findIndex((l) => tldrRe.test(l.trim()));
  if (tldrIdx !== -1) {
    for (let i = tldrIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) break;
      if (headingRe.test(line.trim())) break;
      collected.push(line);
    }
  } else {
    // Fallback: first non-empty, non-heading paragraph.
    let started = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!started) {
        if (!trimmed) continue;
        if (headingRe.test(trimmed)) continue;
        started = true;
        collected.push(line);
      } else {
        if (!trimmed) break;
        if (headingRe.test(trimmed)) break;
        collected.push(line);
      }
    }
  }

  let summary = collected
    .join(' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (summary.length > maxLen) {
    summary = summary.slice(0, maxLen - 1).trimEnd() + '…';
  }

  return summary;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function wikilinkAlias(title) {
  return String(title || '').replace(/[[\]]/g, '').replace(/\|/g, '-');
}

function renderBullet(item) {
  const alias = wikilinkAlias(item.title);
  const summaryPart = item.summary ? ` — ${item.summary}` : '';
  return `- [[${item.link}|${alias}]]${summaryPart}`;
}

/**
 * Render the vault dashboard note ("Echo Library.md") for a set of synced
 * entries. Pure and deterministic given the same input.
 *
 * @param {Array<{link:string, title:string, savedAt:string, tags:string[], summary:string}>} items
 * @returns {string}
 */
export function buildVaultIndex(items) {
  const list = Array.isArray(items) ? items : [];

  const lines = [];
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
  const buckets = new Map(); // label -> { year, month, items: [] }
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
    buckets.get(label).items.push(item);
  }

  const bucketLabels = Array.from(buckets.keys()).sort((a, b) => {
    if (a === 'Undated') return 1;
    if (b === 'Undated') return -1;
    const ba = buckets.get(a);
    const bb = buckets.get(b);
    if (ba.year !== bb.year) return bb.year - ba.year;
    return bb.month - ba.month;
  });

  lines.push('## By date');
  lines.push('');
  for (const label of bucketLabels) {
    const bucket = buckets.get(label);
    const sorted = [...bucket.items];
    if (label !== 'Undated') {
      sorted.sort((a, b) => {
        const da = new Date(a.savedAt).getTime();
        const db = new Date(b.savedAt).getTime();
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
  const tagMap = new Map(); // tag -> items[]
  for (const item of list) {
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(item);
    }
  }
  const clusteredTags = Array.from(tagMap.keys()).filter((t) => tagMap.get(t).length >= 2);
  if (clusteredTags.length > 0) {
    const tagNames = clusteredTags.sort((a, b) => {
      const countA = tagMap.get(a).length;
      const countB = tagMap.get(b).length;
      if (countA !== countB) return countB - countA;
      return a.localeCompare(b);
    });

    lines.push('## By topic');
    lines.push('');
    for (const tag of tagNames) {
      const members = [...tagMap.get(tag)].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
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
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  );
  for (const item of allSorted) {
    const alias = wikilinkAlias(item.title);
    lines.push(`- [[${item.link}|${alias}]]`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function entryToMarkdown(entry, opts = {}) {
  const includeTranscript = opts.includeTranscript !== false;
  const e = entry || {};
  const title = e.title || 'Untitled';
  const url = e.url || (e.videoId ? `https://www.youtube.com/watch?v=${e.videoId}` : '');
  const tags = Array.isArray(e.tags) ? e.tags.filter(Boolean) : [];
  const segments = Array.isArray(e.segments) ? e.segments : [];

  const lines = [];

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
