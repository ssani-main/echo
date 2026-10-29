import {
  classifyTranscriptFailure, isMillisecondOffsets, isPermanentFetchError, fetchWithRetry,
  DEFAULT_RETRY_DELAYS_MS, MEMBERS_ONLY_PATTERNS, extractVideoId,
} from '../transcript.ts';
import type { CaptionSegment } from '../transcript.ts';
import { out } from './out.ts';

// --- classifyTranscriptFailure: the corpus of tests/transcript-error-classify.test.js, plus edges.
const failures: [string | null, string | null | undefined][] = [
  ['Premieres in 7 days', ''],
  ['This live event will begin in 3 hours', ''],
  ['some error', 'This live event has begun.'],
  ['Private video', ''],
  ['Video unavailable', ''],
  ['Transcript is disabled on this video', "Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."],
  ['some error', 'HTTP Error 429: Too Many Requests'],
  ['Sign in to confirm your age', ''],
  ['Transcript is disabled on this video', 'yt-dlp: unknown error'],
  ['The uploader has not made this video available in your country', ''],
  ['some generic youtube-transcript error', 'yt-dlp: unknown error'],
  ['x', 'ERROR: [youtube] abc: Premieres in 2 hours. Wait.'],
  ['x', 'Premieres in 😀 soon\nsecond line'],
  ['x', 'premieres in   '],
  ['Premiere will begin shortly', ''],
  ['Scheduled for 2026-11-01', ''],
  ['x', 'will begin in 5 minutes'],
  ['x', 'This video is private'],
  ['x', 'is live now'],
  ['x', 'currently live'],
  ['x', 'This video has been removed by the uploader'],
  ['x', 'This video is no longer available because the YouTube account associated with this video has been terminated.'],
  ['x', 'account was closed'],
  ['x', 'Sign in to confirm you’re not a bot'],
  ['x', 'Use --cookies-from-browser'],
  ['x', 'This video may be inappropriate for some users.'],
  ['x', 'age-restricted'],
  ['x', 'agerestricted'],
  ['x', 'The uploader has not made this video available in your region'],
  ['x', 'Who has blocked it in your country on copyright grounds'],
  ['x', 'Join this channel to get access to members-only content'],
  ['Private video and Premieres in 1 day', ''],
  [null, null],
  [null, undefined],
  ['', ''],
  ['PRIVATE VIDEO', 'VIDEO UNAVAILABLE'],
];
failures.forEach(([message, detail], i) => {
  out(`classify#${i}`, classifyTranscriptFailure(message === null ? null : new Error(message), detail));
});
out('classify/undefined', classifyTranscriptFailure(undefined, undefined));
out('classify/TypeError', classifyTranscriptFailure(new TypeError('Video unavailable'), ''));

// --- isMillisecondOffsets
const offsetSets: (number[] | null | undefined)[] = [
  [0, 2500, 5100, 7800, 10200], [0, 2.5, 5.1, 7.8, 10.2], [5000], [12], [1000], [1000.5], [], null, undefined,
  [0, 1, 2, 3, 600, 601], [0, 49, 98], [0, 50, 100], [0, 50, 51, 52], [10, 5, 0], [0, 100, 100, 100],
  [-5000, 0, 5000], [0, 0.0001, 1e9], [1e15, 2e15],
];
offsetSets.forEach((o, i) => out(`isMillisecondOffsets#${i}`, isMillisecondOffsets(o)));

// --- isPermanentFetchError
const errs: (Error | null | undefined)[] = [
  new Error('Transcript is disabled on this video (abc)'),
  new Error('No transcripts are available for this video'),
  new Error('No transcript available'),
  new Error('The video is no longer available'),
  new Error('Impossible to retrieve Youtube video ID.'),
  new Error('fetch failed'),
  new Error('ECONNRESET'),
  new TypeError('Network request failed'),
  new Error(''),
  new Error('DISABLED'),
  null,
  undefined,
];
errs.forEach((e, i) => out(`isPermanentFetchError#${i}`, isPermanentFetchError(e)));

out('DEFAULT_RETRY_DELAYS_MS', DEFAULT_RETRY_DELAYS_MS);
out('MEMBERS_ONLY_PATTERNS', MEMBERS_ONLY_PATTERNS.map((re) => [re.source, re.flags, re.test("Join this channel's members")]));
out('extractVideoId re-export', extractVideoId('https://youtu.be/GRzaq5AHiV8'));

// --- fetchWithRetry, with fetchers that fail on a script.
async function retryCase(name: string, failures: string[], delays: number[] | undefined): Promise<void> {
  let attempts = 0;
  const seen: string[] = [];
  const fetcher = async (videoId: string, lang: string | undefined): Promise<CaptionSegment[]> => {
    seen.push(`${videoId}/${lang ?? '-'}`);
    const failure = failures[attempts++];
    if (failure === 'TypeError') throw new TypeError('Network request failed');
    if (failure !== undefined) throw new Error(failure);
    return [{ text: `ok after ${attempts}`, offset: attempts }];
  };
  try {
    const result = delays === undefined
      ? await fetchWithRetry(fetcher, 'GRzaq5AHiV8', undefined)
      : await fetchWithRetry(fetcher, 'GRzaq5AHiV8', 'de', delays);
    out(`fetchWithRetry/${name}`, { result, attempts, seen });
  } catch (e) {
    const err = e as Error;
    out(`fetchWithRetry/${name}`, { error: `${err.name}: ${err.message}`, typeError: err instanceof TypeError, attempts, seen });
  }
}
await retryCase('first try', [], []);
await retryCase('transient then ok', ['fetch failed'], [1, 2]);
await retryCase('two transients then ok', ['fetch failed', 'TypeError'], [1, 2]);
await retryCase('always transient', ['a', 'b', 'c', 'd'], [1, 2]);
await retryCase('always transient, no retries', ['a', 'b'], []);
await retryCase('permanent at once', ['Transcript is disabled on this video'], [1, 2]);
await retryCase('transient then permanent', ['fetch failed', 'Video no longer available'], [1, 2]);
await retryCase('last error is a TypeError', ['a', 'TypeError'], [1]);
await retryCase('default delays', ['fetch failed'], undefined);
