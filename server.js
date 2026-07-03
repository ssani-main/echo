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
  setFavorite,
  addNote,
  deleteNote,
  setHighlights,
  addHighlight,
  deleteHighlight,
  searchLibrary,
  getEmbedding,
  setEmbedding,
  allEmbeddings,
} from './store.js';
import { entryToMarkdown } from './markdown.js';
import { buildClips } from './clips.js';
import { startPlaylistDigest, getJob, cancelJob } from './playlistJob.js';
import {
  initEmbeddings,
  isAvailable,
  getFailureReason,
  embedText,
  cosineSimilarity,
} from './embeddings.js';

// Start loading embedding model in background — safe to ignore the promise;
// isAvailable() will stay false until (and unless) the load succeeds.
initEmbeddings().catch(() => {});
import {
  generateDigest,
  askVideoQuestion,
  extractChapters,
  extractQuotes,
  factCheck,
  generateCrossDigest,
} from './digest.js';
import { getTodayUsage } from './usage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Mode flag — 'local' (default: npm start, Tauri desktop) vs 'web' (hosted).
// Every web-only branch below is gated on `isWeb` so local/desktop behavior
// stays byte-for-byte identical to today.
// ---------------------------------------------------------------------------
const ECHO_MODE = process.env.ECHO_MODE === 'web' ? 'web' : 'local';
const isWeb = ECHO_MODE === 'web';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

if (isWeb) {
  // Running behind a reverse proxy in web mode — needed for correct req.ip
  // (used by the rate limiter) and secure-cookie detection.
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '5mb' }));

// ---------------------------------------------------------------------------
// Step 1 — inject window.__ECHO__ into index.html
// ---------------------------------------------------------------------------
// index.html is read ONCE at startup and the injected HTML is cached in
// memory, rather than re-reading + re-injecting on every request. Trade-off:
// editing public/index.html during local development requires a server
// restart to pick up changes (it did not before this change).
//
// `embeddings` flag: initEmbeddings() runs in the background (see below) and
// isAvailable() is essentially always false at this synchronous startup
// point, even when the model will successfully load moments later. Reporting
// that here would be misleading, so in local mode we default `embeddings` to
// `true` and let the client's existing GET /api/search/status call determine
// the real state at runtime. In web mode, server-side embeddings are not
// offered at all, so it is always `false`.
function buildInjectedHtml(rawHtml, mode) {
  const isWebMode = mode === 'web';
  const injected = { mode, embeddings: isWebMode ? false : true };
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
// Only honored in web mode. In local mode this always returns undefined, so
// getProvider() falls through to the default ClaudeCliProvider — unchanged.

function readApiKey(req) {
  const k = req.get('X-Echo-Api-Key');
  return (isWeb && k && k.trim()) ? k.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Step 6 — abuse / cost guards (web-gated no-ops in local mode)
// ---------------------------------------------------------------------------

// Max transcript length (characters) accepted in web mode before rejecting.
const ECHO_MAX_TRANSCRIPT_CHARS = process.env.ECHO_MAX_TRANSCRIPT_CHARS
  ? Number(process.env.ECHO_MAX_TRANSCRIPT_CHARS)
  : 200_000;

// Max text/segments payload size (characters) accepted by AI endpoints in web mode.
const ECHO_MAX_AI_PAYLOAD_CHARS = process.env.ECHO_MAX_AI_PAYLOAD_CHARS
  ? Number(process.env.ECHO_MAX_AI_PAYLOAD_CHARS)
  : 200_000;

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
function webLimit(max, windowMs) {
  const store = new Map();
  return (req, res, next) => {
    if (!isWeb) return next();
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

    return res.json({ videoId, url: req.body.url, title, segments, langCode });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

app.get('/api/languages', webLimit(20, 60_000), async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return sendError(res, 'INTERNAL', 'videoId query parameter is required.', '', 400);
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
  try {
    const { jobId } = startPlaylistDigest(url, { length, format, language, lang, skipExisting });
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
  const { text, length, format, language } = req.body;

  if (!requireText(res, text, 'No transcript text provided.', 'Load a transcript before generating a digest.')) return;

  if (rejectOversizeAiPayload(res, { text })) return;

  try {
    const result = await generateDigest(text, { length, format, language, apiKey: readApiKey(req) });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Chat / Ask
// ---------------------------------------------------------------------------

app.post('/api/chat', webLimit(20, 60_000), async (req, res) => {
  const { text, question } = req.body;
  if (!requireText(res, text, 'text is required.')) return;
  if (!requireText(res, question, 'question is required.')) return;
  if (rejectOversizeAiPayload(res, { text })) return;
  try {
    const result = await askVideoQuestion(text, question, { apiKey: readApiKey(req) });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

app.post('/api/chapters', webLimit(20, 60_000), async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return sendError(res, 'INTERNAL', 'segments must be a non-empty array.', '', 400);
  }
  if (rejectOversizeAiPayload(res, { segments })) return;
  try {
    const result = await extractChapters(segments, { apiKey: readApiKey(req) });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

app.post('/api/quotes', webLimit(20, 60_000), async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return sendError(res, 'INTERNAL', 'segments must be a non-empty array.', '', 400);
  }
  if (rejectOversizeAiPayload(res, { segments })) return;
  try {
    const result = await extractQuotes(segments, { apiKey: readApiKey(req) });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Fact-check
// ---------------------------------------------------------------------------

app.post('/api/factcheck', webLimit(20, 60_000), async (req, res) => {
  const { text } = req.body;
  if (!requireText(res, text, 'text is required.')) return;
  if (rejectOversizeAiPayload(res, { text })) return;
  try {
    const result = await factCheck(text, { apiKey: readApiKey(req) });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

app.get('/api/usage', async (req, res) => {
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

app.patch('/api/saved/:videoId/favorite', blockInWeb, async (req, res) => {
  try {
    const { favorite } = req.body;
    if (favorite === undefined || favorite === null) {
      return sendError(res, 'INTERNAL', 'favorite is required.', '', 400);
    }
    const entry = await setFavorite(req.params.videoId, Boolean(favorite));
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(entry);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.post('/api/saved/:videoId/notes', blockInWeb, async (req, res) => {
  try {
    const { text } = req.body;
    if (!requireText(res, text, 'text is required.')) return;
    const note = await addNote(req.params.videoId, text);
    if (note === null) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.status(201).json(note);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId/notes/:noteId', blockInWeb, async (req, res) => {
  try {
    const result = await deleteNote(req.params.videoId, req.params.noteId);
    if (result === null) return sendError(res, 'INTERNAL', 'Entry not found.', '', 404);
    if (result === false) return sendError(res, 'INTERNAL', 'Note not found.', '', 404);
    res.json({ ok: true });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.put('/api/saved/:videoId/highlights', blockInWeb, async (req, res) => {
  try {
    const { highlights } = req.body;
    if (!Array.isArray(highlights)) {
      return sendError(res, 'INTERNAL', 'highlights must be an array.', '', 400);
    }
    const entry = await setHighlights(req.params.videoId, highlights);
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(entry);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.post('/api/saved/:videoId/highlights', blockInWeb, async (req, res) => {
  try {
    const { text, note, color } = req.body;
    let highlight;
    try {
      highlight = await addHighlight(req.params.videoId, { text, note, color });
    } catch (innerErr) {
      // addHighlight throws on empty text
      return sendError(res, 'INTERNAL', innerErr.message, '', 400);
    }
    if (highlight === null) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.status(201).json(highlight);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId/highlights/:highlightId', blockInWeb, async (req, res) => {
  try {
    const result = await deleteHighlight(req.params.videoId, req.params.highlightId);
    if (result === null || result === false) {
      return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    }
    res.json({ ok: true });
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

app.get('/api/clips', blockInWeb, async (req, res) => {
  try {
    const { videoId } = req.query;
    let entries;

    if (videoId) {
      const entry = await getEntry(videoId);
      if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
      entries = [entry];
    } else {
      const meta = await listEntries();
      entries = (await Promise.all(meta.map((m) => getEntry(m.videoId)))).filter(Boolean);
    }

    const clips = buildClips(entries);
    const videoCount = new Set(clips.map((c) => c.videoId)).size;
    res.json({ clips, count: clips.length, videoCount });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.post('/api/saved', blockInWeb, async (req, res) => {
  try {
    const { url, videoId, title, segments, digest } = req.body;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return sendError(res, 'INTERNAL', 'videoId and segments are required.', '', 400);
    }
    const meta = await saveEntry({ url, videoId, title, segments, digest });
    res.json(meta);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId', blockInWeb, async (req, res) => {
  try {
    const ok = await deleteEntry(req.params.videoId);
    if (!ok) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
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

  try {
    const { digest, usage } = await generateCrossDigest(entries, { ...(options || {}), apiKey: readApiKey(req) });
    return res.json({ digest, stats: usage });
  } catch (err) {
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

/**
 * Build the text that represents an entry for embedding purposes:
 * title + first 1000 chars of transcript + first 400 chars of digest.
 * @param {{ title?: string, segments?: Array<{text:string}>, digest?: string }} entry
 * @returns {string}
 */
function buildEmbedText(entry) {
  const title  = entry.title || '';
  const segTxt = Array.isArray(entry.segments)
    ? entry.segments.map((s) => String(s.text || '')).join(' ').slice(0, 1000)
    : '';
  const digest = entry.digest ? entry.digest.slice(0, 400) : '';
  return [title, segTxt, digest].filter(Boolean).join('. ');
}

// ---------------------------------------------------------------------------
// Hybrid / semantic search routes
// ---------------------------------------------------------------------------

/**
 * GET /api/search/status
 * Reports whether the semantic embedding layer is available.
 */
app.get('/api/search/status', (_req, res) => {
  res.json({
    embeddingsAvailable: isAvailable(),
    failureReason:       getFailureReason() ?? null,
    mode:                isAvailable() ? 'hybrid' : 'keyword',
  });
});

/**
 * POST /api/search/reindex
 * Computes and stores embeddings for all library entries that don't have one yet.
 * Returns { ok, indexed, skipped, total } or a note if embeddings are disabled.
 */
app.post('/api/search/reindex', blockInWeb, async (_req, res) => {
  // Ensure model init has run (idempotent and fast if already done)
  await initEmbeddings();

  if (!isAvailable()) {
    return res.json({
      ok:      false,
      note:    'Semantic search is disabled on this server.',
      reason:  getFailureReason() ?? 'Model failed to load.',
      indexed: 0,
      skipped: 0,
      total:   0,
    });
  }

  try {
    const metas      = await listEntries();
    const existing   = new Set(allEmbeddings().map((e) => e.videoId));
    let indexed = 0;
    let skipped = 0;

    for (const meta of metas) {
      if (existing.has(meta.videoId)) { skipped++; continue; }

      const full = await getEntry(meta.videoId);
      if (!full) { skipped++; continue; }

      const text = buildEmbedText(full);
      if (!text.trim()) { skipped++; continue; }

      const vector = await embedText(text);
      if (!vector)  { skipped++; continue; }

      setEmbedding(meta.videoId, vector, vector.length);
      indexed++;
    }

    return res.json({ ok: true, indexed, skipped, total: metas.length });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

/**
 * GET /api/search?q=...&limit=...
 * FTS5 keyword search, upgraded to hybrid when embeddings are available.
 * Response shape is always { results: [...], mode: 'keyword'|'hybrid' }.
 * Each result: { videoId, title, url, snippet, tags, favorite }.
 */
app.get('/api/search', blockInWeb, async (req, res) => {
  const q     = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  if (!q) return res.json({ results: [], mode: 'keyword' });

  try {
    // FTS5 — always available; fetch more rows than needed for hybrid blending
    const ftsEntries = await searchLibrary(q, limit * 2);

    /** Map a full entry to the slim search-result shape */
    const toResult = (entry) => ({
      videoId:  entry.videoId,
      title:    entry.title,
      url:      entry.url,
      snippet:  buildSnippet(entry, q),
      tags:     Array.isArray(entry.tags) ? entry.tags : [],
      favorite: Boolean(entry.favorite),
    });

    // ---- Keyword-only path (no embeddings) ----
    if (!isAvailable()) {
      return res.json({ results: ftsEntries.slice(0, limit).map(toResult), mode: 'keyword' });
    }

    // ---- Hybrid path ----
    const queryVec = await embedText(q);
    if (!queryVec) {
      // embedText failed silently — degrade gracefully to keyword
      return res.json({ results: ftsEntries.slice(0, limit).map(toResult), mode: 'keyword' });
    }

    const storedEmbs   = allEmbeddings();
    const semScoreMap  = new Map(
      storedEmbs.map(({ videoId, vector }) => [videoId, cosineSimilarity(queryVec, vector)])
    );

    // Build merged candidate set starting from FTS results
    const byId = new Map();
    ftsEntries.forEach((entry, i) => {
      const ftsScore = ftsEntries.length > 1 ? 1 - i / (ftsEntries.length - 1) : 1;
      byId.set(entry.videoId, {
        entry,
        ftsScore,
        semScore: semScoreMap.get(entry.videoId) ?? 0,
      });
    });

    // Pull in semantic-only hits above threshold (catches synonym / paraphrase matches)
    const SEM_THRESHOLD = 0.35;
    for (const [videoId, semScore] of semScoreMap.entries()) {
      if (!byId.has(videoId) && semScore >= SEM_THRESHOLD) {
        const full = await getEntry(videoId);
        if (full) byId.set(videoId, { entry: full, ftsScore: 0, semScore });
      }
    }

    // Blend: 60 % FTS relevance + 40 % cosine similarity
    const ranked = [...byId.values()]
      .map(({ entry, ftsScore, semScore }) => ({
        entry,
        score: 0.6 * ftsScore + 0.4 * semScore,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return res.json({ results: ranked.map(({ entry }) => toResult(entry)), mode: 'hybrid' });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

export { app, rateLimitHit, buildInjectedHtml, ECHO_MODE, isWeb, ECHO_ERROR_STATUS };
