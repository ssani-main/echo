import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync } from 'fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import {
  extractVideoId,
  fetchTranscript,
  getVideoMeta,
  listCaptionTracks,
} from './transcript.js';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL, modelCacheDir, downloadState, startModelDownload } from './whisperModel.js';
import { resolveWhisperBinary, transcribeFile, LOCAL_MEDIA_EXTENSIONS } from './whisper.js';
import {
  listEntries,
  getEntry,
  saveEntry,
  deleteEntry,
  setTags,
  searchLibrary,
} from './store.js';
import { entryToMarkdown } from './markdown.js';
import { syncVault } from './vault.js';
import {
  generateDigest,
  enrich,
  suggestTags,
} from './digest.js';
import {
  signToken, verifyToken, parseCookies, serializeCookie, randomToken, pkceChallenge,
  buildGoogleAuthUrl, decodeIdToken, validateIdTokenPayload, exchangeCode,
  SESSION_COOKIE, OAUTH_COOKIE, SESSION_TTL_MS, OAUTH_TTL_MS,
} from './auth.js';
import {
  openSyncDb, upsertUser, getUser, pullEntries, pushEntries, userBytes, deleteUser,
  bumpTokenVersion,
} from './syncStore.js';
import { logEvent, errLabel } from './usagelog.js';
import { validateApiKey } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Mode flag — 'local' (default: npm start) vs 'web' (hosted) vs 'desktop'
// (Tauri app). Every web-only branch below is gated on `isWeb` so local/
// desktop behavior stays byte-for-byte identical to today. Desktop mode is
// otherwise identical to local (full server-side library, no rate limits,
// no payload caps) — it only additionally allows optional
// BYOK via `readApiKey`/`/api/validate-key`, purely as a fallback when the
// local `claude` CLI isn't installed/authenticated.
// ---------------------------------------------------------------------------
const ECHO_MODE = process.env.ECHO_MODE === 'web' ? 'web'
  : process.env.ECHO_MODE === 'desktop' ? 'desktop'
  : 'local';
const isWeb = ECHO_MODE === 'web';
const isDesktop = ECHO_MODE === 'desktop';

// ---------------------------------------------------------------------------
// Numeric env config validation
// ---------------------------------------------------------------------------
// Bare Number(process.env.X) silently yields NaN for malformed values (e.g.
// "200k"), which for size caps means `chars > NaN` is always false — a
// caller-controlled bypass of the cap. Fail loudly at startup instead.

/**
 * Reads a numeric env var, validating it is a finite number >= min.
 * Returns `fallback` when the env var is unset. Throws a clear startup
 * Error when the env var IS set but is not a valid number.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number }} [opts]
 * @returns {number}
 */
function numFromEnv(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(
      `Invalid value for env var ${name}: "${raw}". Expected a finite number >= ${min}.`
    );
  }
  return n;
}

const app = express();
const PORT = numFromEnv('PORT', 8000, { min: 1 });

// Bind to localhost by default — safe default for local/desktop use, where
// the server should never be reachable from the network. Hosted/web
// deployments (e.g. behind a reverse proxy) can opt in via ECHO_HOST.
const HOST = process.env.ECHO_HOST && process.env.ECHO_HOST.trim()
  ? process.env.ECHO_HOST.trim()
  : '127.0.0.1';

if (isWeb) {
  // Running behind a reverse proxy in web mode — needed for correct req.ip
  // (used by the rate limiter) and secure-cookie detection.
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '5mb' }));

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
// The page's script and CSS live in real files (app.js / app.css /
// theme-init.js / echo-config.js) and it carries no inline <script>, <style>
// or style="" attribute, so NEITHER script-src nor style-src needs
// 'unsafe-inline' — the weakness the inline monolith forced is gone.
//
// Note what this does and does not cover: `el.style.width = x` is the CSSOM
// and is not governed by style-src, so dynamic styling still works. What is
// blocked is a style attribute in parsed markup, including one arriving
// through innerHTML — which is exactly the injection path worth closing.
// It also blocks framing, MIME-sniffing, and restricts every origin to self:
// JSZip is vendored (public/vendor/) rather than pulled from a CDN, and the
// Plaintext theme loads no webfont, so the policy names no external host at
// all. The only remaining outbound origins are images from YouTube's thumbnail
// CDNs.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "font-src 'self'; " +
  "img-src 'self' data: https://i.ytimg.com https://img.youtube.com; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'self'";

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', CSP);
  next();
});

// ---------------------------------------------------------------------------
// Step 1 — inject window.__ECHO__ into index.html
// ---------------------------------------------------------------------------
// index.html is read ONCE at startup and the injected HTML is cached in
// memory, rather than re-reading + re-injecting on every request. Trade-off:
// editing public/index.html during local development requires a server
// restart to pick up changes (it did not before this change).
// The page's mode flag used to be injected as an inline <script> into the HTML.
// It is served as a real file instead, because that was the last inline script
// on the page — and with it gone, the CSP above can refuse inline script
// outright rather than allowing it for everything.
function buildConfigScript(mode) {
  return `window.__ECHO__=${JSON.stringify({ mode })};\n`;
}

const INDEX_HTML_PATH = join(__dirname, 'public', 'index.html');
const CACHED_INDEX_HTML = readFileSync(INDEX_HTML_PATH, 'utf8');

// The page is a ~316 KB inline monolith that gzips to ~75 KB, and it is already
// byte-identical on every request (see the boot-time cache above) — so compress
// it ONCE here rather than per response. That is why this is a hand-rolled
// Content-Encoding rather than a general compression middleware: a middleware
// would re-gzip the same 316 KB on every page load, which on a small hosted VM
// is real CPU spent to produce a byte-identical result, and in local mode it
// would be CPU spent compressing loopback traffic that never hits a network.
// Level 9 is free here for the same reason: it runs once, at boot.
const CACHED_INDEX_GZIP = gzipSync(Buffer.from(CACHED_INDEX_HTML, 'utf8'), { level: 9 });

/**
 * True when the client actually accepts gzip. Honours an explicit `q=0`
 * ("gzip;q=0" means *not* acceptable), which a naive substring test would
 * misread as support and then serve an encoding the client rejects.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function acceptsGzip(req) {
  const header = req.get('Accept-Encoding') || '';
  const match = header.match(/(?:^|,)\s*gzip\s*(?:;\s*q=([0-9.]+))?/i);
  if (!match) return false;
  return match[1] === undefined || parseFloat(match[1]) > 0;
}

/**
 * Serve a boot-time-cached, boot-time-gzipped asset.
 *
 * index.html, app.css and app.js are all read once and compressed once, for the
 * same reason: they are byte-identical on every request, so per-response gzip
 * would burn CPU to produce the same bytes. The trade-off is the one index.html
 * always had — editing any of them in dev needs a server restart.
 *
 * Registered BEFORE express.static so these win over the on-disk copies, which
 * would otherwise be served uncompressed.
 */
function serveCached(path, contentType, text, gzipped) {
  app.get(path, (req, res) => {
    res.set('Content-Type', contentType);
    res.set('Vary', 'Accept-Encoding');
    if (acceptsGzip(req)) {
      res.set('Content-Encoding', 'gzip');
      return res.send(gzipped);
    }
    return res.send(text);
  });
}

const APP_CSS = readFileSync(join(__dirname, 'public', 'app.css'), 'utf8');
const APP_JS = readFileSync(join(__dirname, 'public', 'app.js'), 'utf8');
const THEME_INIT_JS = readFileSync(join(__dirname, 'public', 'theme-init.js'), 'utf8');
const JSZIP_JS = readFileSync(join(__dirname, 'public', 'vendor', 'jszip.min.js'), 'utf8');
const CONFIG_JS = buildConfigScript(ECHO_MODE);

serveCached('/', 'text/html; charset=utf-8', CACHED_INDEX_HTML, CACHED_INDEX_GZIP);
serveCached('/app.css', 'text/css; charset=utf-8', APP_CSS, gzipSync(Buffer.from(APP_CSS, 'utf8'), { level: 9 }));
serveCached('/app.js', 'text/javascript; charset=utf-8', APP_JS, gzipSync(Buffer.from(APP_JS, 'utf8'), { level: 9 }));
serveCached('/theme-init.js', 'text/javascript; charset=utf-8', THEME_INIT_JS, gzipSync(Buffer.from(THEME_INIT_JS, 'utf8'), { level: 9 }));
serveCached('/echo-config.js', 'text/javascript; charset=utf-8', CONFIG_JS, gzipSync(Buffer.from(CONFIG_JS, 'utf8'), { level: 9 }));
serveCached('/vendor/jszip.min.js', 'text/javascript; charset=utf-8', JSZIP_JS, gzipSync(Buffer.from(JSZIP_JS, 'utf8'), { level: 9 }));

// ---------------------------------------------------------------------------
// Response compression (API JSON + markdown export)
// ---------------------------------------------------------------------------
// The app shell above is compressed once at boot, but API responses are built
// per request and some are big: a 45-minute transcript is ~166 KB of JSON that
// gzips to ~14 KB — 11.7x — in ~2 ms at level 6. Level 9 buys another 2% for 3x
// the CPU, so 6 it is (the same default zlib and the `compression` middleware
// use). At 2 ms per response this earns its place in every mode, including the
// loopback ones, rather than being gated to hosted web mode.
//
// This wraps res.send() instead of pulling in a compression middleware because
// every response Echo would compress is ALREADY a fully-buffered string or
// Buffer — res.json() serialises before it sends — so there is no streaming
// case to handle and no reason to carry a dependency for one. The SSE route
// never goes through res.send(), so it is untouched by this and keeps
// streaming uncompressed, which is what an event stream needs.

const gzipAsync = promisify(gzip);
const RESPONSE_GZIP_LEVEL = 6;

// Under roughly one network packet, compressing spends CPU and two extra
// headers to save nothing.
const RESPONSE_GZIP_MIN_BYTES = 1024;

const COMPRESSIBLE_TYPE_RE = /^(?:application\/json|text\/)/i;

app.use((req, res, next) => {
  const rawSend = res.send.bind(res);

  res.send = function compressedSend(body) {
    // Already encoded (the pre-gzipped app shell), or the client can't take it.
    if (res.get('Content-Encoding') || !acceptsGzip(req)) return rawSend(body);
    // Objects are left alone: res.json() stringifies first and calls back into
    // here with the serialised string, so compressing here too would be double
    // work on a body Express is about to replace.
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return rawSend(body);
    if (!COMPRESSIBLE_TYPE_RE.test(res.get('Content-Type') || '')) return rawSend(body);

    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (buf.length < RESPONSE_GZIP_MIN_BYTES) return rawSend(body);

    res.set('Vary', 'Accept-Encoding');
    gzipAsync(buf, { level: RESPONSE_GZIP_LEVEL }).then(
      (gz) => {
        // The client can disconnect while we compress — writing then would
        // throw inside a promise nobody is awaiting.
        if (res.writableEnded) return;
        res.set('Content-Encoding', 'gzip');
        rawSend(gz);
      },
      (err) => {
        // Compression is an optimisation, never a reason to fail a response.
        console.error('[echo] response compression failed, sending uncompressed:', err.message);
        if (!res.writableEnded) rawSend(body);
      }
    );
    return res;
  };

  next();
});

app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Structured error helpers
// ---------------------------------------------------------------------------

// HTTP status codes to use for each error code
const ECHO_ERROR_STATUS = {
  INVALID_URL:            400,
  TRANSCRIPT_UNAVAILABLE: 422,
  CLAUDE_NOT_INSTALLED:   503,
  CLAUDE_NOT_AUTHED:      503,
  CLAUDE_FAILED:          502,
  YTDLP_MISSING:          503,
  MEMBERS_ONLY:           422,
  RATE_LIMITED:           429,
  INTERNAL:               500,
  API_NOT_AUTHED:         401,
  API_RATE_LIMITED:       429,
  API_FAILED:             502,
  WEB_MODE_UNSUPPORTED:   503,
  FFMPEG_MISSING:  503,
  WHISPER_MISSING:        503,
  WHISPER_MODEL_MISSING:  503,
  WHISPER_FAILED:         502,
  WHISPER_AUDIO_TOO_LONG: 422,
  WHISPER_TIMEOUT:        504,
  WHISPER_MODEL_UNKNOWN:         400,
  WHISPER_MODEL_DOWNLOAD_FAILED: 502,
  WHISPER_MODEL_VERIFY_FAILED:   502,
  // The model returned something unparseable. 502 because the failure is
  // upstream, not in the request — and being in this map at all is what stops
  // it falling through to a generic "unexpected server error".
  MODEL_BAD_JSON:         502,
  AUTH_FAILED:            502,
};

/**
 * Send a structured JSON error envelope: { error: { code, message, hint } }
 * Logs the raw message server-side.
 *
 * @param {import('express').Response} res
 * @param {string} code     - one of the ECHO_ERROR codes or any uppercase string
 * @param {string} message  - human-readable short description
 * @param {string} [hint]   - optional remediation hint shown to the user
 * @param {number} [status] - override HTTP status (defaults via ECHO_ERROR_STATUS)
 * @param {{ reason?: string, detail?: string }} [extra] - optional classification fields
 */
function sendError(res, code, message, hint = '', status = null, extra = {}) {
  console.error(`[echo] ${code}: ${message}`);
  const httpStatus = status ?? ECHO_ERROR_STATUS[code] ?? 500;
  const error = { code, message, hint };
  if (extra.reason) error.reason = extra.reason;
  if (extra.detail) error.detail = extra.detail;
  return res.status(httpStatus).json({ error });
}

/**
 * Convert a caught Error (potentially tagged with echoCode / hint) into
 * a structured API response. Falls back to INTERNAL if no echoCode is set.
 *
 * @param {import('express').Response} res
 * @param {Error} err
 */
function sendCaughtError(res, err) {
  console.error('[echo] caught error:', err);
  const code = err.echoCode;
  if (code && Object.prototype.hasOwnProperty.call(ECHO_ERROR_STATUS, code)) {
    return sendError(res, code, err.message, err.hint || '', null, { reason: err.reason, detail: err.detail });
  }
  // Unexpected error — log detail, send generic message to client
  return sendError(res, 'INTERNAL', 'An unexpected server error occurred.', '');
}

/**
 * Validate that `value` is a non-empty (post-trim) string, sending a
 * structured 400 INTERNAL error via sendError() and returning false if not.
 * Callers should `if (!requireText(...)) return;` immediately after.
 *
 * @param {import('express').Response} res
 * @param {*} value
 * @param {string} message - error message to send when validation fails
 * @param {string} [hint]  - optional remediation hint
 * @returns {boolean} true if value is valid text (caller should proceed)
 */
function requireText(res, value, message, hint = '') {
  if (!value || !value.trim()) {
    sendError(res, 'INTERNAL', message, hint, 400);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 2 — BYOK (bring-your-own-key) header threading
// ---------------------------------------------------------------------------
// Honored in web mode (required there) and desktop mode (optional there —
// the Tauri app lets a user without the `claude` CLI add their own
// Anthropic key in Settings). In local mode this always returns undefined,
// so getProvider() falls through to the default ClaudeCliProvider —
// unchanged. In desktop mode a keyless request also falls through to the
// CLI provider; the header is just an optional override.

function readApiKey(req) {
  const k = req.get('X-Echo-Api-Key');
  return ((isWeb || isDesktop) && k && k.trim()) ? k.trim() : undefined;
}

/**
 * Guards AI endpoints in web mode: every AI call must be billed to a
 * user-supplied Anthropic API key, never to the operator's own credentials.
 * Without this, a keyless request in web mode would silently fall back to
 * ClaudeCliProvider (or ApiKeyProvider's process.env.ANTHROPIC_API_KEY
 * fallback), billing the operator. NO-OP in local/desktop mode — the CLI
 * provider continues to work with no key, unchanged.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true if the response was already sent (caller must return)
 */
function requireWebKey(req, res) {
  if (!isWeb) return false;
  if (readApiKey(req)) return false;
  sendError(
    res,
    'API_NOT_AUTHED',
    'An Anthropic API key is required for this hosted instance.',
    'Add your own Anthropic API key in Settings to use AI features here, or run Echo locally/desktop for unlimited use.'
  );
  return true;
}

// ---------------------------------------------------------------------------
// Step 6 — abuse / cost guards (web-gated no-ops in local mode)
// ---------------------------------------------------------------------------

// Max transcript length (characters) accepted in web mode before rejecting.
const ECHO_MAX_TRANSCRIPT_CHARS = numFromEnv('ECHO_MAX_TRANSCRIPT_CHARS', 200_000, { min: 1 });

// Max text/segments payload size (characters) accepted by AI endpoints in web mode.
const ECHO_MAX_AI_PAYLOAD_CHARS = numFromEnv('ECHO_MAX_AI_PAYLOAD_CHARS', 200_000, { min: 1 });

/**
 * Pure sliding-window rate-limit check. Records a hit for `key` in `store`
 * (a Map<string, number[]> of hit timestamps) and reports whether that key
 * has exceeded `maxPerWindow` hits within the trailing `windowMs`.
 *
 * Mutates `store` in place: prunes timestamps older than the window, then
 * appends the current hit (`now`) — even when the limit is exceeded, so
 * callers can decide whether to still count rejected attempts (they do here,
 * which keeps a sustained-abuse client rate-limited rather than resetting).
 *
 * @param {string} key
 * @param {number} maxPerWindow
 * @param {number} windowMs
 * @param {Map<string, number[]>} store
 * @param {number} [now]
 * @returns {boolean} true if this hit exceeds the limit
 */
function rateLimitHit(key, maxPerWindow, windowMs, store, now = Date.now()) {
  const cutoff = now - windowMs;
  const existing = store.get(key) || [];
  const recent = existing.filter((ts) => ts > cutoff);
  recent.push(now);
  store.set(key, recent);
  return recent.length > maxPerWindow;
}

/**
 * Express middleware factory — NO-OP unless running in web mode. Keys by
 * req.ip, enforces `max` requests per `windowMs` per IP, and responds with
 * the structured error envelope at 429 when exceeded.
 *
 * @param {number} max
 * @param {number} windowMs
 * @returns {import('express').RequestHandler}
 */
// How often (ms) each webLimit() store is swept for fully-stale IP entries,
// to bound memory growth from the otherwise-never-shrinking Map of hits.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Removes entries from `store` whose most recent hit already fell outside
 * `windowMs` — i.e. keys with no timestamps left after pruning. Called
 * opportunistically (time-gated) rather than on every request, to keep the
 * hot path cheap.
 *
 * @param {Map<string, number[]>} store
 * @param {number} windowMs
 * @param {number} now
 */
function sweepStaleEntries(store, windowMs, now) {
  const cutoff = now - windowMs;
  for (const [key, timestamps] of store) {
    const hasRecent = timestamps.some((ts) => ts > cutoff);
    if (!hasRecent) store.delete(key);
  }
}

function webLimit(max, windowMs) {
  const store = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    if (!isWeb) return next();
    const now = Date.now();
    if (now - lastSweep > RATE_LIMIT_SWEEP_INTERVAL_MS) {
      lastSweep = now;
      sweepStaleEntries(store, windowMs, now);
    }
    const key = req.ip || 'unknown';
    if (rateLimitHit(key, max, windowMs, store)) {
      return sendError(
        res,
        'RATE_LIMITED',
        'Too many requests — please slow down.',
        `Limit is ${max} requests per ${Math.round(windowMs / 1000)}s. Try again shortly.`
      );
    }
    next();
  };
}

/**
 * Guards AI endpoints in web mode against oversize payloads before they ever
 * reach digest.js. NO-OP in local mode (returns false). `text` and/or
 * `segments` may be passed; whichever is present is measured.
 *
 * @param {import('express').Response} res
 * @param {{ text?: string, segments?: Array<{text?:string}> }} payload
 * @returns {boolean} true if the response was already sent (caller must return)
 */
function rejectOversizeAiPayload(res, { text, segments } = {}) {
  if (!isWeb) return false;

  const textChars = typeof text === 'string' ? text.length : 0;
  const segChars = Array.isArray(segments)
    ? segments.reduce((sum, s) => sum + String(s?.text || '').length, 0)
    : 0;
  const totalChars = textChars + segChars;

  if (totalChars > ECHO_MAX_AI_PAYLOAD_CHARS) {
    sendError(
      res,
      'TRANSCRIPT_UNAVAILABLE',
      `Payload is too large (${totalChars} characters, limit is ${ECHO_MAX_AI_PAYLOAD_CHARS}).`,
      'This hosted instance caps AI request size. Try a shorter transcript, or run Echo locally for unlimited length.'
    );
    return true;
  }
  return false;
}

/**
 * Express middleware — blocks a route entirely in web mode with a 503.
 * NO-OP in local/desktop mode. Used to disable server-side library/search
 * routes in hosted web mode, where persistence lives client-side (IndexedDB)
 * and the server-side SQLite store must never be reachable by visitors.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function blockInWeb(req, res, next) {
  if (isWeb) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'This feature is not available in hosted web mode.',
      'Your library is stored in your browser.'
    );
  }
  next();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
// Unauthenticated, unrated-limited liveness check for container/proxy
// healthchecks (e.g. Docker HEALTHCHECK, load balancer probes). Works
// identically in local and web mode.

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mode: ECHO_MODE });
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

// Live Whisper progress, keyed by a client-supplied jobId. The POST /api/transcript
// handler updates the entry as yt-dlp downloads + whisper-cli transcribes; the SSE
// route below streams it to the browser. Entries self-expire shortly after the job
// ends so a late-connecting stream can still observe the terminal 'done'/'error'.
const whisperJobs = new Map();
function setJobProgress(jobId, data) {
  if (jobId) whisperJobs.set(jobId, { ...data, updatedAt: Date.now() });
}
function finishJob(jobId, status) {
  if (!jobId) return;
  const prev = whisperJobs.get(jobId) || {};
  whisperJobs.set(jobId, { ...prev, phase: status === 'done' ? 'done' : prev.phase, status, updatedAt: Date.now() });
  setTimeout(() => whisperJobs.delete(jobId), 15_000).unref?.();
}

// How often the job state is polled for a connected stream, and how often a
// comment heartbeat goes out while no job entry exists yet. Polling stays at
// 500 ms so the progress bar moves smoothly; the heartbeat is far slower
// because it carries no information — it only keeps the connection warm.
const PROGRESS_POLL_MS = 500;
const PROGRESS_PING_MS = 10_000;

// A stream holds an open socket and a repeating timer, so bound both dimensions.
// The cap is per-process and deliberately generous: one page holds exactly one
// stream and closes it as soon as its POST settles, so reaching this means
// something is looping, not that a user has too many tabs open.
const PROGRESS_MAX_STREAMS = 32;

// Absolute lifetime for a single stream. A client that vanishes without closing
// the socket (crashed tab, network dropped with no FIN) would otherwise hold its
// timer until the process restarts. A browser EventSource simply reconnects
// (`retry: 2000` below) and picks the job's state back up, so a genuinely
// long-running Whisper job is unaffected by being cut here.
const PROGRESS_MAX_STREAM_MS = 30 * 60_000;

let openProgressStreams = 0;

// SSE: stream a job's Whisper progress to the browser until it reaches a terminal
// status. No job entry yet → heartbeats (the POST may not have hit its first
// progress tick). blockInWeb because Whisper never runs in web mode — POST
// /api/transcript ignores `jobId` there and forces transcription off, so this
// route could only ever heartbeat at a hosted visitor, while still costing a
// socket and a timer per connection. Gating it removes that sink outright.
app.get('/api/transcript/progress', blockInWeb, (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) { res.status(400).end(); return; }

  if (openProgressStreams >= PROGRESS_MAX_STREAMS) {
    return sendError(
      res,
      'RATE_LIMITED',
      'Too many progress streams are already open.',
      'Close some Echo tabs, or wait for the running transcriptions to finish.'
    );
  }
  openProgressStreams++;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let done = false;
  let sinceLastPing = 0;

  // Single teardown path for every exit (terminal status, lifetime cap, client
  // disconnect), so the open-stream count can never drift. Idempotent: res.end()
  // re-enters this via the 'close' listener below.
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(iv);
    clearTimeout(maxTimer);
    openProgressStreams--;
    res.end();
  };

  const tick = () => {
    if (done) return;
    const st = whisperJobs.get(jobId);
    if (!st) {
      sinceLastPing += PROGRESS_POLL_MS;
      if (sinceLastPing >= PROGRESS_PING_MS) {
        sinceLastPing = 0;
        res.write(': ping\n\n');
      }
      return;
    }
    sinceLastPing = 0;
    res.write(`data: ${JSON.stringify({ phase: st.phase, pct: st.pct ?? 0, status: st.status || 'running' })}\n\n`);
    if (st.status && st.status !== 'running') finish();
  };

  const iv = setInterval(tick, PROGRESS_POLL_MS);
  const maxTimer = setTimeout(finish, PROGRESS_MAX_STREAM_MS);
  tick();

  // Listen on `res`, not `req`: for a GET there is no request body whose end
  // could be confused with a disconnect, and res 'close' is the signal that
  // covers both a vanished client and our own res.end().
  res.on('close', finish);
});

app.post('/api/transcript', webLimit(20, 60_000), async (req, res) => {
  const { url, lang, transcribe, whisperModel } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }

  // Cancel the (potentially long, CPU-heavy) transcription if the client goes
  // away — e.g. the user closes the tab or navigates off. Without this, the
  // yt-dlp audio download and the whisper-cli process keep running to
  // completion server-side, pinning the CPU long after nobody is waiting.
  // NB: listen on `res`, not `req` — req 'close' fires as soon as the POST
  // body is consumed, which would abort the job the instant it started.
  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  // Optional live-progress channel: the client sends a jobId and subscribes to
  // GET /api/transcript/progress?jobId=… . Only meaningful when Whisper runs.
  const jobId = (!isWeb && typeof req.body.jobId === 'string' && req.body.jobId) ? req.body.jobId : null;
  // First entry is created by the first real progress tick (only when Whisper
  // actually runs) — so caption-only fetches never flash a progress card.
  const onProgress = jobId
    ? ({ phase, pct }) => setJobProgress(jobId, { phase, pct, status: 'running' })
    : undefined;

  const t0 = Date.now();
  try {
    // Whisper is local/desktop only; force it off in web mode regardless of the body.
    const whisperMode = isWeb ? 'off' : (transcribe || 'fallback');
    const segments = await fetchTranscript(videoId, { lang, transcribe: whisperMode, modelName: whisperModel, signal: ac.signal, onProgress });
    const { title, channel, channelUrl } = await getVideoMeta(videoId);
    // `langUsed` is stamped onto the segments array by fetchTranscript() and
    // reflects the caption track actually loaded (not just what was asked
    // for) — the language picker uses this to pre-select the right option.
    const langCode = segments.langUsed || lang || null;

    if (isWeb) {
      const totalChars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
      if (totalChars > ECHO_MAX_TRANSCRIPT_CHARS) {
        return sendError(
          res,
          'TRANSCRIPT_UNAVAILABLE',
          `Transcript is too long (${totalChars} characters, limit is ${ECHO_MAX_TRANSCRIPT_CHARS}).`,
          'This hosted instance caps transcript length. Try a shorter video, or run Echo locally for unlimited length.'
        );
      }
    }

    const chars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
    logEvent('transcript', { videoId, chars, langCode, ok: true, ms: Date.now() - t0 });
    finishJob(jobId, 'done');
    const transcriptSource = segments.source || 'captions';
    return res.json({ videoId, url: req.body.url, title, channel, channelUrl, segments, langCode, transcriptSource });
  } catch (err) {
    // Client already disconnected — the abort we triggered surfaces here; there
    // is no live response to write to, so just record it and stop.
    if (clientGone) {
      logEvent('transcript', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return;
    }
    logEvent('transcript', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    finishJob(jobId, 'error');
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Local media transcription (local/desktop only)
// ---------------------------------------------------------------------------
// The same Whisper stage the YouTube path uses, pointed at a file the user
// supplies: a podcast download, a lecture recording, a meeting capture. This is
// the one route that isn't about YouTube at all.
//
// The body is the raw file bytes rather than multipart/form-data, which is why
// there is no upload dependency here: the browser can `fetch(url, {body: file})`
// a File object directly, and express.raw() hands us a Buffer. The filename
// rides in a query param because a raw body has nowhere else to put it.

// Cap on an uploaded file. Generous — an hour of lecture video is easily 500 MB
// — but bounded, since this writes to the machine's temp dir.
const ECHO_MAX_UPLOAD_BYTES = numFromEnv('ECHO_MAX_UPLOAD_BYTES', 2_000_000_000, { min: 1 });

/**
 * Synthetic, stable id for a local file so it can live in the same library as
 * YouTube entries without a schema change. Derived from name + size + content
 * length so re-uploading the same file updates its entry instead of duplicating
 * it. Shaped to satisfy vault.js's `^[A-Za-z0-9_-]{1,20}$` filename guard.
 *
 * @param {string} name
 * @param {Buffer} buf
 * @returns {string}
 */
function localMediaId(name, buf) {
  const hash = createHash('sha256')
    .update(String(name || ''))
    .update(String(buf.length))
    // Hash a bounded slice, not the whole file: a 500 MB hash costs seconds and
    // buys nothing here — name + size + head + tail is plenty to tell two
    // uploads apart.
    .update(buf.subarray(0, 1 << 20))
    .update(buf.subarray(Math.max(0, buf.length - (1 << 20))))
    .digest('hex');
  return `file_${hash.slice(0, 14)}`;
}

app.post(
  '/api/transcript/file',
  blockInWeb,
  express.raw({ type: '*/*', limit: ECHO_MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const rawName = typeof req.query.name === 'string' ? req.query.name : '';
    // Only ever used as a display title and as hash input — never as a path.
    const displayName = rawName.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || 'Untitled recording';
    const ext = (displayName.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return sendError(res, 'INTERNAL', 'No file was uploaded.', 'Choose an audio or video file.', 400);
    }
    if (ext && !LOCAL_MEDIA_EXTENSIONS.has(ext)) {
      return sendError(
        res,
        'INTERNAL',
        `Unsupported file type: ${ext}`,
        'Echo reads audio and video files — mp3, m4a, wav, flac, ogg, mp4, mov, mkv, webm and similar.',
        400
      );
    }

    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) { clientGone = true; ac.abort(); }
    });

    const jobId = (typeof req.query.jobId === 'string' && req.query.jobId) ? req.query.jobId : null;
    const onProgress = jobId
      ? ({ phase, pct }) => setJobProgress(jobId, { phase, pct, status: 'running' })
      : undefined;

    const t0 = Date.now();
    const videoId = localMediaId(displayName, req.body);
    // Written to the OS temp dir under a generated name, never under anything
    // derived from the upload's own filename.
    const tmpPath = join(tmpdir(), `echo-upload-${videoId}${ext}`);

    try {
      await writeFile(tmpPath, req.body);
      const segments = await transcribeFile(tmpPath, {
        modelName: typeof req.query.whisperModel === 'string' ? req.query.whisperModel : undefined,
        signal: ac.signal,
        onProgress,
      });

      const chars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
      logEvent('transcript-file', { videoId, chars, bytes: req.body.length, ok: true, ms: Date.now() - t0 });
      finishJob(jobId, 'done');

      // Same envelope the YouTube path returns, so the frontend renders it with
      // the same code. `url` is empty: there is nowhere to link back to.
      return res.json({
        videoId,
        url: '',
        title: displayName.replace(/\.[A-Za-z0-9]+$/, ''),
        channel: null,
        channelUrl: null,
        segments,
        langCode: segments.langUsed || null,
        transcriptSource: 'whisper',
        localFile: true,
      });
    } catch (err) {
      if (clientGone) {
        logEvent('transcript-file', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
        finishJob(jobId, 'error');
        return;
      }
      logEvent('transcript-file', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return sendCaughtError(res, err);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }
);

// --- Whisper model management (local/desktop only) ---
app.get('/api/whisper/status', blockInWeb, (req, res) => {
  const binaryPresent = !!resolveWhisperBinary();
  const models = Object.keys(WHISPER_MODELS).map((n) => {
    const m = WHISPER_MODELS[n];
    return { name: m.name, label: m.label, sizeBytes: m.sizeBytes, ...downloadState(n) };
  });
  return res.json({ binaryPresent, defaultModel: DEFAULT_WHISPER_MODEL, cacheDir: modelCacheDir(), models });
});

app.post('/api/whisper/model', blockInWeb, (req, res) => {
  const { model } = req.body || {};
  if (!model || !WHISPER_MODELS[model]) {
    return sendError(res, 'WHISPER_MODEL_UNKNOWN', `Unknown model: ${model}`, 'Choose base or small.');
  }
  try {
    startModelDownload(model);
    return res.json(downloadState(model));
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

app.get('/api/languages', webLimit(20, 60_000), async (req, res) => {
  const { videoId: rawId } = req.query;
  if (!rawId) {
    return sendError(res, 'INTERNAL', 'videoId query parameter is required.', '', 400);
  }
  const videoId = extractVideoId(rawId);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }
  try {
    const tracks = await listCaptionTracks(videoId);
    return res.json({ tracks });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Video meta (lightweight, keyless oEmbed lookup — used to backfill channel
// info on saved library entries created before channelUrl was stored)
// ---------------------------------------------------------------------------

app.get('/api/video-meta', webLimit(20, 60_000), async (req, res) => {
  const { videoId: rawId, url: rawUrl } = req.query;
  const videoId = extractVideoId(rawId || rawUrl);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }
  try {
    const { title, channel, channelUrl } = await getVideoMeta(videoId);
    return res.json({ videoId, title, channel, channelUrl });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

// Auto-tagging must never delay or break the digest response. It runs in
// parallel with generateDigest() (on the raw transcript text, same input the
// digest itself reads, so there's no extra serialization cost) under its own
// try/catch + bounded timeout — any failure, timeout, or missing tags just
// resolves to an empty array. See CLAUDE.md "never break the digest path".
const AUTO_TAG_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function suggestTagsBestEffort(text, { apiKey, language, videoId } = {}) {
  const t0 = Date.now();
  try {
    const result = await withTimeout(suggestTags(text, { apiKey, language }), AUTO_TAG_TIMEOUT_MS);
    logEvent('tags-suggest', {
      videoId: videoId || null,
      chars: (text || '').length,
      tagCount: Array.isArray(result.tags) ? result.tags.length : 0,
      costUsd: result.usage && result.usage.costUsd,
      ok: true, ms: Date.now() - t0,
    });
    return Array.isArray(result.tags) ? result.tags : [];
  } catch (err) {
    logEvent('tags-suggest', { videoId: videoId || null, chars: (text || '').length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return [];
  }
}

app.post('/api/digest', webLimit(20, 60_000), async (req, res) => {
  const { text, length, format, language, title, videoId } = req.body;

  if (!requireText(res, text, 'No transcript text provided.', 'Load a transcript before generating a digest.')) return;

  if (rejectOversizeAiPayload(res, { text })) return;
  if (requireWebKey(req, res)) return;

  const t0 = Date.now();
  const apiKey = readApiKey(req);
  try {
    const [result, suggestedTags] = await Promise.all([
      generateDigest(text, { length, format, language, title, apiKey }),
      suggestTagsBestEffort(text, { apiKey, language, videoId }),
    ]);
    logEvent('digest', {
      videoId: videoId || null,
      chars: (text || '').length,
      length, format, language,
      strategy: result.strategy,
      model: 'sonnet',
      costUsd: result.usage && result.usage.costUsd,
      tokIn: result.usage && result.usage.inputTokens,
      tokOut: result.usage && result.usage.outputTokens,
      ok: true, ms: Date.now() - t0,
    });
    return res.json({ ...result, suggestedTags });
  } catch (err) {
    logEvent('digest', { videoId: videoId || null, chars: (text || '').length, length, format, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Enrich (explain / background a highlighted selection)
// ---------------------------------------------------------------------------

app.post('/api/enrich', webLimit(20, 60_000), async (req, res) => {
  const { selection, context, mode, language, videoId } = req.body;
  if (!requireText(res, selection, 'selection is required.')) return;
  if (rejectOversizeAiPayload(res, { text: (selection || '') + (context || '') })) return;
  if (requireWebKey(req, res)) return;
  const t0 = Date.now();
  try {
    const result = await enrich(selection, { context, mode, language, apiKey: readApiKey(req) });
    logEvent('enrich', {
      videoId: videoId || null,
      mode: result.mode || mode,
      selLen: (selection || '').length,
      results: result.results,
      sources: Array.isArray(result.sources) ? result.sources.length : 0,
      grounded: result.results == null ? undefined : result.results > 0,
      verdict: result.verdict,
      costUsd: result.usage && result.usage.costUsd,
      ok: true, ms: Date.now() - t0,
    });
    return res.json(result);
  } catch (err) {
    logEvent('enrich', { videoId: videoId || null, mode: mode || 'explain', selLen: (selection || '').length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Key validation (web mode only)
// ---------------------------------------------------------------------------
// Lets the Settings UI validate a candidate Anthropic API key immediately
// (via a cheap, token-free models.list() call) instead of the user only
// finding out it's invalid on their first AI call.

app.post('/api/validate-key', webLimit(20, 60_000), async (req, res) => {
  if (!isWeb && !isDesktop) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Key validation is only available when using your own API key (web or desktop mode).',
      ''
    );
  }

  const apiKey = readApiKey(req);
  if (!apiKey) {
    return sendError(res, 'API_NOT_AUTHED', 'No API key provided.', 'Enter your Anthropic API key.');
  }

  try {
    const result = await validateApiKey(apiKey);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Accounts + library sync (web mode only, and only when configured)
// ---------------------------------------------------------------------------
// Sign in with Google so a library follows you between devices. Everything here
// is off unless all three env vars below are set, so a deployment that does not
// want accounts gets exactly today's behaviour and never creates a database.
//
// What is NOT here, on purpose: no password storage, no sessions table, no
// refresh tokens, and no API keys. Signing in does not change where an
// Anthropic key lives — it stays in the browser and rides per-request in
// X-Echo-Api-Key, so the promise that the server never sees a key survives
// accounts intact.

const GOOGLE_CLIENT_ID = process.env.ECHO_GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.ECHO_GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.ECHO_SESSION_SECRET || '';
const SYNC_DB_PATH = process.env.ECHO_SYNC_DB_PATH || '/data/echo-sync.db';

// Public origin, needed to build the OAuth redirect_uri Google will match
// against its allow-list. Falls back to the request's own origin.
const PUBLIC_URL = (process.env.ECHO_PUBLIC_URL || '').replace(/\/+$/, '');

const AUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && SESSION_SECRET);

// Per-user storage ceiling. A synced library is transcripts, which are text but
// not small; this keeps one account from filling the volume.
const ECHO_MAX_SYNC_BYTES = numFromEnv('ECHO_MAX_SYNC_BYTES', 100_000_000, { min: 1 });

if (AUTH_ENABLED) openSyncDb(SYNC_DB_PATH);

function redirectUri(req) {
  const origin = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/auth/callback`;
}

/** Blocks a route unless accounts are configured. */
function requireAuthConfigured(req, res, next) {
  if (!AUTH_ENABLED) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Accounts are not enabled on this instance.',
      'Your library is stored in this browser. Set ECHO_GOOGLE_CLIENT_ID, ECHO_GOOGLE_CLIENT_SECRET and ECHO_SESSION_SECRET to enable sign-in.'
    );
  }
  next();
}

/**
 * The signed-in user id, or null.
 *
 * The signature proves the cookie is ours and unexpired; `tv` then proves it
 * has not been revoked. Without that second check a stateless session cannot
 * be ended early — which is the whole cost of having no sessions table, and
 * one integer buys it back.
 */
function sessionUserId(req) {
  if (!AUTH_ENABLED) return null;
  const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
  const payload = verifyToken(token, SESSION_SECRET);
  if (!payload || !payload.uid) return null;

  const user = getUser(String(payload.uid));
  if (!user) return null;
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) return null;
  return user.id;
}

/** Guards the sync routes: 401 rather than silently syncing nothing. */
function requireSession(req, res, next) {
  const uid = sessionUserId(req);
  if (!uid) {
    return sendError(res, 'API_NOT_AUTHED', 'Sign in to sync your library.', 'Sign in with Google to use sync.', 401);
  }
  req.echoUserId = uid;
  next();
}

app.get('/api/auth/google', requireAuthConfigured, (req, res) => {
  const state = randomToken();
  const verifier = randomToken();

  // state + PKCE verifier ride in a short-lived signed cookie rather than in
  // server memory, so sign-in survives a restart and needs no shared store if
  // the deployment ever runs more than one machine.
  const tx = signToken({ state, verifier, exp: Date.now() + OAUTH_TTL_MS }, SESSION_SECRET);
  res.set('Set-Cookie', serializeCookie(OAUTH_COOKIE, tx, { maxAgeMs: OAUTH_TTL_MS, secure: isWeb }));

  return res.redirect(buildGoogleAuthUrl({
    clientId: GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(req),
    state,
    codeChallenge: pkceChallenge(verifier),
  }));
});

app.get('/api/auth/callback', requireAuthConfigured, async (req, res) => {
  const fail = (why) => {
    console.error(`[echo] sign-in failed: ${why}`);
    // Back to the app with a flag rather than a bare error page — the UI can
    // say "sign-in didn't complete" in its own voice.
    res.set('Set-Cookie', serializeCookie(OAUTH_COOKIE, '', { maxAgeMs: 0, secure: isWeb }));
    return res.redirect('/?signin=failed');
  };

  const tx = verifyToken(parseCookies(req.get('cookie'))[OAUTH_COOKIE], SESSION_SECRET);
  if (!tx) return fail('missing or expired transaction cookie');
  // CSRF: the state we handed Google must be the state coming back.
  if (!req.query.state || req.query.state !== tx.state) return fail('state mismatch');
  if (!req.query.code) return fail(`no code (${req.query.error || 'unknown'})`);

  try {
    const tokens = await exchangeCode({
      code: String(req.query.code),
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(req),
      codeVerifier: tx.verifier,
    });

    const payload = decodeIdToken(tokens.id_token);
    const check = validateIdTokenPayload(payload, GOOGLE_CLIENT_ID);
    if (!check.ok) return fail(`id token rejected (${check.reason})`);

    const user = upsertUser({ sub: check.sub, email: check.email });
    const session = signToken({
      uid: user.id,
      tv: user.tokenVersion || 0,
      exp: Date.now() + SESSION_TTL_MS,
    }, SESSION_SECRET);

    res.set('Set-Cookie', [
      serializeCookie(SESSION_COOKIE, session, { maxAgeMs: SESSION_TTL_MS, secure: isWeb }),
      serializeCookie(OAUTH_COOKIE, '', { maxAgeMs: 0, secure: isWeb }),
    ]);
    logEvent('signin', { ok: true });
    return res.redirect('/?signin=ok');
  } catch (err) {
    return fail(err.message);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ enabled: false, user: null });
  const uid = sessionUserId(req);
  if (!uid) return res.json({ enabled: true, user: null });
  const user = getUser(uid);
  return res.json({ enabled: true, user: user ? { email: user.email } : null });
});

app.post('/api/auth/logout', (req, res) => {
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: isWeb }));
  return res.json({ ok: true });
});

app.post('/api/auth/signout-everywhere', requireAuthConfigured, requireSession, (req, res) => {
  // Every session for this account, on every device, stops working now.
  bumpTokenVersion(req.echoUserId);
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: isWeb }));
  logEvent('signout-all', { ok: true });
  return res.json({ ok: true });
});

app.delete('/api/auth/account', requireAuthConfigured, requireSession, (req, res) => {
  // Deleting the account deletes the synced library with it (ON DELETE
  // CASCADE). The browser's own copy is untouched — this removes what the
  // server holds, which is the only thing the user is asking about.
  deleteUser(req.echoUserId);
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: isWeb }));
  return res.json({ ok: true });
});

app.get('/api/sync/pull', requireAuthConfigured, requireSession, webLimit(60, 60_000), (req, res) => {
  try {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    return res.json(pullEntries(req.echoUserId, since));
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

app.post('/api/sync/push', requireAuthConfigured, requireSession, webLimit(60, 60_000), (req, res) => {
  const entries = req.body && req.body.entries;
  if (!Array.isArray(entries)) {
    return sendError(res, 'INTERNAL', 'entries must be an array.', '', 400);
  }
  try {
    if (userBytes(req.echoUserId) > ECHO_MAX_SYNC_BYTES) {
      return sendError(
        res,
        'TRANSCRIPT_UNAVAILABLE',
        'Your synced library has reached this instance\'s storage limit.',
        'Delete some saved videos, or export and remove older ones.',
        413
      );
    }
    const result = pushEntries(req.echoUserId, entries);
    logEvent('sync-push', { applied: result.applied, skipped: result.skipped, ok: true });
    return res.json({ ...result, serverTime: new Date().toISOString() });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Library / saved routes
// ---------------------------------------------------------------------------

// IMPORTANT: /api/saved/export must be defined BEFORE /api/saved/:videoId
// so Express does not capture "export" as a videoId parameter.

app.get('/api/saved', blockInWeb, async (_req, res) => {
  try {
    res.json(await listEntries());
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/export', blockInWeb, async (_req, res) => {
  try {
    const meta = await listEntries();
    const entries = await Promise.all(meta.map((m) => getEntry(m.videoId)));
    res.json({ entries: entries.filter(Boolean) });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

// Sub-routes for a saved entry — all before the bare /:videoId GET/DELETE

app.patch('/api/saved/:videoId/tags', blockInWeb, async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return sendError(res, 'INTERNAL', 'tags must be an array.', '', 400);
    }
    const entry = await setTags(req.params.videoId, tags);
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(entry);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/:videoId', blockInWeb, async (req, res) => {
  try {
    const e = await getEntry(req.params.videoId);
    if (!e) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(e);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/:videoId/export.md', blockInWeb, async (req, res) => {
  try {
    const entry = await getEntry(req.params.videoId);
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);

    const transcriptParam = req.query.transcript;
    const includeTranscript = !(transcriptParam === '0' || transcriptParam === 'false');

    const md = entryToMarkdown(entry, { includeTranscript });
    const slug = (entry.title || 'echo-entry').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'echo-entry';

    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${slug}.md"`);
    res.send(md);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

/**
 * POST /api/vault/sync
 * Writes the full saved library to a folder on disk as one Markdown file
 * per entry (Obsidian-friendly). Blocked in web mode — hosted instances
 * have no writable/durable filesystem to sync into; the frontend there
 * should use the existing ZIP export instead.
 * Body: { dir?: string, includeTranscript?: boolean }
 */
app.post('/api/vault/sync', blockInWeb, async (req, res) => {
  const { dir, includeTranscript } = req.body || {};
  const resolvedDir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : process.env.ECHO_VAULT_DIR;

  if (!resolvedDir) {
    return sendError(
      res,
      'INVALID_URL',
      'No vault folder configured.',
      'Choose a folder in Settings, or set ECHO_VAULT_DIR.',
      400
    );
  }

  const t0 = Date.now();
  try {
    const result = await syncVault(resolvedDir, { includeTranscript });
    logEvent('vault-sync', {
      total: result.total, written: result.written, unchanged: result.unchanged, failed: result.failed,
      ok: true, ms: Date.now() - t0,
    });
    res.json(result);
  } catch (err) {
    logEvent('vault-sync', { ok: false, err: errLabel(err), ms: Date.now() - t0 });
    sendCaughtError(res, err);
  }
});

app.post('/api/saved', blockInWeb, async (req, res) => {
  const t0 = Date.now();
  try {
    const { url, videoId, title, segments, digest, channel, channelUrl, transcriptSource, whisperModel } = req.body;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return sendError(res, 'INTERNAL', 'videoId and segments are required.', '', 400);
    }
    const meta = await saveEntry({ url, videoId, title, segments, digest, channel, channelUrl, transcriptSource, whisperModel });
    logEvent('save', { videoId, hadDigest: Boolean(digest), ok: true, ms: Date.now() - t0 });
    res.json(meta);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId', blockInWeb, async (req, res) => {
  const t0 = Date.now();
  try {
    const ok = await deleteEntry(req.params.videoId);
    if (!ok) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    logEvent('unsave', { videoId: req.params.videoId, ok: true, ms: Date.now() - t0 });
    res.json({ ok: true });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/**
 * Extract a ~200-char snippet from an entry that contains one of the query words.
 * Falls back to the beginning of the transcript or digest if no direct match is found.
 * @param {{ segments?: Array<{text:string}>, digest?: string }} entry
 * @param {string} query
 * @returns {string}
 */
function buildSnippet(entry, query) {
  const words  = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const segTxt = Array.isArray(entry.segments)
    ? entry.segments.map((s) => String(s.text || '')).join(' ')
    : '';
  const text   = segTxt || entry.digest || '';
  if (!text) return '';

  const ltext = text.toLowerCase();
  for (const word of words) {
    const idx = ltext.indexOf(word);
    if (idx !== -1) {
      const start = Math.max(0, idx - 80);
      const end   = Math.min(text.length, idx + word.length + 160);
      const pre   = start > 0 ? '…' : '';
      const post  = end < text.length ? '…' : '';
      return pre + text.slice(start, end).replace(/\s+/g, ' ').trim() + post;
    }
  }
  // No direct word hit — return lead of text
  return text.slice(0, 240).replace(/\s+/g, ' ').trim() + (text.length > 240 ? '…' : '');
}

// ---------------------------------------------------------------------------
// Search route
// ---------------------------------------------------------------------------

/**
 * GET /api/search?q=...&limit=...
 * FTS5 keyword search.
 * Response shape is always { results: [...], mode: 'keyword' }.
 * Each result: { videoId, title, url, snippet, tags, favorite }.
 */
app.get('/api/search', blockInWeb, async (req, res) => {
  const q     = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const t0 = Date.now();

  if (!q) return res.json({ results: [], mode: 'keyword' });

  try {
    const ftsEntries = await searchLibrary(q, limit);

    /** Map a full entry to the slim search-result shape */
    const toResult = (entry) => ({
      videoId:  entry.videoId,
      title:    entry.title,
      url:      entry.url,
      snippet:  buildSnippet(entry, q),
      tags:     Array.isArray(entry.tags) ? entry.tags : [],
      favorite: Boolean(entry.favorite),
    });

    const results = ftsEntries.slice(0, limit).map(toResult);
    logEvent('search', { qLen: q.length, mode: 'keyword', results: results.length, ok: true, ms: Date.now() - t0 });
    return res.json({ results, mode: 'keyword' });
  } catch (err) {
    logEvent('search', { qLen: q.length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Body-parser and last-resort error handling
// ---------------------------------------------------------------------------
// Registered after every route, which is what makes Express treat it as error
// middleware. Without it, express.json() rejecting an oversize or malformed
// body produced Express's own HTML error page rather than the structured
// envelope every client here knows how to read — so a client hitting the size
// limit got an unparseable response and reported a generic failure.
//
// The four-argument signature is load-bearing: drop `next` and Express
// registers this as ordinary middleware and never routes errors to it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.too.large') {
    return sendError(
      res,
      'TRANSCRIPT_UNAVAILABLE',
      'That request is too large.',
      'Echo sends large libraries in batches — if you are seeing this, try syncing again.',
      413
    );
  }

  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendError(res, 'INTERNAL', 'That request body was not valid JSON.', '', 400);
  }

  return sendCaughtError(res, err);
});

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const server = app.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Listening on http://${displayHost}:${PORT} (bound to ${HOST})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${PORT} is already in use (host ${HOST}).`);
      console.error(`Another instance may still be running. Stop it, or start on a different port with:  PORT=<free-port> node server.js`);
      process.exit(1);
    }
    throw err;
  });
}

export { app, rateLimitHit, buildConfigScript, localMediaId, ECHO_MODE, isWeb, isDesktop, ECHO_ERROR_STATUS };
