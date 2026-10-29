// Port of the pure parts of ../transcript.js: the failure classifier, the
// offset-unit detector and the retry policy. The fetching itself (the
// youtube-transcript package, yt-dlp, oEmbed) is ported with the transcript
// routes, where youtube-transcript is replaced by Echo's own code (see
// PORT.md). Checked against the original by check/transcript.cases.ts.

import { extractVideoId } from './text.ts';

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
