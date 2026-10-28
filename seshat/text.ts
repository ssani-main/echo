// Port of ../common/text.js (extractVideoId, extractSummary). That file is the
// definition every client shares; this copy is checked against it byte for
// byte by check/text.cases.ts, the same way tests/shared-parity.test.js checks
// the browser copies.

/** Extract an 11-character YouTube video ID from any URL form YouTube uses, or return null. */
export function extractVideoId(rawUrl: unknown): string | null {
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
    if (m) return m[1]!;
  }

  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  return null;
}

/**
 * Pull a short, human-friendly summary out of a digest — prefers a TL;DR
 * section, falls back to the first non-heading paragraph.
 */
export function extractSummary(digest: unknown, maxLen: number = 240): string {
  const text = String(digest || '').trim();
  if (!text) return '';

  const lines = text.split('\n');
  const tldrRe = /^#{1,6}\s*tl;?dr/i;
  const headingRe = /^#{1,6}\s/;

  const collected: string[] = [];
  const tldrIdx = lines.findIndex((l) => tldrRe.test(l.trim()));
  if (tldrIdx !== -1) {
    // Skip the blank line(s) between the heading and its paragraph.
    let i = tldrIdx + 1;
    while (i < lines.length && !lines[i]!.trim()) i++;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
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
