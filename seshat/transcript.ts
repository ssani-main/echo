// Port of ../transcript.js: the failure classifier, the offset-unit detector and the retry policy
// (check/transcript.cases.ts), and the fetching: captions through youtube.ts, which replaces the
// youtube-transcript package (check/youtube.cases.ts), yt-dlp, oEmbed (check/transcript-live.cases.ts and the
// transcript routes). Whisper comes in step 6 (see fetchTranscript).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractVideoId } from './text.ts';
import { fetchTranscript as fetchPackageTranscript } from './youtube.ts';
import { mapWhisperError } from './whisper.ts';
import { EchoError } from './errors.ts';
import { arrayOf, jsString, prop } from './js.ts';

// extractVideoId lives in text.ts (the port of common/text.js).
export { extractVideoId };

/**
 * Detect whether a set of raw caption offsets are expressed in milliseconds
 * (as opposed to seconds), using the median gap between consecutive offsets.
 * Caption gaps are typically 1-8 seconds.
 *   - Millisecond offsets -> gaps of ~1 000-8 000  -> median gap >= 50
 *   - Second  offsets     -> gaps of ~1-8           -> median gap <  50
 * The median (not the mean) so that anomalous long pauses do not skew it.
 */
export function isMillisecondOffsets(offsets: number[] | null | undefined): boolean {
  if (!Array.isArray(offsets) || offsets.length === 0) return false;

  if (offsets.length < 2) {
    // Edge case: single segment — fall back to a simple magnitude check.
    return offsets[0]! > 1000;
  }

  const gaps: number[] = [];
  for (let i = 1; i < offsets.length; i++) {
    gaps.push(offsets[i]! - offsets[i - 1]!);
  }
  // Sort gaps and pick the middle value (lower-middle for even-length arrays).
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor((gaps.length - 1) / 2)]!;
  return medianGap >= 50;
}

/**
 * Default retry policy for the primary fetch.
 * DEFAULT_RETRY_DELAYS_MS.length is the number of retries (attempts - 1).
 */
export const DEFAULT_RETRY_DELAYS_MS: number[] = [300, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errors from the primary fetch that retrying will never fix (no captions,
 * disabled, unavailable video, bad video id), as opposed to transient ones.
 */
const PERMANENT_ERROR_PATTERNS = [
  /disabled/i,
  /not available/i,
  /no longer available/i,
  /no transcripts? (are )?available/i,
  /impossible to retrieve/i,
];

export function isPermanentFetchError(err: { message?: string } | null | undefined): boolean {
  const message = (err && err.message) || '';
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Wrap a primary-fetch function with retry + backoff. Retries only on
 * transient failures (see isPermanentFetchError); permanent failures are
 * re-thrown immediately. retryDelaysMs.length is the number of retries;
 * [] means a single attempt.
 */
/** One caption line, offset in seconds: what every transcript fetcher returns. */
export interface CaptionSegment {
  text: string;
  offset: number;
}

export async function fetchWithRetry<T>(
  fetcher: (videoId: string, lang: string | undefined) => Promise<T>,
  videoId: string,
  lang: string | undefined,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<T> {
  let lastErr: Error | undefined;
  const maxAttempts = 1 + retryDelaysMs.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetcher(videoId, lang);
    } catch (err) {
      lastErr = err as Error;
      if (isPermanentFetchError(lastErr)) throw lastErr;
      if (attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]!);
      }
    }
  }
  throw lastErr!;
}

export const MEMBERS_ONLY_PATTERNS = [/members-only/i, /join this channel/i, /channel's members/i];

export interface TranscriptFailure {
  reason: string;
  message: string;
  hint: string;
}

/**
 * Classify a transcript-fetch failure into a single human-readable reason,
 * so the UI can show one clear message + next step instead of the raw
 * two-strike machine log. Inspects the combined primary + yt-dlp error text.
 */
export function classifyTranscriptFailure(
  primaryError: { message?: string } | null | undefined,
  ytDlpDetail: string | null | undefined,
): TranscriptFailure {
  const text = `${primaryError?.message || ''}\n${ytDlpDetail || ''}`;

  if (
    /premieres in/i.test(text) ||
    /premiere will begin/i.test(text) ||
    /this live event will begin in/i.test(text) ||
    /scheduled for/i.test(text) ||
    /will begin in\s/i.test(text)
  ) {
    const match = text.match(/premieres in ([^\n.]+)/i) || text.match(/will begin in ([^\n.]+)/i);
    const interval = match ? match[1].trim() : '';
    return {
      reason: 'premiere',
      message: "This video hasn't aired yet",
      hint: interval
        ? `It premieres in ${interval} — there's no transcript until it goes live. Try again after it premieres.`
        : "It's scheduled to premiere and hasn't gone live yet. Try again after it airs.",
    };
  }

  if (
    /this live event has begun/i.test(text) ||
    /live event has begun/i.test(text) ||
    /currently live/i.test(text) ||
    /is live now/i.test(text)
  ) {
    return {
      reason: 'live',
      message: 'This is a live stream in progress',
      hint: 'Transcripts are usually available once the stream ends. Try again after it finishes.',
    };
  }

  if (/private video/i.test(text) || /this video is private/i.test(text)) {
    return {
      reason: 'private',
      message: 'This video is private',
      hint: "The owner has restricted access. Nothing can be fetched unless it's made public.",
    };
  }

  if (
    /video unavailable/i.test(text) ||
    /has been removed/i.test(text) ||
    /no longer available/i.test(text) ||
    /removed by the uploader/i.test(text) ||
    /removed for violating/i.test(text) ||
    /account.*(terminated|closed)/i.test(text)
  ) {
    return {
      reason: 'unavailable',
      message: 'This video is unavailable',
      hint: 'It may have been removed or taken down by YouTube or the uploader.',
    };
  }

  // Must come before age_restricted: yt-dlp's bot-block message also reads
  // "Sign in to confirm ..." (this time "you're not a bot" rather than "your
  // age"), so it has to be checked first or it would be misread as an
  // age gate. "Transcript is disabled on this video" (the youtube-transcript
  // side of a bot block) is deliberately NOT matched on its own here — a
  // genuinely disabled transcript produces that same string, so it's only
  // treated as corroborating evidence once the yt-dlp side has already said
  // "not a bot".
  if (
    /confirm you['’]re not a bot/i.test(text) ||
    /not a bot/i.test(text) ||
    /--cookies-from-browser/i.test(text) ||
    /http error 429/i.test(text) ||
    /too many requests/i.test(text)
  ) {
    return {
      reason: 'bot_block',
      message: 'YouTube is blocking requests from this server',
      hint: "YouTube rejects automated requests from datacenter IP addresses, which is where this Echo instance is hosted. The video's captions are probably fine — the server just can't reach them. Running Echo locally, or using the browser extension, fetches from your own IP instead.",
    };
  }

  if (
    /sign in to confirm your age/i.test(text) ||
    /age.?restricted/i.test(text) ||
    /inappropriate for some users/i.test(text) ||
    /confirm your age/i.test(text)
  ) {
    return {
      reason: 'age_restricted',
      message: 'This video is age-restricted',
      hint: "YouTube requires sign-in to view it, so its transcript can't be fetched here.",
    };
  }

  if (
    /not available in your country/i.test(text) ||
    /not available in your region/i.test(text) ||
    /blocked it in your country/i.test(text) ||
    /not made this video available in your country/i.test(text)
  ) {
    return {
      reason: 'geo_blocked',
      message: 'Not available in your region',
      hint: 'The uploader has blocked this video in your country.',
    };
  }

  return {
    reason: 'no_captions',
    message: 'No transcript available for this video',
    hint: "This video doesn't appear to have captions available.",
  };
}

// ---------------------------------------------------------------------------
// Fetching (step 5): captions through youtube.ts (Echo's replacement for the youtube-transcript package),
// yt-dlp as the fallback, oEmbed for the title and channel, yt-dlp for the list of tracks.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const YTDLP_JS_RUNTIME = process.env.ECHO_YTDLP_JS_RUNTIME ?? 'node';
const YTDLP_JS_RUNTIME_ARGS: string[] = YTDLP_JS_RUNTIME ? ['--js-runtimes', YTDLP_JS_RUNTIME] : [];

/** Caption lines, tagged (non-enumerable, so not in their JSON) with the track that was really loaded. */
export type Segments = CaptionSegment[] & { langUsed?: unknown; source?: string; modelUsed?: string | null };

function tagged(segments: CaptionSegment[], langUsed: unknown): Segments {
  const result: Segments = segments;
  Object.defineProperty(result, 'langUsed', { value: langUsed, enumerable: false });
  return result;
}

/** Common HTML entities in transcript text. */
function decodeEntities(str: string): string {
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

// The caption language asked for when a request names none, so a video with many crowd translations doesn't
// silently give its first track's language. ECHO_CAPTION_LANG overrides it.
const PREFERRED_CAPTION_LANG = process.env.ECHO_CAPTION_LANG || 'en';

/** What a transcript fetcher returns per line: youtube.ts's segments, or a test's. */
export interface FetchedSegment { text?: string; offset?: unknown; lang?: unknown }

export type TranscriptFetcher = (id: string, ytOpts?: { lang: string }) => Promise<FetchedSegment[]>;

/**
 * Primary: captions through youtube.ts, offsets in seconds whatever unit the track used.
 * opts.transcriptFetcher stands in for youtube.ts (tests).
 */
export async function fetchViaPackage(videoId: string, lang: string | undefined, opts: { transcriptFetcher?: TranscriptFetcher } = {}): Promise<Segments> {
  // shortcut: async with awaits, as the plain arrow returning the promise crashes in Seshat when called (gap:
  // arrow-returns-promise); drop them once fixed.
  const fetchTr: TranscriptFetcher = opts.transcriptFetcher
    || (async (id, ytOpts) => (ytOpts ? await fetchPackageTranscript(id, ytOpts) : await fetchPackageTranscript(id)));

  let segs: FetchedSegment[];
  if (lang) {
    segs = await fetchTr(videoId, { lang });
  } else {
    // The preferred language, else the video's first track (a non-English video still resolves).
    try {
      segs = await fetchTr(videoId, { lang: PREFERRED_CAPTION_LANG });
      if (!segs || segs.length === 0) segs = await fetchTr(videoId);
    } catch {
      segs = await fetchTr(videoId);
    }
  }

  const first = segs[0];
  const langUsed = (first && first.lang) || lang || null;
  const raw = segs.map((seg) => ({
    text: decodeEntities(seg.text || ''),
    rawOffset: typeof seg.offset === 'number' ? seg.offset : 0,
  }));
  // The unit is decided once for the whole track (see isMillisecondOffsets).
  const divisor = isMillisecondOffsets(raw.map((s) => s.rawOffset)) ? 1000 : 1;
  return tagged(raw.map(({ text, rawOffset }) => ({ text, offset: rawOffset / divisor })), langUsed);
}

/** Fallback: captions through yt-dlp's json3 subtitles. lang defaults to en. */
async function fetchViaYtDlp(videoId: string, lang: string | undefined): Promise<Segments> {
  const effectiveLang = lang || 'en';
  const tmpBase = join(tmpdir(), `yt_transcript_${videoId}_${Date.now()}`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  await execFileAsync('yt-dlp', [
    ...YTDLP_JS_RUNTIME_ARGS,
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs', effectiveLang,
    '--sub-format', 'json3',
    '-o', tmpBase,
    videoUrl,
  ], { timeout: 30000 });

  // yt-dlp writes <base>.<lang>.json3.
  const subFile = `${tmpBase}.${effectiveLang}.json3`;
  let raw: string;
  try {
    raw = await readFile(subFile, 'utf8');
  } catch (err: any) {
    // yt-dlp ran but wrote no track: a plain error, not the fs ENOENT, which the caller would read as
    // "yt-dlp is not installed".
    if (err.code === 'ENOENT') {
      throw new Error(`yt-dlp produced no ${effectiveLang} subtitle track (captions unavailable for this video).`);
    }
    throw err;
  }
  unlink(subFile).catch(() => {});

  const data: unknown = JSON.parse(raw);
  const segments: CaptionSegment[] = [];
  // `for (const event of (data.events || []))`; a non-array there is junk yt-dlp doesn't write.
  for (const event of arrayOf(prop(data, 'events'))) {
    const segs = prop(event, 'segs');
    if (!segs) continue;
    const text = arrayOf(segs)
      .map((s) => jsString(prop(s, 'utf8') || ''))
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;
    const start = prop(event, 'tStartMs');
    segments.push({ text: decodeEntities(text), offset: (typeof start === 'number' ? start : 0) / 1000 });
  }
  return tagged(segments, effectiveLang);
}

export interface VideoMeta { title: string | null; channel: string | null; channelUrl: string | null }

/** Title and channel through YouTube's keyless oEmbed; every field null on any failure. Never throws. */
export async function getVideoMeta(videoId: string): Promise<VideoMeta> {
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(oEmbedUrl, { signal: controller.signal });
    clearTimeout(timer);
    const none: VideoMeta = { title: null, channel: null, channelUrl: null };
    if (!response.ok) return none;
    const data: unknown = await response.json();
    const meta: VideoMeta = {
      title: textOrNull(prop(data, 'title')),
      channel: textOrNull(prop(data, 'author_name')),
      channelUrl: textOrNull(prop(data, 'author_url')),
    };
    return meta;
  } catch {
    clearTimeout(timer);
    const none: VideoMeta = { title: null, channel: null, channelUrl: null };
    return none;
  }
}

/** `v || null` for an oEmbed field. shortcut: a non-string field counts as missing; oEmbed's are strings. */
function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export interface CaptionTrack { code: string; name: unknown; auto: boolean }

/** The video's caption tracks through `yt-dlp -J`, a manual track replacing the auto one of its code. [] on any failure. */
export async function listCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const { stdout } = await execFileAsync('yt-dlp', [...YTDLP_JS_RUNTIME_ARGS, '-J', '--skip-download', videoUrl], { timeout: 20000 });
    const info: unknown = JSON.parse(stdout);
    const tracks = new Map<string, CaptionTrack>();
    const add = (captions: unknown, auto: boolean): void => {
      if (typeof captions !== 'object' || captions === null || Array.isArray(captions)) return;
      for (const [code, formats] of Object.entries(captions as Record<string, unknown>)) {
        const firstName = Array.isArray(formats) && formats[0] && prop(formats[0], 'name');
        tracks.set(code, { code, name: firstName || code, auto });
      }
    };
    add(prop(info, 'automatic_captions') || {}, true);
    add(prop(info, 'subtitles') || {}, false);
    return Array.from(tracks.values());
  } catch {
    return [];
  }
}

/** The one-line headline for a failed Whisper fallback, by its echoCode. */
function whisperFailureHeadline(code: string): string {
  switch (code) {
    case 'FFMPEG_MISSING': return 'Automatic transcription needs ffmpeg';
    case 'WHISPER_MISSING': return "Whisper transcription isn't set up";
    case 'WHISPER_TIMEOUT': return 'Whisper transcription timed out';
    case 'AUDIO_DOWNLOAD_REFUSED': return 'YouTube refused the audio download';
    default: return "Whisper couldn't transcribe this video";
  }
}

export interface FetchTranscriptOptions {
  lang?: string;
  retryDelaysMs?: number[];
  primaryFetcher?: (videoId: string, lang: string | undefined) => Promise<Segments>;
  captionFallback?: (videoId: string, lang: string | undefined) => Promise<Segments>;
  /** 'off' | 'fallback' | 'always' */
  transcribe?: string;
  whisperResolver?: (opts: FetchTranscriptOptions) => unknown;
  transcriber?: (videoId: string, opts: FetchTranscriptOptions) => Promise<Segments>;
  modelName?: string;
  signal?: AbortSignal;
}

/**
 * The transcript of a video: captions (retried), then yt-dlp's, then Whisper if it is on; a classified
 * EchoError when everything fails.
 * shortcut: Whisper isn't ported yet (step 6), so without opts.whisperResolver it counts as not installed,
 * and server.js forwards only requests with Whisper off; transcribeViaWhisper and resolveWhisper with step 6.
 */
export async function fetchTranscript(videoId: string, opts: FetchTranscriptOptions = {}): Promise<Segments> {
  const lang = opts.lang || undefined;
  const retryDelaysMs = opts.retryDelaysMs !== undefined ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const primaryFetcher = opts.primaryFetcher ?? ((id: string, l: string | undefined) => fetchViaPackage(id, l));
  const whisperMode = opts.transcribe || 'off';
  const resolveW = opts.whisperResolver ?? ((_: FetchTranscriptOptions): unknown => false);
  const transcribeW = opts.transcriber ?? ((_id: string, _o: FetchTranscriptOptions): Promise<Segments> => Promise.reject(new Error('Whisper is not ported yet.')));
  const captionFallback = opts.captionFallback ?? fetchViaYtDlp;

  if (whisperMode === 'always' && resolveW(opts)) return await transcribeW(videoId, opts);

  // Errors are read as store.js's are, off `any`: a fetcher's, yt-dlp's (code, syscall, stderr) or Whisper's.
  let primaryError: any;
  try {
    const segments = await fetchWithRetry(primaryFetcher, videoId, lang, retryDelaysMs);
    if (segments.length > 0) return segments;
    primaryError = new Error('youtube-transcript returned no segments');
  } catch (err) {
    primaryError = err;
  }

  try {
    const segments = await captionFallback(videoId, lang);
    if (segments.length > 0) return segments;
    throw new Error('yt-dlp returned no segments');
  } catch (ytDlpErr: any) {
    // yt-dlp itself missing: a spawn ENOENT, not a missing output file.
    if (ytDlpErr.code === 'ENOENT' && /spawn/i.test(String(ytDlpErr.syscall || ytDlpErr.message))) {
      throw new EchoError(
        `Primary transcript fetch failed (${primaryError.message}). yt-dlp fallback is not available.`,
        'YTDLP_MISSING', 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.', String(primaryError.message), 'ytdlp_missing',
      );
    }
    const ytDlpDetail: string = String(ytDlpErr.stderr || ytDlpErr.message || '');
    if (MEMBERS_ONLY_PATTERNS.some((p) => p.test(ytDlpDetail))) {
      throw new EchoError('This video is for channel members only.', 'MEMBERS_ONLY', 'This video is for channel members only.', ytDlpDetail, 'members_only');
    }
    // Both caption paths failed: Whisper, if it is on. Its own failure is reported as such, not as "no captions".
    if (whisperMode !== 'off' && resolveW(opts)) {
      try {
        return await transcribeW(videoId, opts);
      } catch (whisperErr: any) {
        const m = mapWhisperError(whisperErr);
        throw new EchoError(
          whisperFailureHeadline(m.echoCode), 'TRANSCRIPT_UNAVAILABLE', m.hint,
          `Whisper transcription failed: ${whisperErr.stderr || whisperErr.message || m.message}`, 'whisper_failed',
        );
      }
    }
    const failure = classifyTranscriptFailure(primaryError, ytDlpDetail);
    throw new EchoError(failure.message, 'TRANSCRIPT_UNAVAILABLE', failure.hint, `Primary: ${primaryError.message}. Fallback (yt-dlp): ${ytDlpErr.message}`, failure.reason);
  }
}
