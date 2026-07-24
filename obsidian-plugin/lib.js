// Pure helpers for the Echo Obsidian plugin.
//
// Split out from main.js so they can be unit-tested: main.js requires
// 'obsidian', which only exists inside the app, so nothing that imports it can
// run in the test suite. Everything here is plain data in, string out.
//
// The note format deliberately mirrors markdown.js's entryToMarkdown() on the
// server. A vault holding notes from BOTH the plugin and `/api/vault/sync`
// should not be able to tell which made which — same frontmatter keys, same
// section order, same summary extraction.

const MAX_SLUG_LEN = 60;

/** Escape a double-quoted YAML scalar. Mirrors markdown.js. */
function escapeYaml(str) {
  return String(str || '').replace(/"/g, '\\"');
}

/**
 * Filesystem-safe slug. Mirrors vault.js slugify() so a title produces the
 * same filename whichever path wrote it.
 */
function slugify(str) {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Accept only http(s). The value is used to build a request URL, and a host
 * check would not catch `javascript:` — new URL('javascript:x').host is ''.
 * Same rule as the browser extension and the server.
 */
function normalizeServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/** Extract an 11-char YouTube id. Mirrors transcript.js extractVideoId(). */
function extractVideoId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})(?:[&\s]|$)/,
    /youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  return null;
}

/**
 * Pull a short summary out of a digest — prefers a TL;DR section, falls back to
 * the first non-heading paragraph. Mirrors markdown.js extractSummary().
 */
function extractSummary(digest, maxLen = 240) {
  const text = String(digest || '').trim();
  if (!text) return '';

  const lines = text.split('\n');
  const tldrRe = /^#{1,6}\s*tl;?dr/i;
  const headingRe = /^#{1,6}\s/;

  const collected = [];
  const tldrIdx = lines.findIndex((l) => tldrRe.test(l.trim()));
  if (tldrIdx !== -1) {
    // Skip the blank line(s) between the heading and its paragraph before
    // collecting. Breaking on the first blank meant a digest written as
    // "## TL;DR\n\nThe point." — i.e. ordinary Markdown, and what the model
    // actually emits — yielded an empty summary, so most vault notes shipped
    // with no `summary:` frontmatter and the dashboard index lost its blurbs.
    let i = tldrIdx + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) break;
      if (headingRe.test(line.trim())) break;
      collected.push(line);
    }
  } else {
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

  if (summary.length > maxLen) summary = `${summary.slice(0, maxLen - 1).trimEnd()}…`;
  return summary;
}

/**
 * Build the note. Mirrors markdown.js entryToMarkdown(), plus a `channel` key
 * the server version does not emit (the plugin has it to hand and it is useful
 * for Dataview queries over a vault).
 *
 * @param {object} entry
 * @param {{ includeTranscript?: boolean }} [opts]
 * @returns {string}
 */
function buildNote(entry, opts = {}) {
  const includeTranscript = opts.includeTranscript !== false;
  const e = entry || {};
  const title = e.title || 'Untitled';
  const url = e.url || (e.videoId ? `https://www.youtube.com/watch?v=${e.videoId}` : '');
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  const tags = Array.isArray(e.tags) ? e.tags.filter(Boolean) : [];
  const segments = Array.isArray(e.segments) ? e.segments : [];

  const lines = [];
  lines.push('---');
  lines.push(`title: "${escapeYaml(title)}"`);
  lines.push(`url: "${escapeYaml(safeUrl)}"`);
  lines.push(`videoId: "${escapeYaml(e.videoId || '')}"`);
  if (e.channel) lines.push(`channel: "${escapeYaml(e.channel)}"`);
  if (tags.length > 0) lines.push(`tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]`);
  const summary = extractSummary(e.digest);
  if (summary) lines.push(`summary: "${escapeYaml(summary)}"`);
  lines.push(`savedAt: "${escapeYaml(e.savedAt || '')}"`);
  lines.push('---');
  lines.push('');

  lines.push(`# ${title}`);
  lines.push('');
  if (safeUrl) {
    lines.push(`**Source:** [${safeUrl}](${safeUrl})`);
    lines.push('');
  }

  if (e.digest && String(e.digest).trim()) {
    lines.push('## Digest');
    lines.push('');
    lines.push(String(e.digest).trim());
    lines.push('');
  }

  if (includeTranscript && segments.length > 0) {
    lines.push('## Transcript');
    lines.push('');
    lines.push(segments.map((s) => String((s && s.text) || '').trim()).filter(Boolean).join(' '));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * Vault-relative path for a note. Same `<slug>-<videoId>.md` shape vault.js
 * writes, so the plugin and folder-sync do not produce two files per video.
 */
function notePath(folder, title, videoId) {
  const name = `${slugify(title || videoId)}-${videoId}.md`;
  const dir = String(folder || '').replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${name}` : name;
}

/** Map the fidelity dial to the API's format/length pair — same rule as the web UI. */
function fidelityParams(fidelity) {
  const format = ['bullets', 'digest', 'article'].includes(fidelity) ? fidelity : 'digest';
  return { format, length: format === 'bullets' ? 'short' : 'detailed' };
}

module.exports = {
  escapeYaml,
  slugify,
  normalizeServer,
  extractVideoId,
  extractSummary,
  buildNote,
  notePath,
  fidelityParams,
};
