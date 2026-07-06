import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync } from 'fs';
import {
  extractVideoId,
  extractPlaylistId,
  fetchTranscript,
  getVideoTitle,
  listCaptionTracks,
  extractPlaylist,
} from './transcript.js';
import {
  listEntries,
  getEntry,
  saveEntry,
  deleteEntry,
  setTags,
  searchLibrary,
} from './store.js';
import { entryToMarkdown } from './markdown.js';
import { startPlaylistDigest, getJob, cancelJob } from './playlistJob.js';
import {
  generateDigest,
  askVideoQuestion,
  generateCrossDigest,
  enrich,
} from './digest.js';
import { getTodayUsage } from './usage.js';
import { logEvent, errLabel } from './usagelog.js';
import { searchVideos, forYou } from './discovery.js';
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
// The frontend is a single inline public/index.html with inline <script>/
// <style> blocks (no build step / no nonces), so the CSP below intentionally
// allows 'unsafe-inline' for script-src and style-src — a known limitation
// of the inline monolith. It still blocks framing, MIME-sniffing, and
// restricts network/asset origins to what the app actually uses (self, the
// JSZip CDN, and Google Fonts).
const CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
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
function buildInjectedHtml(rawHtml, mode) {
  const injected = { mode };
  const script = `<script>window.__ECHO__=${JSON.stringify(injected)}</script>\n</head>`;
  return rawHtml.replace('</head>', script);
}

const INDEX_HTML_PATH = join(__dirname, 'public', 'index.html');
const CACHED_INDEX_HTML = buildInjectedHtml(readFileSync(INDEX_HTML_PATH, 'utf8'), ECHO_MODE);

app.get('/', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(CACHED_INDEX_HTML);
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
  RATE_LIMITED:           429,
  INTERNAL:               500,
  API_NOT_AUTHED:         401,
  API_RATE_LIMITED:       429,
  API_FAILED:             502,
  WEB_MODE_UNSUPPORTED:   503,
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
 */
function sendError(res, code, message, hint = '', status = null) {
  console.error(`[echo] ${code}: ${message}`);
  const httpStatus = status ?? ECHO_ERROR_STATUS[code] ?? 500;
  return res.status(httpStatus).json({ error: { code, message, hint } });
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
    return sendError(res, code, err.message, err.hint || '');
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

app.post('/api/transcript', webLimit(20, 60_000), async (req, res) => {
  const { url, lang } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }

  const t0 = Date.now();
  try {
    const segments = await fetchTranscript(videoId, { lang });
    const title = await getVideoTitle(videoId);
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
    return res.json({ videoId, url: req.body.url, title, segments, langCode });
  } catch (err) {
    logEvent('transcript', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
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
// Playlist
// ---------------------------------------------------------------------------

app.post('/api/playlist', webLimit(20, 60_000), async (req, res) => {
  // Playlist enumeration spawns yt-dlp per request and can be used to fan out
  // many downstream requests from a single anonymous call — too expensive to
  // expose to anonymous web traffic. Disabled entirely in web mode; unchanged
  // in local/desktop mode.
  if (isWeb) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      "Playlist processing isn't available in hosted mode.",
      'Paste a single video link instead.'
    );
  }

  const { url } = req.body;
  if (!url) {
    return sendError(res, 'INTERNAL', 'url is required.', '', 400);
  }
  try {
    const result = await extractPlaylist(url);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Batch playlist digest
// ---------------------------------------------------------------------------

app.post('/api/playlist/digest', (req, res) => {
  // Batch playlist digest is the heaviest endpoint (many long-running Claude
  // calls per request) — too expensive to expose to anonymous web traffic.
  // Disabled entirely in web mode; unchanged in local/desktop mode.
  if (isWeb) {
    return sendError(
      res,
      'INTERNAL',
      'Batch playlist digest is not available on this hosted instance.',
      'Run Echo locally or via the desktop app to use batch playlist digests.',
      503
    );
  }

  const { url, length, format, language, lang, skipExisting } = req.body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return sendError(res, 'INVALID_URL', 'A playlist URL is required.', '', 400);
  }
  const t0 = Date.now();
  try {
    const { jobId } = startPlaylistDigest(url, { length, format, language, lang, skipExisting });
    logEvent('playlist-digest', { ok: true, ms: Date.now() - t0 });
    return res.status(202).json({ jobId });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

app.get('/api/playlist/digest/status', (req, res) => {
  const { jobId } = req.query;
  const job = getJob(jobId);
  if (!job) {
    return sendError(res, 'INTERNAL', 'Job not found.', '', 404);
  }
  return res.json(job);
});

app.post('/api/playlist/digest/cancel', (req, res) => {
  const { jobId } = req.body;
  const ok = cancelJob(jobId);
  return res.json({ cancelled: ok });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

app.post('/api/digest', webLimit(20, 60_000), async (req, res) => {
  const { text, length, format, language, title, videoId } = req.body;

  if (!requireText(res, text, 'No transcript text provided.', 'Load a transcript before generating a digest.')) return;

  if (rejectOversizeAiPayload(res, { text })) return;
  if (requireWebKey(req, res)) return;

  const t0 = Date.now();
  try {
    const result = await generateDigest(text, { length, format, language, title, apiKey: readApiKey(req) });
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
    return res.json(result);
  } catch (err) {
    logEvent('digest', { videoId: videoId || null, chars: (text || '').length, length, format, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Chat / Ask
// ---------------------------------------------------------------------------

app.post('/api/chat', webLimit(20, 60_000), async (req, res) => {
  const { text, question, language, lang, langCode, videoId } = req.body;
  if (!requireText(res, text, 'text is required.')) return;
  if (!requireText(res, question, 'question is required.')) return;
  if (rejectOversizeAiPayload(res, { text })) return;
  if (requireWebKey(req, res)) return;
  const t0 = Date.now();
  try {
    const answerLanguage = language || lang || langCode || undefined;
    const result = await askVideoQuestion(text, question, { apiKey: readApiKey(req), language: answerLanguage });
    logEvent('ask', {
      videoId: videoId || null,
      chars: (text || '').length,
      qLen: (question || '').length,
      costUsd: result.usage && result.usage.costUsd,
      ok: true, ms: Date.now() - t0,
    });
    return res.json(result);
  } catch (err) {
    logEvent('ask', { videoId: videoId || null, qLen: (question || '').length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Enrich (explain / background / factcheck a highlighted selection)
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
// Usage
// ---------------------------------------------------------------------------

app.get('/api/usage', blockInWeb, async (req, res) => {
  try {
    const usage = await getTodayUsage();
    return res.json(usage);
  } catch (err) {
    return res.json({ available: false, error: String(err) });
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

app.post('/api/saved', blockInWeb, async (req, res) => {
  const t0 = Date.now();
  try {
    const { url, videoId, title, segments, digest } = req.body;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return sendError(res, 'INTERNAL', 'videoId and segments are required.', '', 400);
    }
    const meta = await saveEntry({ url, videoId, title, segments, digest });
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
// Cross-digest
// ---------------------------------------------------------------------------

app.post('/api/cross-digest', webLimit(20, 60_000), async (req, res) => {
  const { videoIds, options } = req.body;

  // Web mode: the browser holds the library client-side (no server store of
  // record), so the caller may pass full entry objects directly in the body.
  // Local mode ignores req.body.entries entirely and always resolves via the
  // server-side store — behavior here is unchanged from before this feature.
  const useInlineEntries = isWeb && Array.isArray(req.body.entries) && req.body.entries.length > 0;

  let entries;

  if (useInlineEntries) {
    entries = req.body.entries;
    if (entries.length < 2) {
      return sendError(
        res,
        'INTERNAL',
        'At least 2 entries are required for a cross-digest.',
        'Select 2 or more saved videos to compare.',
        400
      );
    }
    // Same oversize guard as the videoIds branch below — the inline-entries
    // branch previously skipped this check entirely.
    const inlineText = entries
      .map((e) => (e && e.digest) || (Array.isArray(e && e.segments) ? e.segments.map((s) => s.text || '').join(' ') : ''))
      .join(' ');
    if (rejectOversizeAiPayload(res, { text: inlineText })) return;
  } else {
    if (!Array.isArray(videoIds) || videoIds.length < 2) {
      return sendError(
        res,
        'INTERNAL',
        'At least 2 video IDs are required for a cross-digest.',
        'Select 2 or more saved videos to compare.',
        400
      );
    }

    // Resolve all entries up front — fail fast if any ID is missing from the library.
    entries = [];
    for (const videoId of videoIds) {
      const entry = await getEntry(String(videoId));
      if (!entry) {
        return sendError(
          res,
          'INTERNAL',
          `Video "${videoId}" was not found in your library.`,
          'All selected videos must be saved in your library before running a cross-digest.',
          400
        );
      }
      entries.push(entry);
    }
  }

  if (requireWebKey(req, res)) return;

  const t0 = Date.now();
  try {
    const { digest, usage } = await generateCrossDigest(entries, { ...(options || {}), apiKey: readApiKey(req) });
    logEvent('cross-digest', { nVideos: entries.length, costUsd: usage && usage.costUsd, ok: true, ms: Date.now() - t0 });
    return res.json({ digest, stats: usage });
  } catch (err) {
    logEvent('cross-digest', { nVideos: entries.length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
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
// Discovery routes — keyless YouTube search via yt-dlp
// ---------------------------------------------------------------------------

/**
 * GET /api/discovery/search?q=...&n=...
 * Keyless YouTube search (yt-dlp ytsearch). Response: { results: Card[] }.
 */
app.get('/api/discovery/search', blockInWeb, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 20, 1), 40);
  const t0 = Date.now();

  if (!q) return res.json({ results: [] });

  try {
    const results = await searchVideos(q, { n });
    logEvent('discovery-search', { q, n: results.length, ms: Date.now() - t0, ok: true });
    res.json({ results });
  } catch (err) {
    logEvent('discovery-search', { q, ok: false });
    sendCaughtError(res, err);
  }
});

/**
 * GET /api/discovery/foryou
 * "For You" feed derived from the saved library's tags/titles.
 * Response: { results: Card[], basedOn: string[] }.
 */
app.get('/api/discovery/foryou', blockInWeb, async (_req, res) => {
  const t0 = Date.now();
  try {
    const saved = await listEntries();
    const { results, basedOn } = await forYou(saved);
    logEvent('discovery-foryou', { n: results.length, basedOn, ms: Date.now() - t0, ok: true });
    res.json({ results, basedOn });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  app.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Listening on http://${displayHost}:${PORT} (bound to ${HOST})`);
  });
}

export { app, rateLimitHit, buildInjectedHtml, ECHO_MODE, isWeb, isDesktop, ECHO_ERROR_STATUS };
