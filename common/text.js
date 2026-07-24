// The one definition of the text logic that every Echo client needs.
//
// WHY THIS FILE EXISTS
// --------------------
// Four surfaces need the same two functions: the server, the web page, the
// browser extension and the Obsidian plugin. They were copies, and copies
// drift silently — extractSummary() was wrong in all three of its copies for
// months, returning nothing whenever a digest put a blank line after its
// "## TL;DR" heading, which is what a model actually writes. Every vault note
// shipped without a summary and nobody noticed, because each copy was equally
// wrong and no test compared them.
//
// CommonJS (see the scoped package.json) because that is the only dialect all
// the consumers can reach: Node ESM imports it, the Obsidian plugin requires
// it, and the test suite loads it via createRequire.
//
// The two surfaces that CANNOT import — the extension's classic content script
// and the page's inline <script> — keep their own copies, and
// tests/shared-parity.test.js runs a shared corpus through every copy and
// fails if any of them disagrees with this file. Drift is now loud.

/**
 * Extract an 11-character YouTube video ID from any URL form YouTube uses,
 * or return null.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
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
 * Pull a short, human-friendly summary out of a digest — prefers a TL;DR
 * section, falls back to the first non-heading paragraph.
 *
 * @param {string} digest
 * @param {number} [maxLen]
 * @returns {string}
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
    // Skip the blank line(s) between the heading and its paragraph. Breaking on
    // the first blank was the bug described at the top of this file.
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

module.exports = { extractVideoId, extractSummary };
