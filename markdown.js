/**
 * Convert a saved Echo entry into clean, Obsidian-friendly Markdown.
 * Pure, dependency-free, and defensive against missing/partial fields.
 */

import { safeHttpUrl } from './sanitize.js';

/** Escape double-quotes inside a YAML-quoted scalar. */
function escapeYamlString(str) {
  return String(str || '').replace(/"/g, '\\"');
}

/** Format seconds as HH:MM:SS (always includes hours for clarity). */
function hhmmss(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Short date label for createdAt timestamps (falls back gracefully). */
function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Find the offset (in seconds) of the first transcript segment whose text
 * contains the highlight text (or vice-versa), case-insensitive, trimmed.
 * Returns null if no match is found.
 */
function findHighlightOffset(highlightText, segments) {
  if (!highlightText || !Array.isArray(segments) || segments.length === 0) return null;
  const needle = String(highlightText).trim().toLowerCase();
  if (!needle) return null;

  for (const seg of segments) {
    const segText = String(seg?.text || '').trim().toLowerCase();
    if (!segText) continue;
    if (segText.includes(needle) || needle.includes(segText)) {
      return typeof seg.offset === 'number' ? seg.offset : null;
    }
  }
  return null;
}

/** Build the base watch URL to append `&t=` deep-links to. */
function resolveWatchUrl(entry) {
  const url = entry?.url;
  if (url && /youtube\.com\/watch|youtu\.be\//i.test(url)) return url;
  if (entry?.videoId) return `https://www.youtube.com/watch?v=${entry.videoId}`;
  return safeHttpUrl(url);
}

/** Append a `t=<sec>s` deep-link param to a base URL, respecting existing query strings. */
function appendTimeParam(baseUrl, sec) {
  if (!baseUrl) return null;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}t=${Math.max(0, Math.floor(sec))}s`;
}

export function entryToMarkdown(entry, opts = {}) {
  const includeTranscript = opts.includeTranscript !== false;
  const e = entry || {};
  const title = e.title || 'Untitled';
  const url = e.url || (e.videoId ? `https://www.youtube.com/watch?v=${e.videoId}` : '');
  const tags = Array.isArray(e.tags) ? e.tags.filter(Boolean) : [];
  const notes = Array.isArray(e.notes) ? e.notes : [];
  const highlights = Array.isArray(e.highlights) ? e.highlights : [];
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
  lines.push(`savedAt: "${escapeYamlString(e.savedAt || '')}"`);
  lines.push(`favorite: ${e.favorite ? 'true' : 'false'}`);
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

  // --- Notes ---
  if (notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of notes) {
      const date = shortDate(n?.createdAt);
      const text = String(n?.text || '').trim();
      if (!text) continue;
      lines.push(date ? `- ${text} (${date})` : `- ${text}`);
    }
    lines.push('');
  }

  // --- Highlights ---
  if (highlights.length > 0) {
    const watchUrl = resolveWatchUrl(e);
    lines.push('## Highlights');
    lines.push('');
    for (const h of highlights) {
      const text = String(h?.text || '').trim();
      if (!text) continue;
      let line = `- "${text}"`;

      const offset = findHighlightOffset(text, segments);
      if (offset != null && watchUrl) {
        const jumpUrl = appendTimeParam(watchUrl, offset);
        if (jumpUrl) line += ` — [jump to ${hhmmss(offset)}](${jumpUrl})`;
      }

      if (h?.note) line += ` — ${String(h.note).trim()}`;

      lines.push(line);
    }
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
