import {
  classifyTranscriptFailure, isMillisecondOffsets, isPermanentFetchError, fetchWithRetry,
  DEFAULT_RETRY_DELAYS_MS, MEMBERS_ONLY_PATTERNS, extractVideoId, fetchViaPackage, fetchTranscript,
} from '../transcript.ts';
import type { CaptionSegment, FetchedSegment, Segments, FetchTranscriptOptions } from '../transcript.ts';
import { EchoError } from '../errors.ts';
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

// --- fetchViaPackage, through its transcriptFetcher seam: which tracks it asks for, the unit, langUsed.
async function packageCase(name: string, lang: string | undefined, answers: Record<string, FetchedSegment[] | string>): Promise<void> {
  const calls: string[] = [];
  const fetcher = async (id: string, ytOpts?: { lang: string }): Promise<FetchedSegment[]> => {
    const key = ytOpts ? ytOpts.lang : '-';
    calls.push(`${id}/${key}`);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`no ${key} track`);
    if (typeof answer === 'string') throw new Error(answer);
    return answer;
  };
  try {
    const segments = await fetchViaPackage('GRzaq5AHiV8', lang, { transcriptFetcher: fetcher });
    out(`fetchViaPackage/${name}`, { segments, langUsed: segments.langUsed ?? null, calls });
  } catch (e: any) {
    out(`fetchViaPackage/${name}`, { error: String(e.message), calls });
  }
}
const ms: FetchedSegment[] = [{ text: 'it&amp;#39;s &amp;quot;q&amp;quot; &lt;b&gt;', offset: 1000, lang: 'en' }, { text: 'two', offset: 3500, lang: 'en' }];
const secs: FetchedSegment[] = [{ text: 'eins', offset: 1.5, lang: 'de' }, { text: 'zwei', offset: 4, lang: 'de' }];
await packageCase('preferred en, ms', undefined, { en: ms });
await packageCase('no en, first track', undefined, { en: 'No transcripts are available in en', '-': secs });
await packageCase('en empty, first track', undefined, { en: [], '-': secs });
await packageCase('asked fr, no lang on segments', 'fr', { fr: [{ text: 'un', offset: 2 }] });
await packageCase('en without lang', undefined, { en: [{ text: 'x', offset: 2 }] });
await packageCase('missing text and offset', 'en', { en: [{ offset: '3' }, { text: '' }, { text: 'ok', offset: 7 }] });
await packageCase('asked fr, fails', 'fr', {});
await packageCase('single segment in ms', 'en', { en: [{ text: 'only', offset: 5000, lang: 'en' }] });
await packageCase('no tracks at all', undefined, { en: 'down' });

// --- fetchTranscript, through its seams: captions, the yt-dlp fallback, Whisper, and how failures are classified.
const segs = (text: string): Segments => [{ text, offset: 1 }];
function failure(message: string, fields: { code?: string; syscall?: string; stderr?: string } = {}): Error {
  const err: any = new Error(message);
  if (fields.code !== undefined) err.code = fields.code;
  if (fields.syscall !== undefined) err.syscall = fields.syscall;
  if (fields.stderr !== undefined) err.stderr = fields.stderr;
  return err;
}
type Step = Segments | Error;
async function transcriptCase(name: string, primary: Step, fallback: Step, whisper: { mode?: string; installed?: boolean; result?: Step } = {}, lang?: string): Promise<void> {
  const calls: string[] = [];
  const opts: FetchTranscriptOptions = {
    retryDelaysMs: [],
    primaryFetcher: async (id: string, l: string | undefined): Promise<Segments> => {
      calls.push(`primary ${id}/${l ?? '-'}`);
      if (primary instanceof Error) throw primary;
      return primary;
    },
    captionFallback: async (id: string, l: string | undefined): Promise<Segments> => {
      calls.push(`yt-dlp ${id}/${l ?? '-'}`);
      if (fallback instanceof Error) throw fallback;
      return fallback;
    },
    whisperResolver: (_: FetchTranscriptOptions): unknown => {
      calls.push('resolve whisper');
      return whisper.installed === true;
    },
    transcriber: async (id: string, _: FetchTranscriptOptions): Promise<Segments> => {
      calls.push(`whisper ${id}`);
      const result = whisper.result ?? segs('whispered');
      if (result instanceof Error) throw result;
      return result;
    },
  };
  if (whisper.mode !== undefined) opts.transcribe = whisper.mode;
  if (lang !== undefined) opts.lang = lang;
  try {
    const result = await fetchTranscript('GRzaq5AHiV8', opts);
    out(`fetchTranscript/${name}`, { result, calls });
  } catch (e: any) {
    out(`fetchTranscript/${name}`, { error: { message: e.message, echoCode: e.echoCode, hint: e.hint, reason: e.reason ?? null, detail: e.detail }, calls });
  }
}
const disabled = failure('[YoutubeTranscript] 🚨 Transcript is disabled on this video (GRzaq5AHiV8)');
const noTrack = failure('yt-dlp produced no en subtitle track (captions unavailable for this video).');
await transcriptCase('captions', segs('caption'), noTrack);
await transcriptCase('captions empty, yt-dlp', [], segs('from yt-dlp'));
await transcriptCase('transient then yt-dlp', failure('fetch failed'), segs('from yt-dlp'), {}, 'de');
await transcriptCase('yt-dlp not installed', disabled, failure('spawn yt-dlp ENOENT', { code: 'ENOENT', syscall: 'spawn yt-dlp' }));
await transcriptCase('ENOENT not from spawn', disabled, failure('ENOENT: no such file or directory, open x.json3', { code: 'ENOENT' }));
await transcriptCase('members only', disabled, failure('Command failed: yt-dlp', { stderr: 'ERROR: Join this channel to get access to members-only content' }));
await transcriptCase('no captions', disabled, noTrack);
await transcriptCase('bot block', disabled, failure('Command failed: yt-dlp', { stderr: 'ERROR: [youtube] GRzaq5AHiV8: Sign in to confirm you’re not a bot.' }));
await transcriptCase('premiere', failure('Premieres in 3 days'), failure('Command failed', { stderr: '' }));
await transcriptCase('yt-dlp returns nothing', disabled, []);
await transcriptCase('whisper always', segs('caption'), noTrack, { mode: 'always', installed: true });
await transcriptCase('whisper always, not installed', segs('caption'), noTrack, { mode: 'always', installed: false });
await transcriptCase('whisper fallback', disabled, noTrack, { mode: 'fallback', installed: true });
await transcriptCase('whisper fallback, not installed', disabled, noTrack, { mode: 'fallback', installed: false });
await transcriptCase('whisper off', disabled, noTrack, { mode: 'off', installed: true });
await transcriptCase('whisper fails, ffmpeg', disabled, noTrack, { mode: 'fallback', installed: true, result: new EchoError('ffmpeg was not found on PATH', 'FFMPEG_MISSING') });
await transcriptCase('whisper fails, stderr', disabled, noTrack, { mode: 'fallback', installed: true, result: failure('whisper-cli exited 1', { stderr: 'bad model file' }) });
await transcriptCase('whisper fails, plain', disabled, noTrack, { mode: 'fallback', installed: true, result: failure('something broke') });
await transcriptCase('whisper fails, refused', disabled, noTrack, { mode: 'fallback', installed: true, result: new EchoError('HTTP 403', 'AUDIO_DOWNLOAD_REFUSED') });
await transcriptCase('members only beats whisper', disabled, failure('x', { stderr: 'This video is available to this channel’s members' }), { mode: 'fallback', installed: true });
