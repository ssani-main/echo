/**
 * Convert a saved Echo entry into clean, Obsidian-friendly Markdown.
 * Pure, dependency-free, and defensive against missing/partial fields.
 */

import { safeHttpUrl } from './sanitize.js';

/** Escape double-quotes inside a YAML-quoted scalar. */
function escapeYamlString(str) {
  return String(str || '').replace(/"/g, '\\"');
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
