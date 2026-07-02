// clips.js — builds a flat list of "clips" (highlight + deep-link) across saved entries.
// Pure functions only; no I/O, no imports from store.js/server.js.

/**
 * Format a whole-second duration as "M:SS" or "H:MM:SS".
 * @param {number} sec
 * @returns {string}
 */
function hhmmss(sec) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) {
    const mm = String(m).padStart(2, '0');
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/**
 * Resolve the integer second a highlight occurs at by matching its text
 * against transcript segments. Case-insensitive, trimmed. Returns the
 * offset of the FIRST segment where either string contains the other.
 * @param {string} text
 * @param {Array<{text?: string, offset_seconds?: number}>} segments
 * @returns {number|null}
 */
export function resolveHighlightSecond(text, segments) {
  const needle = String(text ?? '').trim().toLowerCase();
  if (!needle) return null;
  if (!Array.isArray(segments) || segments.length === 0) return null;

  for (const seg of segments) {
    if (!seg) continue;
    const segText = String(seg.text ?? '').trim().toLowerCase();
    if (!segText) continue;
    if (segText.includes(needle) || needle.includes(segText)) {
      const offset = Number(seg.offset_seconds);
      if (!Number.isFinite(offset)) return null;
      return Math.floor(offset);
    }
  }
  return null;
}

/**
 * Build a flat array of clip objects from full entries (as returned by
 * store.js getEntry), in entry order then highlight order. Entries with
 * no highlights are skipped.
 * @param {Array<object>} entries
 * @returns {Array<object>}
 */
export function buildClips(entries) {
  const clips = [];
  if (!Array.isArray(entries)) return clips;

  for (const entry of entries) {
    if (!entry) continue;
    const highlights = Array.isArray(entry.highlights) ? entry.highlights : [];
    if (highlights.length === 0) continue;

    const videoId  = entry.videoId;
    const title    = entry.title || videoId;
    const rawUrl   = typeof entry.url === 'string' ? entry.url.trim() : '';
    const videoUrl = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const segments = Array.isArray(entry.segments) ? entry.segments : [];

    for (const h of highlights) {
      if (!h || !h.text) continue;
      const text  = h.text;
      const note  = h.note  ?? null;
      const color = h.color ?? null;
      const second = resolveHighlightSecond(text, segments);

      let deepLink;
      if (second != null) {
        const sep = videoUrl.includes('?') ? '&' : '?';
        deepLink = `${videoUrl}${sep}t=${second}s`;
      } else {
        deepLink = videoUrl;
      }

      const timeLabel = second != null ? hhmmss(second) : null;

      clips.push({
        videoId,
        title,
        videoUrl,
        text,
        note,
        color,
        second,
        deepLink,
        timeLabel,
      });
    }
  }

  return clips;
}
