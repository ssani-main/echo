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
import { LOCAL_MEDIA_EXTENSIONS, resolveWhisperBinary, transcribeFile, type WhisperOptions, type WhisperProgress } from './whisper.ts';
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS, downloadState, modelCacheDir, startModelDownload, type DownloadState } from './whisperModel.ts';
import { jsString } from './js.ts';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// shortcut: std/crypto, as node:crypto goes through Seshat's npm bridge (gap: node-crypto-bridged).
import { createHash } from 'std/crypto';

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
  INVALID_URL: 400, TRANSCRIPT_UNAVAILABLE: 422, YTDLP_MISSING: 503, MEMBERS_ONLY: 422, RATE_LIMITED: 429, INTERNAL: 500,
  FFMPEG_MISSING: 503, MEDIA_UNREADABLE: 422, AUDIO_DOWNLOAD_REFUSED: 503,
  WHISPER_MISSING: 503, WHISPER_MODEL_MISSING: 503, WHISPER_FAILED: 502, WHISPER_AUDIO_TOO_LONG: 422, WHISPER_TIMEOUT: 504,
  WHISPER_MODEL_UNKNOWN: 400, WHISPER_MODEL_DOWNLOAD_FAILED: 502, WHISPER_MODEL_VERIFY_FAILED: 502,
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
// Transcripts (transcript.ts), Whisper's included (whisper.ts).
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
  const rawLang = fields.lang;
  let lang: string | undefined;
  if (typeof rawLang === 'string') lang = rawLang;
  else if (rawLang !== undefined && rawLang !== null) return sendError('INTERNAL', 'lang must be a string.', '', 400);
  // The same for the model: server.js would look a number up as a model name.
  const rawModel = fields.whisperModel;
  let whisperModel: string | undefined;
  if (typeof rawModel === 'string') whisperModel = rawModel;
  else if (rawModel !== undefined && rawModel !== null) return sendError('INTERNAL', 'whisperModel must be a string.', '', 400);
  const transcribe = fields.transcribe;

  // Optional live progress: the client sends a jobId and reads GET /api/transcript/progress?jobId=…. The first
  // entry comes with the first real tick (only when Whisper runs), so a caption fetch never shows a progress card.
  const rawJob = fields.jobId;
  const jobId = !isWeb && typeof rawJob === 'string' && rawJob ? rawJob : null;
  const job = cancellable(req);
  const t0 = Date.now();
  try {
    let whisperMode = 'fallback';
    if (isWeb) whisperMode = 'off';
    else if (typeof transcribe === 'string' && transcribe) whisperMode = transcribe;
    const opts: FetchTranscriptOptions = { transcribe: whisperMode, signal: job.signal };
    if (lang !== undefined) opts.lang = lang;
    if (whisperModel !== undefined) opts.modelName = whisperModel;
    if (jobId) opts.onProgress = (p: WhisperProgress): void => setJobProgress(jobId, p);
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
    finishJob(jobId, 'done');
    // modelUsed can differ from the model asked for: a non-English video on base runs on small.
    const answer: TranscriptBody = {
      videoId, url: fields.url, title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl, segments, langCode,
      transcriptSource: segments.source || 'captions', whisperModel: segments.modelUsed || null,
    };
    return json(answer);
  } catch (err) {
    // The client went away: the abort surfaces here, and nobody reads the answer.
    if (job.signal.aborted) {
      logEvent('transcript', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return new Response(null, { status: 204, headers: bare });
    }
    logEvent('transcript', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    finishJob(jobId, 'error');
    return sendCaughtError(err);
  } finally {
    job.release();
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
  const videoId = extractVideoId(queryRaw(req, 'videoId') || queryRaw(req, 'url'));
  if (!videoId) return invalidUrl();
  try {
    const meta = await getVideoMeta(videoId);
    const answer: VideoMetaBody = { videoId, title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl };
    return json(answer);
  } catch (err) {
    return sendCaughtError(err);
  }
}

// ---------------------------------------------------------------------------
// Whisper: cancelling, live progress, local media, the models (local/desktop only)
// ---------------------------------------------------------------------------

// Requests that can be cancelled, by the id server.js gives each forwarded request (x-echo-request).
const inFlight = new Map<string, AbortController>();

/**
 * An abort signal for a long request, fired when its client goes away (server.js aborts its Whisper job then).
 * shortcut: server.js sees the disconnect and calls POST /internal/abort with the request's id, as a served
 * Request has no `signal` in Seshat (gap: request-signal). With it (and at the front-door swap), use req.signal.
 */
function cancellable(req: Request): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();
  const id = req.headers.get('x-echo-request') ?? '';
  if (id) inFlight.set(id, ac);
  return { signal: ac.signal, release: (): void => { if (id) inFlight.delete(id); } };
}

function abortRequest(req: Request): Response {
  inFlight.get(req.headers.get('x-echo-request') ?? '')?.abort();
  return new Response(null, { status: 204, headers: bare });
}

// Live Whisper progress by the client's jobId: the transcript routes update it, the SSE route reads it. An
// entry stays 15 s after its job ends, so a stream that connects late still sees 'done' or 'error'.
interface JobState { phase?: string; pct?: number; status: string; updatedAt: number }
const whisperJobs = new Map<string, JobState>();

function setJobProgress(jobId: string, p: WhisperProgress): void {
  whisperJobs.set(jobId, { phase: p.phase, pct: p.pct, status: 'running', updatedAt: Date.now() });
}

function finishJob(jobId: string | null, status: string): void {
  if (!jobId) return;
  const prev = whisperJobs.get(jobId);
  whisperJobs.set(jobId, { phase: status === 'done' ? 'done' : prev?.phase, pct: prev?.pct, status, updatedAt: Date.now() });
  setTimeout(() => { whisperJobs.delete(jobId); }, 15_000);
}

// Polled every 500 ms for a smooth bar; a heartbeat every 10 s while no job entry exists yet.
const PROGRESS_POLL_MS = 500;
const PROGRESS_PING_MS = 10_000;
// One page holds one stream, so reaching this means something is looping.
const PROGRESS_MAX_STREAMS = 32;
// A client that vanished without closing its socket would hold its timer forever; EventSource reconnects.
const PROGRESS_MAX_STREAM_MS = 30 * 60_000;
let openProgressStreams = 0;

interface ProgressEvent { phase?: string; pct: number; status: string }

/** GET /api/transcript/progress: a job's Whisper progress as server-sent events, until it ends. */
function progressStream(req: Request): Response {
  const jobId = queryValue(req, 'jobId') ?? '';
  if (!jobId) return new Response(null, { status: 400, headers: bare });
  if (openProgressStreams >= PROGRESS_MAX_STREAMS) {
    return sendError('RATE_LIMITED', 'Too many progress streams are already open.', 'Close some Echo tabs, or wait for the running transcriptions to finish.', 429);
  }
  openProgressStreams++;

  let done = false;
  let sinceLastPing = 0;
  let stopTimers = (): void => {};
  // One teardown for every exit (an ended job, the lifetime cap, the client leaving), so the count can't drift.
  const stop = (): boolean => {
    if (done) return false;
    done = true;
    stopTimers();
    openProgressStreams--;
    return true;
  };
  const body = new ReadableStream({
    start(controller) {
      const finish = (): void => { if (stop()) controller.close(); };
      const tick = (): void => {
        if (done) return;
        const st = whisperJobs.get(jobId);
        if (!st) {
          sinceLastPing += PROGRESS_POLL_MS;
          if (sinceLastPing >= PROGRESS_PING_MS) {
            sinceLastPing = 0;
            controller.enqueue(': ping\n\n');
          }
          return;
        }
        sinceLastPing = 0;
        const event: ProgressEvent = { phase: st.phase, pct: st.pct ?? 0, status: st.status || 'running' };
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        if (st.status && st.status !== 'running') finish();
      };
      controller.enqueue('retry: 2000\n\n');
      const iv = setInterval(tick, PROGRESS_POLL_MS);
      const maxTimer = setTimeout(finish, PROGRESS_MAX_STREAM_MS);
      stopTimers = (): void => { clearInterval(iv); clearTimeout(maxTimer); };
      tick();
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    headers: { ...bare, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}

// An uploaded file's cap: generous (an hour of lecture video is easily 500 MB), but this writes to temp.
const MAX_UPLOAD_BYTES = numFromEnv('ECHO_MAX_UPLOAD_BYTES', 2_000_000_000);

/**
 * A stable id for a local file, so it lives in the library beside YouTube entries: name, size, and the first
 * and last MiB (hashing all of a 500 MB file buys nothing). Fits vault.js's `^[A-Za-z0-9_-]{1,20}$`.
 */
function localMediaId(name: string, buf: Uint8Array): string {
  const hash = createHash('sha256')
    .update(String(name || ''))
    .update(String(buf.length))
    .update(buf.slice(0, 1 << 20))
    .update(buf.slice(Math.max(0, buf.length - (1 << 20))))
    .digest('hex');
  return `file_${hash.slice(0, 14)}`;
}

interface FileTranscriptBody {
  videoId: string; url: string; title: string; channel: null; channelUrl: null; segments: CaptionSegment[];
  langCode: unknown; transcriptSource: string; localFile: boolean;
}

/** POST /api/transcript/file: the Whisper stage on an uploaded file; the body is the file's raw bytes. */
async function transcribeFileRoute(req: Request): Promise<Response> {
  const rawName = queryRaw(req, 'name');
  // Only ever a display title and hash input, never a path.
  const displayName = (typeof rawName === 'string' ? rawName : '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || 'Untitled recording';
  const extMatch = displayName.match(/\.[A-Za-z0-9]+$/);
  const ext = (extMatch ? extMatch[0] : '').toLowerCase();

  // express.raw({ type: '*/*' }) reads a body only when it has a content type; otherwise req.body stays {}.
  if (Number(req.headers.get('content-length')) > MAX_UPLOAD_BYTES) return tooLarge().error!;
  const bytes = req.headers.get('content-type') ? await req.bytes() : new Uint8Array(0);
  if (bytes.length > MAX_UPLOAD_BYTES) return tooLarge().error!;
  if (bytes.length === 0) return sendError('INTERNAL', 'No file was uploaded.', 'Choose an audio or video file.', 400);
  if (ext && !LOCAL_MEDIA_EXTENSIONS.has(ext)) {
    return sendError(
      'INTERNAL',
      `Unsupported file type: ${ext}`,
      'Echo reads audio and video files — mp3, m4a, wav, flac, ogg, mp4, mov, mkv, webm and similar.',
      400,
    );
  }

  const rawJob = queryRaw(req, 'jobId');
  const jobId = typeof rawJob === 'string' && rawJob ? rawJob : null;
  const rawModel = queryRaw(req, 'whisperModel');
  const job = cancellable(req);
  const t0 = Date.now();
  const videoId = localMediaId(displayName, bytes);
  // A generated name in the temp folder, never one derived from the upload's own filename.
  const tmpPath = join(tmpdir(), `echo-upload-${videoId}${ext}`);
  try {
    await writeFile(tmpPath, bytes);
    const opts: WhisperOptions = { signal: job.signal };
    if (typeof rawModel === 'string') opts.modelName = rawModel;
    if (jobId) opts.onProgress = (p: WhisperProgress): void => setJobProgress(jobId, p);
    const segments = await transcribeFile(tmpPath, opts);
    const chars = segments.reduce((sum, s) => sum + s.text.length, 0);
    logEvent('transcript-file', { videoId, chars, bytes: bytes.length, ok: true, ms: Date.now() - t0 });
    finishJob(jobId, 'done');
    // The YouTube route's envelope, so the page renders it the same way; no url to link back to.
    const answer: FileTranscriptBody = {
      videoId,
      url: '',
      title: displayName.replace(/\.[A-Za-z0-9]+$/, ''),
      channel: null,
      channelUrl: null,
      segments,
      langCode: segments.langUsed || null,
      transcriptSource: 'whisper',
      localFile: true,
    };
    return json(answer);
  } catch (err) {
    if (job.signal.aborted) {
      logEvent('transcript-file', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return new Response(null, { status: 204, headers: bare });
    }
    logEvent('transcript-file', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    finishJob(jobId, 'error');
    return sendCaughtError(err);
  } finally {
    job.release();
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

interface ModelStatus extends DownloadState { label: string; sizeBytes: number }
interface WhisperStatusBody { binaryPresent: boolean; defaultModel: string; cacheDir: string; models: ModelStatus[] }

/** GET /api/whisper/status: is the binary there, and each model's download state. */
function whisperStatus(): Response {
  const models = Object.keys(WHISPER_MODELS).map((n): ModelStatus => {
    const m = WHISPER_MODELS[n]!;
    return { name: m.name, label: m.label, sizeBytes: m.sizeBytes, ...downloadState(n) };
  });
  const body: WhisperStatusBody = { binaryPresent: !!resolveWhisperBinary(), defaultModel: DEFAULT_WHISPER_MODEL, cacheDir: modelCacheDir(), models };
  return json(body);
}

/**
 * POST /api/whisper/model: start a model's download. Different on purpose (PORT.md): a model is looked up as
 * a string among the registry's own names; server.js's plain-object lookup takes `constructor`, and an array.
 */
async function whisperModelRoute(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const model = isRecord(body.value) ? body.value.model : undefined;
  if (typeof model !== 'string' || !Object.keys(WHISPER_MODELS).includes(model)) {
    return sendError('WHISPER_MODEL_UNKNOWN', `Unknown model: ${jsString(model)}`, 'Choose base or small.', 400);
  }
  try {
    startModelDownload(model);
    return json(downloadState(model));
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
    "/api/transcript/progress": { GET: (req) => refused(req) ?? blockedInWeb() ?? progressStream(req) },
    "/api/transcript/file": { POST: async (req) => refused(req) ?? blockedInWeb() ?? await transcribeFileRoute(req) },
    "/api/whisper/status": { GET: (req) => refused(req) ?? blockedInWeb() ?? whisperStatus() },
    "/api/whisper/model": { POST: async (req) => refused(req) ?? blockedInWeb() ?? await whisperModelRoute(req) },
    "/internal/abort": { POST: (req) => refused(req) ?? abortRequest(req) },
  },
  fetch() {
    return sendError('NOT_FOUND', 'Not found.', '', 404);
  },
});
console.log(`Echo's Seshat service on ${server.url} (mode ${ECHO_MODE})`);
