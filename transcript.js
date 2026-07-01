import { YoutubeTranscript } from 'youtube-transcript';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

/**
 * Extract an 11-character YouTube video ID from various URL forms,
 * or return the input itself if it already looks like a bare ID.
 * Returns null if nothing valid is found.
 */
export function extractVideoId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();

  // Patterns to try against the full URL string
  const patterns = [
    // youtube.com/watch?v=ID  (optional extra params)
    /[?&]v=([A-Za-z0-9_-]{11})(?:[&\s]|$)/,
    // youtu.be/ID
    /youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    // youtube.com/shorts/ID
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    // youtube.com/embed/ID
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
  ];

  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }

  // Bare 11-char video ID (only valid YouTube ID characters)
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;

  return null;
}

/**
 * Decode common HTML entities that appear in transcript text.
 */
function decodeEntities(str) {
  return str
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Primary: fetch via the youtube-transcript npm package.
 * Returns an array of { text: string, offset: number } where offset is in seconds.
 */
async function fetchViaPackage(videoId) {
  const segs = await YoutubeTranscript.fetchTranscript(videoId);

  // Step 1: normalise each segment to raw form so we can inspect offsets before committing.
  const raw = segs.map((seg) => ({
    text: decodeEntities(seg.text || ''),
    rawOffset: typeof seg.offset === 'number' ? seg.offset : 0,
  }));

  // Step 2: detect the unit ONCE for the whole array using the median gap between
  // consecutive offsets.  Caption gaps are typically 1-8 seconds.
  //   - Millisecond offsets → gaps of ~1 000-8 000  → median gap >= 50
  //   - Second  offsets     → gaps of ~1-8           → median gap <  50
  // We use the median (not the mean) so that any anomalous long pauses do not
  // skew the decision.
  let isMilliseconds;

  if (raw.length < 2) {
    // Edge case: single segment — fall back to a simple magnitude check.
    isMilliseconds = raw.length === 1 && raw[0].rawOffset > 1000;
  } else {
    const offsets = raw.map((s) => s.rawOffset);
    const gaps = [];
    for (let i = 1; i < offsets.length; i++) {
      gaps.push(offsets[i] - offsets[i - 1]);
    }
    // Sort gaps and pick the middle value (lower-middle for even-length arrays).
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor((gaps.length - 1) / 2)];
    isMilliseconds = medianGap >= 50;
  }

  const divisor = isMilliseconds ? 1000 : 1;

  // Step 3: apply the divisor uniformly to every segment.
  return raw.map(({ text, rawOffset }) => ({
    text,
    offset: rawOffset / divisor,
  }));
}

/**
 * Fallback: fetch via yt-dlp (must be installed separately).
 * Returns an array of { text: string, offset: number } where offset is in seconds.
 */
async function fetchViaYtDlp(videoId) {
  const tmpBase = join(os.tmpdir(), `yt_transcript_${videoId}_${Date.now()}`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  await execFileAsync('yt-dlp', [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-lang', 'en',
    '--sub-format', 'json3',
    '-o', tmpBase,
    videoUrl,
  ]);

  // yt-dlp writes the file as <base>.en.json3
  const subFile = `${tmpBase}.en.json3`;
  const raw = await readFile(subFile, 'utf8');

  // Clean up temp file (best-effort)
  unlink(subFile).catch(() => {});

  const data = JSON.parse(raw);
  const segments = [];

  for (const event of (data.events || [])) {
    if (!event.segs) continue;
    const text = event.segs
      .map((s) => s.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;
    segments.push({
      text: decodeEntities(text),
      offset: (event.tStartMs || 0) / 1000,
    });
  }

  return segments;
}

/**
 * Look up the title of a YouTube video via the oEmbed API (no API key required).
 * Returns the title string, or null on any error (never throws).
 */
export async function getVideoTitle(videoId) {
  const oEmbedUrl =
    `https://www.youtube.com/oembed?url=${encodeURIComponent(
      'https://www.youtube.com/watch?v=' + videoId
    )}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(oEmbedUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    return data.title || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch the transcript for a YouTube video ID.
 * Tries the npm package first; falls back to yt-dlp if that fails.
 * Throws a descriptive Error if both methods fail.
 */
export async function fetchTranscript(videoId) {
  let primaryError;

  try {
    const segments = await fetchViaPackage(videoId);
    if (segments.length > 0) return segments;
    // Empty result treated as a failure so we try the fallback
    primaryError = new Error('youtube-transcript returned no segments');
  } catch (err) {
    primaryError = err;
  }

  try {
    const segments = await fetchViaYtDlp(videoId);
    if (segments.length > 0) return segments;
    throw new Error('yt-dlp returned no segments');
  } catch (ytDlpErr) {
    // If yt-dlp is simply not installed, surface a clear message
    if (ytDlpErr.code === 'ENOENT') {
      throw new Error(
        `Primary transcript fetch failed (${primaryError.message}). ` +
        'yt-dlp fallback is not available — install it with ' +
        '`pip install yt-dlp` or `winget install yt-dlp`.'
      );
    }
    throw new Error(
      `Both transcript methods failed. ` +
      `Primary: ${primaryError.message}. ` +
      `Fallback (yt-dlp): ${ytDlpErr.message}`
    );
  }
}
