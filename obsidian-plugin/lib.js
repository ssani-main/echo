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

// Both of these come from common/text.js — the plugin, the extension, the page
// and the server all need them identical, and they used to be four copies.
const { extractVideoId, extractSummary } = require('../common/text.js');

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
