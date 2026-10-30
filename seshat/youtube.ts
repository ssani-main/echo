// Echo's own replacement for the youtube-transcript package (1.3.1, node_modules/youtube-transcript/dist/esm),
// ported line for line so its error messages stay word for word: isPermanentFetchError and
// classifyTranscriptFailure match on them. Checked against the package by check/youtube.cases.ts.
// First the InnerTube player API (Android client) for the caption tracks, then the watch page's
// ytInitialPlayerResponse, then the track's XML.

import { jsString, prop, optProp } from './js.ts';

const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

/** The package's errors: one class, the message prefixed as its YoutubeTranscriptError does. */
export class YoutubeTranscriptError extends Error {
  constructor(message: string) {
    super(`[YoutubeTranscript] 🚨 ${message}`);
  }
}

function tooManyRequests(): YoutubeTranscriptError {
  return new YoutubeTranscriptError('YouTube is receiving too many requests from this IP and now requires solving a captcha to continue');
}
function videoUnavailable(videoId: string): YoutubeTranscriptError {
  return new YoutubeTranscriptError(`The video is no longer available (${videoId})`);
}
function disabled(videoId: string): YoutubeTranscriptError {
  return new YoutubeTranscriptError(`Transcript is disabled on this video (${videoId})`);
}
function notAvailable(videoId: string): YoutubeTranscriptError {
  return new YoutubeTranscriptError(`No transcripts are available for this video (${videoId})`);
}
function notAvailableLanguage(lang: string, availableLangs: unknown[], videoId: string): YoutubeTranscriptError {
  // Array.prototype.join: null and undefined as ''.
  const langs = availableLangs.map((l) => (l === null || l === undefined ? '' : jsString(l))).join(', ');
  return new YoutubeTranscriptError(`No transcripts are available in ${lang} this video (${videoId}). Available languages: ${langs}`);
}

/** One caption line as the package returns it: offset and duration in the track's own unit. */
export interface PackageSegment {
  text: string;
  duration: number;
  offset: number;
  /** The track's languageCode: the one asked for, or the first track's. */
  lang: unknown;
}

/** What the package passes fetch: a method and body only for the InnerTube POST. */
export interface FetchInit { method?: string; headers: Record<string, string>; body?: string }

export type FetchFn = (url: string, init: FetchInit) => Promise<Response>;

export interface TranscriptConfig {
  lang?: string;
  /** Instead of the global fetch (the package's own option; the case file's stand-in YouTube). */
  fetch?: FetchFn;
}

/** The transcript of a video id or URL: InnerTube first, the watch page if that gives no tracks. */
export async function fetchTranscript(videoId: string, config?: TranscriptConfig): Promise<PackageSegment[]> {
  const identifier = retrieveVideoId(videoId);
  const innerTubeResult = await fetchViaInnerTube(identifier, config);
  if (innerTubeResult) return innerTubeResult;
  return fetchViaWebPage(identifier, videoId, config);
}

/**
 * `(config?.fetch ?? fetch)(url, init)`.
 * shortcut: a call rather than choosing the function, and the global fetch's init written out field by field,
 * because Seshat won't take the global fetch as a FetchFn (`const f: FetchFn = fetch`) nor a FetchInit as its
 * init (gap: fetch-init-conversion; written as a ternary of the two awaits, the code generator panics instead).
 * `(config?.fetch ?? fetch)(url, init)` once fixed.
 */
async function fetchWith(config: TranscriptConfig | undefined, url: string, init: FetchInit): Promise<Response> {
  const given = config?.fetch;
  if (given) return await given(url, init);
  if (init.method !== undefined && init.body !== undefined) return await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return await fetch(url, { headers: init.headers });
}

/** `{ ...(config?.lang && { 'Accept-Language': config.lang }), 'User-Agent': USER_AGENT }` */
function pageHeaders(config: TranscriptConfig | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config?.lang) headers['Accept-Language'] = config.lang;
  headers['User-Agent'] = USER_AGENT;
  return headers;
}

async function fetchViaInnerTube(identifier: string, config: TranscriptConfig | undefined): Promise<PackageSegment[] | undefined> {
  try {
    const resp = await fetchWith(config, INNERTUBE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': INNERTUBE_USER_AGENT },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: INNERTUBE_CLIENT_VERSION } }, videoId: identifier }),
    });
    if (!resp.ok) return undefined;
    const data: unknown = await resp.json();
    const captionTracks = optProp(optProp(optProp(data, 'captions'), 'playerCaptionsTracklistRenderer'), 'captionTracks');
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) return undefined;
    // Returned, not awaited, as the package does: a track's own failure (no such language, a bad URL, the XML
    // fetch) skips this catch and rejects, rather than falling back to the watch page.
    return fetchTranscriptFromTracks(captionTracks, identifier, config);
  } catch {
    return undefined;
  }
}

async function fetchViaWebPage(identifier: string, originalVideoId: string, config: TranscriptConfig | undefined): Promise<PackageSegment[]> {
  const videoPageResponse = await fetchWith(config, `https://www.youtube.com/watch?v=${identifier}`, { headers: pageHeaders(config) });
  const videoPageBody = await videoPageResponse.text();
  if (videoPageBody.includes('class="g-recaptcha"')) throw tooManyRequests();
  if (!videoPageBody.includes('"playabilityStatus":')) throw videoUnavailable(originalVideoId);
  const playerResponse = parseInlineJson(videoPageBody, 'ytInitialPlayerResponse');
  const captionTracks = optProp(optProp(optProp(playerResponse, 'captions'), 'playerCaptionsTracklistRenderer'), 'captionTracks');
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) throw disabled(originalVideoId);
  return fetchTranscriptFromTracks(captionTracks, originalVideoId, config);
}

/** The JSON object assigned to a global in an inline script: braces counted, strings not looked at. */
function parseInlineJson(html: string, globalName: string): unknown {
  const startToken = `var ${globalName} = `;
  const startIndex = html.indexOf(startToken);
  if (startIndex === -1) return null;
  const jsonStart = startIndex + startToken.length;
  let depth = 0;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(html.slice(jsonStart, i + 1));
          return parsed;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchTranscriptFromTracks(captionTracks: unknown[], videoId: string, config: TranscriptConfig | undefined): Promise<PackageSegment[]> {
  const lang = config?.lang;
  if (lang && !captionTracks.some((track) => prop(track, 'languageCode') === lang)) {
    throw notAvailableLanguage(lang, captionTracks.map((track) => prop(track, 'languageCode')), videoId);
  }
  const track = lang ? captionTracks.find((t) => prop(t, 'languageCode') === lang) : captionTracks[0];
  const transcriptURL = jsString(prop(track, 'baseUrl'));
  // The package's guard against SSRF: only a youtube.com host is fetched.
  try {
    if (!new URL(transcriptURL).hostname.endsWith('.youtube.com')) throw notAvailable(videoId);
  } catch (e) {
    if (e instanceof YoutubeTranscriptError) throw e;
    throw notAvailable(videoId);
  }
  const transcriptResponse = await fetchWith(config, transcriptURL, { headers: pageHeaders(config) });
  if (!transcriptResponse.ok) throw notAvailable(videoId);
  const transcriptBody = await transcriptResponse.text();
  return parseTranscriptXml(transcriptBody, lang ?? prop(captionTracks[0], 'languageCode'));
}

/** srv3 (`<p t="ms" d="ms"><s>word</s>…</p>`, offsets in ms) or, failing that, the classic format (seconds). */
function parseTranscriptXml(xml: string, lang: unknown): PackageSegment[] {
  const results: PackageSegment[] = [];
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1]!, 10);
    const durMs = parseInt(match[2]!, 10);
    const inner = match[3]!;
    let text = '';
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRegex.exec(inner)) !== null) text += sMatch[1];
    if (!text) text = inner.replace(/<[^>]+>/g, '');
    text = decodeEntities(text).trim();
    if (text) results.push({ text, duration: durMs, offset: startMs, lang });
  }
  if (results.length > 0) return results;
  return [...xml.matchAll(RE_XML_TRANSCRIPT)].map((result) => ({
    text: decodeEntities(result[3]!),
    duration: parseFloat(result[2]!),
    offset: parseFloat(result[1]!),
    lang,
  }));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_: string, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

function retrieveVideoId(videoId: string): string {
  if (videoId.length === 11) return videoId;
  const matchId = videoId.match(RE_YOUTUBE);
  if (matchId && matchId.length) return matchId[1]!;
  throw new YoutubeTranscriptError('Impossible to retrieve Youtube video ID.');
}
