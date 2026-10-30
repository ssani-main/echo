// Echo's API routes ported to Seshat (see PORT.md). server.js forwards the routes it lists as ported
// here, after its own middleware (security headers, requireApproved, blockInWeb, rate limits), with
// ECHO_SESHAT_URL and ECHO_SESHAT_SECRET set. Anything on this machine can reach the port, so every
// request must carry that secret in x-echo-forward.
//
//   ECHO_SESHAT_SECRET=<32+ chars> seshat run seshat/server.ts      (ECHO_SESHAT_PORT, default 8001)

import { DEFAULT_PROVIDER_ID, getProviderId, getReasoningLevel, publicProviderList, type PublicProvider } from './providers.ts';
import { thresholdCharsFor } from './digest.ts';
import { logEvent, errLabel } from './usagelog.ts';
import { forOwner, type Meta, type SaveInput, type SearchResult } from './store.ts';
import { EchoError } from './errors.ts';
import { syncVault, markdownEntry } from './vault.ts';
import { entryToMarkdown } from './markdown.ts';
import { extractVideoId, fetchTranscript, getVideoMeta, listCaptionTracks, type CaptionSegment, type CaptionTrack, type FetchTranscriptOptions } from './transcript.ts';

// Same derivation as server.js: an unrecognised value is local.
const ECHO_MODE = process.env.ECHO_MODE === 'web' ? 'web' : process.env.ECHO_MODE === 'desktop' ? 'desktop' : 'local';
const isWeb = ECHO_MODE === 'web';

const portNumber = Number(process.env.ECHO_SESHAT_PORT ?? '8001');
const port = Number.isInteger(portNumber) && portNumber > 0 ? portNumber : 8001;

const secret = process.env.ECHO_SESHAT_SECRET ?? '';
if (secret.length < 32) {
  console.error('ECHO_SESHAT_SECRET must be set (32+ characters), the same value as for server.js.');
  process.exit(1);
}

// x-echo-mode: server.js refuses an answer made in another mode than its own.
const bare: Record<string, string> = { 'x-served-by': 'seshat', 'x-echo-mode': ECHO_MODE };
// Express's spelling of the JSON type, so a forwarded answer's headers match server.js's own.
const headers: Record<string, string> = { ...bare, 'content-type': 'application/json; charset=utf-8' };

interface ErrorFields { code: string; message: string; hint: string; reason?: string; detail?: string }
interface ErrorBody { error: ErrorFields }

/** server.js's sendError envelope; reason and detail only when given and not empty. */
function sendError(code: string, message: string, hint: string, status: number, reason?: string, detail?: string): Response {
  console.error(`[echo] ${code}: ${message}`);
  const error: ErrorFields = { code, message, hint };
  if (reason) error.reason = reason;
  if (detail) error.detail = detail;
  const body: ErrorBody = { error };
  return Response.json(body, { status, headers });
}

// server.js's ECHO_ERROR_STATUS, for the codes a ported route can throw.
const ERROR_STATUS: Record<string, number> = {
  INVALID_URL: 400, TRANSCRIPT_UNAVAILABLE: 422, YTDLP_MISSING: 503, MEMBERS_ONLY: 422, INTERNAL: 500,
};

/** server.js's sendCaughtError: a tagged error keeps its code and message, anything else is a generic 500. */
function sendCaughtError(err: unknown): Response {
  console.error('[echo] caught error:', err);
  if (err instanceof EchoError) {
    const status = ERROR_STATUS[err.echoCode];
    if (status !== undefined) return sendError(err.echoCode, err.message, err.hint || '', status, err.reason, err.detail);
  }
  return sendError('INTERNAL', 'An unexpected server error occurred.', '', 500);
}

function json(body: unknown): Response {
  return Response.json(body, { headers });
}

/** A request that didn't come through server.js. Compared in full; the secret isn't a user's input. */
function notForwarded(req: Request): boolean {
  return req.headers.get('x-echo-forward') !== secret;
}

interface Health { status: string; mode: string }

function health(): Response {
  const body: Health = { status: 'ok', mode: ECHO_MODE };
  return Response.json(body, { headers });
}

interface ServedProvider extends PublicProvider { longPathThresholdChars: number }
interface ProvidersBody { providers: ServedProvider[]; default: string; defaultThinking: string }

/** GET /api/providers: the registry the pickers are built from (server.js has the reasoning). */
function providers(): Response {
  const available = publicProviderList({ isWeb });
  const list: ServedProvider[] = available.map((p) => ({ ...p, longPathThresholdChars: thresholdCharsFor({ provider: p.id }) }));
  const preferred = getProviderId({});
  const fallback = available.length > 0 ? available[0]!.id : DEFAULT_PROVIDER_ID;
  const defaultId = list.some((p) => p.id === preferred) ? preferred : fallback;
  const body: ProvidersBody = { providers: list, default: defaultId, defaultThinking: getReasoningLevel({}) };
  return Response.json(body, { headers });
}

// server.js's express.json({ limit: '5mb' }): body-parser's 5 MiB, a body of exactly that much is read.
const BODY_LIMIT = 5 * 1024 * 1024;

interface JsonBody { value: unknown; error: Response | undefined }

/**
 * The request body as express.json() leaves req.body: {} unless the type is application/json, {} for an
 * empty body, and server.js's own 413 and 400 envelopes (its error middleware) for too large and not JSON,
 * where body-parser's strict mode takes only an object or an array.
 * shortcut: no charset or content-encoding handling (Node answers a gzipped or latin1 body; here it would be
 * read as UTF-8), and a chunked body is read whole before the size check. Behind server.js neither happens,
 * as express.json() has already read the body; needed by the front-door swap (step 9).
 */
async function jsonBody(req: Request): Promise<JsonBody> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { value: {}, error: undefined };
  if (Number(req.headers.get('content-length')) > BODY_LIMIT) return tooLarge();
  const bytes = await req.bytes();
  if (bytes.length > BODY_LIMIT) return tooLarge();
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return { value: {}, error: undefined };
  const first = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/.exec(text);
  if (!first || (first[1] !== '{' && first[1] !== '[')) return notJson();
  try {
    const value: unknown = JSON.parse(text);
    return { value, error: undefined };
  } catch {
    return notJson();
  }
}

function tooLarge(): JsonBody {
  const hint = 'Echo sends large libraries in batches — if you are seeing this, try syncing again.';
  return { value: undefined, error: sendError('TRANSCRIPT_UNAVAILABLE', 'That request is too large.', hint, 413) };
}

function notJson(): JsonBody {
  return { value: undefined, error: sendError('INTERNAL', 'That request body was not valid JSON.', '', 400) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// What happens to a digest after it is read happens in the browser, so the meter only learns it if the page
// says so. Names are an allow-list: this writes to a local file and must not become a way to write lines.
const CLIENT_EVENTS = new Set(['digest-copy', 'digest-download', 'digest-print', 'entry-export']);

/** POST /api/event: one line in the usage log (none in web mode), 204. */
async function clientEvent(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const fields = isRecord(body.value) ? body.value : {};
  const event = fields.event;
  const videoId = fields.videoId;
  if (typeof event !== 'string' || !CLIENT_EVENTS.has(event)) return sendError('INTERNAL', 'Unknown event.', '', 400);
  logEvent(event, { videoId: typeof videoId === 'string' ? videoId.slice(0, 32) : null, ok: true });
  return new Response(null, { status: 204, headers: bare });
}

// ---------------------------------------------------------------------------
// Library (store.ts). Forwarded only while accounts are off, so it is always the default owner's library
// and there is no PDS mirror to run; server.js keeps both until accounts are ported.
// ---------------------------------------------------------------------------

const library = forOwner();

/**
 * A query parameter read as the routes read Express's req.query: a repeated name is an array there, which
 * Number(), String() and parseInt() see joined with commas.
 * shortcut: qs's bracket syntax (`q[a]=1` an object, `q[]=1` an array) and its keeping of malformed `%`
 * escapes aren't copied; both only change how a junk query fails.
 */
function queryValue(req: Request, name: string): string | undefined {
  const all = new URL(req.url).searchParams.getAll(name);
  return all.length > 0 ? all.join(',') : undefined;
}

/** A query parameter as req.query holds it: a string, an array when repeated, undefined when absent. */
function queryRaw(req: Request, name: string): string | string[] | undefined {
  const all = new URL(req.url).searchParams.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return all;
}

/** blockInWeb. Behind server.js it answers first; this is for when the service is the front door. */
function blockedInWeb(): Response | undefined {
  return isWeb ? sendError('WEB_MODE_UNSUPPORTED', 'This feature is not available in hosted web mode.', 'Your library is stored in your browser.', 503) : undefined;
}

function notFound(): Response {
  return sendError('INTERNAL', 'Not found.', '', 404);
}

interface Page { entries: Meta[]; total: number; hasMore: boolean }

/** GET /api/saved: every card, or with ?limit= one page of them and the total. */
async function listSaved(req: Request): Promise<Response> {
  try {
    const limitParam = queryValue(req, 'limit');
    if (limitParam === undefined) return json(await library.listEntries());
    const limit = Number(limitParam);
    if (!Number.isFinite(limit) || limit < 1) return sendError('INTERNAL', 'limit must be a positive number.', '', 400);
    const offsetParam = queryValue(req, 'offset');
    const offset = offsetParam === undefined ? 0 : Number(offsetParam);
    if (!Number.isFinite(offset) || offset < 0) return sendError('INTERNAL', 'offset must be zero or a positive number.', '', 400);
    const entries = await library.listEntries({ limit: Math.min(limit, 500), offset });
    const total = await library.countEntries();
    const page: Page = { entries, total, hasMore: offset + entries.length < total };
    return json(page);
  } catch (err) {
    return sendCaughtError(err);
  }
}

async function getSaved(videoId: string): Promise<Response> {
  try {
    const entry = await library.getEntry(videoId);
    return entry ? json(entry) : notFound();
  } catch (err) {
    return sendCaughtError(err);
  }
}

async function setSavedTags(req: Request, videoId: string): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  try {
    const tags = isRecord(body.value) ? body.value.tags : undefined;
    if (!Array.isArray(tags)) return sendError('INTERNAL', 'tags must be an array.', '', 400);
    const entry = await library.setTags(videoId, tags);
    return entry ? json(entry) : notFound();
  } catch (err) {
    return sendCaughtError(err);
  }
}

async function exportSavedMarkdown(req: Request, videoId: string): Promise<Response> {
  try {
    const entry = await library.getEntry(videoId);
    if (!entry) return notFound();
    const transcript = queryValue(req, 'transcript');
    const md = entryToMarkdown(markdownEntry(entry), { includeTranscript: !(transcript === '0' || transcript === 'false') });
    const slug = (entry.title || 'echo-entry').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'echo-entry';
    const mdHeaders: Record<string, string> = { ...bare, 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${slug}.md"` };
    return new Response(md, { headers: mdHeaders });
  } catch (err) {
    return sendCaughtError(err);
  }
}

async function syncVaultRoute(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const fields = isRecord(body.value) ? body.value : {};
  const dir = fields.dir;
  const resolvedDir = typeof dir === 'string' && dir.trim() ? dir.trim() : process.env.ECHO_VAULT_DIR;
  if (!resolvedDir) return sendError('INVALID_URL', 'No vault folder configured.', 'Choose a folder in Settings, or set ECHO_VAULT_DIR.', 400);
  const t0 = Date.now();
  try {
    const result = await syncVault(resolvedDir, { includeTranscript: fields.includeTranscript, library });
    logEvent('vault-sync', {
      total: result.total, written: result.written, unchanged: result.unchanged, failed: result.failed,
      ok: true, ms: Date.now() - t0,
    });
    return json(result);
  } catch (err) {
    logEvent('vault-sync', { ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(err);
  }
}

/** A text field of POST /api/saved, already checked: the string, null, or undefined when absent. */
function textOf(v: unknown): string | null | undefined {
  return typeof v === 'string' ? v : v === null ? null : undefined;
}

const TEXT_FIELDS = ['url', 'title', 'digest', 'channel', 'channelUrl', 'transcriptSource', 'whisperModel'];

async function saveRoute(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const t0 = Date.now();
  try {
    const fields = isRecord(body.value) ? body.value : {};
    const videoId = fields.videoId;
    const segments = fields.segments;
    const auto = fields.auto === true;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return sendError('INTERNAL', 'videoId and segments are required.', '', 400);
    }
    // Different on purpose (PORT.md): server.js stores a number field as SQLite text ("5.0") and fails a
    // boolean or object with a 500; the types the app sends are checked here instead.
    if (typeof videoId !== 'string') return sendError('INTERNAL', 'videoId must be a string.', '', 400);
    for (const name of TEXT_FIELDS) {
      const v = fields[name];
      if (v !== undefined && v !== null && typeof v !== 'string') return sendError('INTERNAL', `${name} must be a string.`, '', 400);
    }
    const input: SaveInput = {
      url: textOf(fields.url), videoId, title: textOf(fields.title), segments, digest: textOf(fields.digest),
      channel: textOf(fields.channel), channelUrl: textOf(fields.channelUrl),
      transcriptSource: textOf(fields.transcriptSource), whisperModel: textOf(fields.whisperModel),
    };
    const meta = await library.saveEntry(input);
    logEvent('save', { videoId, hadDigest: Boolean(fields.digest), auto, ok: true, ms: Date.now() - t0 });
    return json(meta);
  } catch (err) {
    return sendCaughtError(err);
  }
}

interface Ok { ok: boolean }

async function deleteSaved(videoId: string): Promise<Response> {
  const t0 = Date.now();
  try {
    if (!(await library.deleteEntry(videoId))) return notFound();
    logEvent('unsave', { videoId, ok: true, ms: Date.now() - t0 });
    const ok: Ok = { ok: true };
    return json(ok);
  } catch (err) {
    return sendCaughtError(err);
  }
}

interface SearchBody { results: SearchResult[]; mode: string }

async function search(req: Request): Promise<Response> {
  const q = (queryValue(req, 'q') || '').trim();
  const limit = Math.min(Math.max(parseInt(queryValue(req, 'limit') ?? '') || 20, 1), 100);
  const t0 = Date.now();
  if (!q) {
    const empty: SearchBody = { results: [], mode: 'keyword' };
    return json(empty);
  }
  try {
    const results = await library.searchSummaries(q, limit);
    logEvent('search', { qLen: q.length, mode: 'keyword', results: results.length, ok: true, ms: Date.now() - t0 });
    const found: SearchBody = { results, mode: 'keyword' };
    return json(found);
  } catch (err) {
    logEvent('search', { qLen: q.length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(err);
  }
}

// ---------------------------------------------------------------------------
// Transcripts (transcript.ts). POST /api/transcript is forwarded only with Whisper off (web mode, or
// `transcribe: 'off'`): Whisper comes in step 6, and until then server.js keeps every request that might use it.
// ---------------------------------------------------------------------------

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // server.js refuses to start on a bad value, so behind it this never sees one.
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const MAX_TRANSCRIPT_CHARS = numFromEnv('ECHO_MAX_TRANSCRIPT_CHARS', 200_000);

function invalidUrl(): Response {
  return sendError('INVALID_URL', 'Could not find a valid YouTube video ID in that URL.', 'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.', 400);
}

interface TranscriptBody {
  videoId: string; url: unknown; title: string | null; channel: string | null; channelUrl: string | null;
  segments: CaptionSegment[]; langCode: unknown; transcriptSource: string; whisperModel: string | null;
}

/** POST /api/transcript: the captions, the title and the channel. */
async function transcriptRoute(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const fields = isRecord(body.value) ? body.value : {};
  const videoId = extractVideoId(fields.url);
  if (!videoId) return invalidUrl();
  // Different on purpose (PORT.md): server.js passes any JSON as the language (a number asks YouTube for a
  // track called "5"); the service wants text.
  // shortcut: the type is checked once, as a second typeof on the same value after the refusal reads false in
  // Seshat (gap: typeof-after-narrowing); `typeof fields.lang !== 'string'` then `opts.lang = lang` once fixed.
  const rawLang = fields.lang;
  let lang: string | undefined;
  if (typeof rawLang === 'string') lang = rawLang;
  else if (rawLang !== undefined && rawLang !== null) return sendError('INTERNAL', 'lang must be a string.', '', 400);
  const transcribe = fields.transcribe;
  // shortcut: no cancelling when the client goes away (server.js aborts its Whisper job); captions take
  // seconds and yt-dlp is capped at 30 s. With Whisper (step 6), listen for the disconnect.
  const t0 = Date.now();
  try {
    let whisperMode = 'fallback';
    if (isWeb) whisperMode = 'off';
    else if (typeof transcribe === 'string' && transcribe) whisperMode = transcribe;
    const opts: FetchTranscriptOptions = { transcribe: whisperMode };
    if (lang !== undefined) opts.lang = lang;
    const segments = await fetchTranscript(videoId, opts);
    const meta = await getVideoMeta(videoId);
    const langCode = segments.langUsed || lang || null;
    const chars = segments.reduce((sum, s) => sum + s.text.length, 0);
    if (isWeb && chars > MAX_TRANSCRIPT_CHARS) {
      return sendError(
        'TRANSCRIPT_UNAVAILABLE',
        `Transcript is too long (${chars} characters, limit is ${MAX_TRANSCRIPT_CHARS}).`,
        'This hosted instance caps transcript length. Try a shorter video, or run Echo locally for unlimited length.',
        422,
      );
    }
    logEvent('transcript', { videoId, chars, langCode, ok: true, ms: Date.now() - t0 });
    const answer: TranscriptBody = {
      videoId, url: fields.url, title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl, segments, langCode,
      transcriptSource: segments.source || 'captions', whisperModel: segments.modelUsed || null,
    };
    return json(answer);
  } catch (err) {
    logEvent('transcript', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(err);
  }
}

interface TracksBody { tracks: CaptionTrack[] }

/** GET /api/languages: the caption tracks yt-dlp lists for a video. */
async function languages(req: Request): Promise<Response> {
  const rawId = queryRaw(req, 'videoId');
  if (!rawId) return sendError('INTERNAL', 'videoId query parameter is required.', '', 400);
  const videoId = extractVideoId(rawId);
  if (!videoId) return invalidUrl();
  try {
    const answer: TracksBody = { tracks: await listCaptionTracks(videoId) };
    return json(answer);
  } catch (err) {
    return sendCaughtError(err);
  }
}

interface VideoMetaBody { videoId: string; title: string | null; channel: string | null; channelUrl: string | null }

/** GET /api/video-meta: title and channel through oEmbed. */
async function videoMeta(req: Request): Promise<Response> {
  // shortcut: `if` rather than `rawId || url`, which Seshat compiles wrongly for these unions (gap: or-of-union-values).
  let raw = queryRaw(req, 'videoId');
  if (!raw) raw = queryRaw(req, 'url');
  const videoId = extractVideoId(raw);
  if (!videoId) return invalidUrl();
  try {
    const meta = await getVideoMeta(videoId);
    const answer: VideoMetaBody = { videoId, title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl };
    return json(answer);
  } catch (err) {
    return sendCaughtError(err);
  }
}

/** Every route checks this first: refuse what didn't come through server.js. */
function refused(req: Request): Response | undefined {
  return notForwarded(req) ? sendError('FORBIDDEN', 'Not forwarded by Echo.', '', 403) : undefined;
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  routes: {
    "/api/health": { GET: (req) => refused(req) ?? health() },
    "/api/providers": { GET: (req) => refused(req) ?? providers() },
    "/api/event": { POST: async (req) => refused(req) ?? await clientEvent(req) },
    "/api/saved": {
      GET: async (req) => refused(req) ?? blockedInWeb() ?? await listSaved(req),
      POST: async (req) => refused(req) ?? blockedInWeb() ?? await saveRoute(req),
    },
    "/api/saved/:videoId": {
      GET: async (req) => refused(req) ?? blockedInWeb() ?? await getSaved(req.params.videoId),
      DELETE: async (req) => refused(req) ?? blockedInWeb() ?? await deleteSaved(req.params.videoId),
    },
    "/api/saved/:videoId/tags": { PATCH: async (req) => refused(req) ?? blockedInWeb() ?? await setSavedTags(req, req.params.videoId) },
    "/api/saved/:videoId/export.md": { GET: async (req) => refused(req) ?? blockedInWeb() ?? await exportSavedMarkdown(req, req.params.videoId) },
    "/api/vault/sync": { POST: async (req) => refused(req) ?? blockedInWeb() ?? await syncVaultRoute(req) },
    "/api/search": { GET: async (req) => refused(req) ?? blockedInWeb() ?? await search(req) },
    "/api/transcript": { POST: async (req) => refused(req) ?? await transcriptRoute(req) },
    "/api/languages": { GET: async (req) => refused(req) ?? await languages(req) },
    "/api/video-meta": { GET: async (req) => refused(req) ?? await videoMeta(req) },
  },
  fetch() {
    return sendError('NOT_FOUND', 'Not found.', '', 404);
  },
});
console.log(`Echo's Seshat service on ${server.url} (mode ${ECHO_MODE})`);
