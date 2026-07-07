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
 * Extract the playlist ID (the `list=` query param) from a YouTube URL.
 * Returns the playlist ID string, or null if not present.
 */
export function extractPlaylistId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    return u.searchParams.get('list') || null;
  } catch {
    // Fallback regex for non-standard URL strings
    const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
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
 * Detect whether a set of raw caption offsets are expressed in milliseconds
 * (as opposed to seconds), using the median gap between consecutive offsets.
 * Caption gaps are typically 1-8 seconds.
 *   - Millisecond offsets → gaps of ~1 000-8 000  → median gap >= 50
 *   - Second  offsets     → gaps of ~1-8           → median gap <  50
 * We use the median (not the mean) so that any anomalous long pauses do not
 * skew the decision.
 * @param {number[]} offsets  Raw offset values, in original (unsorted) order.
 * @returns {boolean} true if the offsets appear to be millisecond-scale.
 */
export function isMillisecondOffsets(offsets) {
  if (!Array.isArray(offsets) || offsets.length === 0) return false;

  if (offsets.length < 2) {
    // Edge case: single segment — fall back to a simple magnitude check.
    return offsets[0] > 1000;
  }

  const gaps = [];
  for (let i = 1; i < offsets.length; i++) {
    gaps.push(offsets[i] - offsets[i - 1]);
  }
  // Sort gaps and pick the middle value (lower-middle for even-length arrays).
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor((gaps.length - 1) / 2)];
  return medianGap >= 50;
}

/**
 * Primary: fetch via the youtube-transcript npm package.
 * Returns an array of { text: string, offset: number } where offset is in seconds.
 * @param {string} videoId
 * @param {string|undefined} lang  Optional BCP-47 language code (e.g. "en", "es").
 */
async function fetchViaPackage(videoId, lang) {
  const segs = lang
    ? await YoutubeTranscript.fetchTranscript(videoId, { lang })
    : await YoutubeTranscript.fetchTranscript(videoId);

  // The youtube-transcript package stamps every segment with the actual
  // caption track language code it resolved to (falls back to the first
  // available track's code when no `lang` was requested) — capture that so
  // callers can know which track was really loaded, not just which one was
  // asked for.
  const langUsed = (segs[0] && segs[0].lang) || lang || null;

  // Step 1: normalise each segment to raw form so we can inspect offsets before committing.
  const raw = segs.map((seg) => ({
    text: decodeEntities(seg.text || ''),
    rawOffset: typeof seg.offset === 'number' ? seg.offset : 0,
  }));

  // Step 2: detect the unit ONCE for the whole array (see isMillisecondOffsets).
  const isMilliseconds = isMillisecondOffsets(raw.map((s) => s.rawOffset));

  const divisor = isMilliseconds ? 1000 : 1;

  // Step 3: apply the divisor uniformly to every segment.
  const result = raw.map(({ text, rawOffset }) => ({
    text,
    offset: rawOffset / divisor,
  }));
  // Attach as a non-enumerable extra property so array consumers (length,
  // iteration, JSON via res.json(segments) elsewhere) are unaffected.
  Object.defineProperty(result, 'langUsed', { value: langUsed, enumerable: false });
  return result;
}

/**
 * Fallback: fetch via yt-dlp (must be installed separately).
 * Returns an array of { text: string, offset: number } where offset is in seconds.
 * @param {string} videoId
 * @param {string|undefined} lang  Optional BCP-47 language code. Defaults to "en".
 */
async function fetchViaYtDlp(videoId, lang) {
  const effectiveLang = lang || 'en';
  const tmpBase = join(os.tmpdir(), `yt_transcript_${videoId}_${Date.now()}`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  await execFileAsync('yt-dlp', [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs', effectiveLang,
    '--sub-format', 'json3',
    '-o', tmpBase,
    videoUrl,
  ], { timeout: 30000 });

  // yt-dlp writes the file as <base>.<lang>.json3
  const subFile = `${tmpBase}.${effectiveLang}.json3`;
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

  // Explicit --sub-langs request, so we know exactly which track was pulled.
  Object.defineProperty(segments, 'langUsed', { value: effectiveLang, enumerable: false });
  return segments;
}

/**
 * Default retry policy for the primary (youtube-transcript package) fetch.
 * DEFAULT_RETRY_DELAYS_MS.length is the number of retries (attempts - 1).
 * Tests can override via fetchTranscript's opts.retryDelaysMs (e.g. []) to
 * run instantly with zero backoff.
 */
export const DEFAULT_RETRY_DELAYS_MS = [300, 900];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether an error from the primary fetch represents a permanent
 * condition (no captions, disabled, unavailable video, bad video id, etc.)
 * that retrying will never fix — as opposed to a transient/network-style
 * failure that's worth retrying with backoff.
 */
const PERMANENT_ERROR_PATTERNS = [
  /disabled/i,
  /not available/i,
  /no longer available/i,
  /no transcripts? (are )?available/i,
  /impossible to retrieve/i,
];

export function isPermanentFetchError(err) {
  const message = (err && err.message) || '';
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Wrap a primary-fetch function with retry + exponential backoff.
 * Retries only on transient failures (see isPermanentFetchError); permanent
 * failures are re-thrown immediately without wasting a retry.
 *
 * @param {(videoId: string, lang: string|undefined) => Promise<any>} fetcher
 * @param {string} videoId
 * @param {string|undefined} lang
 * @param {number[]} [retryDelaysMs]  Backoff delays (ms) between attempts.
 *   retryDelaysMs.length is the number of retries; defaults to
 *   DEFAULT_RETRY_DELAYS_MS (2 retries: 300ms, 900ms → 3 attempts total).
 *   Pass [] to disable retries/backoff entirely (single attempt).
 */
export async function fetchWithRetry(fetcher, videoId, lang, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS) {
  let lastErr;
  const maxAttempts = 1 + retryDelaysMs.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetcher(videoId, lang);
    } catch (err) {
      lastErr = err;
      if (isPermanentFetchError(err)) throw err;
      if (attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }
  throw lastErr;
}

/**
 * Look up the title of a YouTube video via the oEmbed API (no API key required).
 * Returns the title string, or null on any error (never throws).
 */
export async function getVideoTitle(videoId) {
  const meta = await getVideoMeta(videoId);
  return meta.title;
}

/**
 * Look up title + channel metadata for a YouTube video via the oEmbed API
 * (no API key required, single request — the same one getVideoTitle used to
 * make). oEmbed's response already includes `author_name`/`author_url`
 * (the uploading channel's name and canonical URL), so this reuses that one
 * call rather than spawning a second yt-dlp/network request just for the
 * channel link.
 * Returns { title, channel, channelUrl } — any field is null on failure/absence,
 * this never throws.
 */
export async function getVideoMeta(videoId) {
  const oEmbedUrl =
    `https://www.youtube.com/oembed?url=${encodeURIComponent(
      'https://www.youtube.com/watch?v=' + videoId
    )}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(oEmbedUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { title: null, channel: null, channelUrl: null };
    const data = await response.json();
    return {
      title: data.title || null,
      channel: data.author_name || null,
      channelUrl: data.author_url || null,
    };
  } catch {
    clearTimeout(timer);
    return { title: null, channel: null, channelUrl: null };
  }
}

/**
 * List all available subtitle/caption tracks for a YouTube video via yt-dlp.
 * Returns an array of { code, name, auto } where:
 *   - code  is the BCP-47 language code (e.g. "en", "es")
 *   - name  is a human-readable label when available, otherwise the code itself
 *   - auto  is true for auto-generated (ASR) tracks, false for manually uploaded ones
 *
 * On any failure (yt-dlp not installed, network error, etc.) returns [] — never throws.
 */
export async function listCaptionTracks(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '-J',
      '--skip-download',
      videoUrl,
    ], { timeout: 20000 });

    const info = JSON.parse(stdout);

    // Use a Map keyed by language code so we can dedupe, preferring manual over auto.
    const tracks = new Map();

    // Add auto-generated captions first (lower priority).
    const autoCaptions = info.automatic_captions || {};
    for (const [code, formats] of Object.entries(autoCaptions)) {
      const firstName = Array.isArray(formats) && formats[0] && formats[0].name;
      tracks.set(code, { code, name: firstName || code, auto: true });
    }

    // Add manual subtitles second — overwrites any auto entry for the same code.
    const subtitles = info.subtitles || {};
    for (const [code, formats] of Object.entries(subtitles)) {
      const firstName = Array.isArray(formats) && formats[0] && formats[0].name;
      tracks.set(code, { code, name: firstName || code, auto: false });
    }

    return Array.from(tracks.values());
  } catch {
    return [];
  }
}

/**
 * Fetch the transcript for a YouTube video ID.
 * Tries the npm package first; falls back to yt-dlp if that fails.
 * Throws a descriptive Error if both methods fail.
 *
 * @param {string} videoId
 * @param {{ lang?: string, retryDelaysMs?: number[], primaryFetcher?: Function }} [opts]  Optional options object.
 *   opts.lang — BCP-47 language code to request (e.g. "en", "es", "fr").
 *               When omitted the default/auto-selected track is used, matching
 *               the original single-argument behaviour exactly.
 *   opts.retryDelaysMs — Backoff delays (ms) between primary-fetch retries.
 *               Defaults to DEFAULT_RETRY_DELAYS_MS (2 retries). Pass [] to
 *               disable retries (single attempt) — useful for fast tests.
 *   opts.primaryFetcher — Override for the primary fetch function (used for
 *               dependency injection in tests). Defaults to the real
 *               youtube-transcript-backed fetchViaPackage.
 */
export async function fetchTranscript(videoId, opts = {}) {
  const lang = opts.lang || undefined;
  const retryDelaysMs = opts.retryDelaysMs !== undefined ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const primaryFetcher = opts.primaryFetcher || fetchViaPackage;
  let primaryError;

  try {
    const segments = await fetchWithRetry(primaryFetcher, videoId, lang, retryDelaysMs);
    if (segments.length > 0) return segments;
    // Empty result treated as a failure so we try the fallback
    primaryError = new Error('youtube-transcript returned no segments');
  } catch (err) {
    primaryError = err;
  }

  try {
    const segments = await fetchViaYtDlp(videoId, lang);
    if (segments.length > 0) return segments;
    throw new Error('yt-dlp returned no segments');
  } catch (ytDlpErr) {
    // yt-dlp is not installed at all
    if (ytDlpErr.code === 'ENOENT') {
      const e = new Error(
        `Primary transcript fetch failed (${primaryError.message}). ` +
        'yt-dlp fallback is not available.'
      );
      e.echoCode = 'YTDLP_MISSING';
      e.hint = 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.';
      throw e;
    }
    // Both methods failed — video likely has no captions or is inaccessible
    const e = new Error(
      `Could not fetch transcript. ` +
      `Primary: ${primaryError.message}. ` +
      `Fallback (yt-dlp): ${ytDlpErr.message}`
    );
    e.echoCode = 'TRANSCRIPT_UNAVAILABLE';
    e.hint = 'The video may have captions disabled, be private, age-restricted, or unavailable in your region.';
    throw e;
  }
}

/**
 * Fetch metadata for a YouTube playlist (or a single video).
 * Uses yt-dlp --flat-playlist so no per-video network requests are made.
 * Returns { playlistTitle, videos: [{ videoId, title }] }.
 *
 * Accepts any of:
 *   - A playlist URL:  https://www.youtube.com/playlist?list=PL...
 *   - A watch URL with list param: https://www.youtube.com/watch?v=...&list=PL...
 *   - A bare playlist ID (will be converted to a playlist URL)
 *
 * Caps the returned video list at 200 entries.
 * On any failure returns { playlistTitle: null, videos: [] } — never throws.
 */
// Hostnames allowed for the URL handed to yt-dlp. Guards against passing
// arbitrary/attacker-controlled URLs (SSRF-ish) through to a spawned process.
const ALLOWED_PLAYLIST_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export async function extractPlaylist(url) {
  if (!url || typeof url !== 'string') return { playlistTitle: null, videos: [] };

  // If the caller passes a bare playlist ID, wrap it in a playlist URL.
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl) && !targetUrl.includes('youtube')) {
    targetUrl = `https://www.youtube.com/playlist?list=${targetUrl}`;
  }

  // Validate that the final URL handed to yt-dlp actually points at YouTube.
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('Playlist URL is not a valid URL.');
  }
  if (!ALLOWED_PLAYLIST_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Playlist URL must be a YouTube URL.');
  }

  const MAX_VIDEOS = 200;

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--flat-playlist',
      '-J',
      targetUrl,
    ], { timeout: 60000 });

    const info = JSON.parse(stdout);

    // Single-video result (yt-dlp returns _type:"video" for non-playlist URLs)
    if (info._type !== 'playlist') {
      return {
        playlistTitle: null,
        videos: info.id ? [{ videoId: info.id, title: info.title || '' }] : [],
      };
    }

    const entries = Array.isArray(info.entries) ? info.entries : [];
    const videos = entries
      .slice(0, MAX_VIDEOS)
      .filter((e) => e && e.id)
      .map((e) => ({ videoId: e.id, title: e.title || '' }));

    return {
      playlistTitle: info.title || null,
      videos,
    };
  } catch {
    return { playlistTitle: null, videos: [] };
  }
}
