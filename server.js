import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
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

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

app.use(express.json({ limit: '5mb' }));
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
  INTERNAL:               500,
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

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

app.post('/api/transcript', async (req, res) => {
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
    return res.json({ videoId, url: req.body.url, title, segments, langCode });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

app.get('/api/languages', async (req, res) => {
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

app.post('/api/playlist', async (req, res) => {
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

app.post('/api/digest', async (req, res) => {
  const { text, length, format, language } = req.body;

  if (!text || !text.trim()) {
    return sendError(
      res,
      'INTERNAL',
      'No transcript text provided.',
      'Load a transcript before generating a digest.',
      400
    );
  }

  try {
    const result = await generateDigest(text, { length, format, language });
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Chat / Ask
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const { text, question } = req.body;
  if (!text || !text.trim()) {
    return sendError(res, 'INTERNAL', 'text is required.', '', 400);
  }
  if (!question || !question.trim()) {
    return sendError(res, 'INTERNAL', 'question is required.', '', 400);
  }
  try {
    const result = await askVideoQuestion(text, question);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

app.post('/api/chapters', async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return sendError(res, 'INTERNAL', 'segments must be a non-empty array.', '', 400);
  }
  try {
    const result = await extractChapters(segments);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

app.post('/api/quotes', async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return sendError(res, 'INTERNAL', 'segments must be a non-empty array.', '', 400);
  }
  try {
    const result = await extractQuotes(segments);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Fact-check
// ---------------------------------------------------------------------------

app.post('/api/factcheck', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return sendError(res, 'INTERNAL', 'text is required.', '', 400);
  }
  try {
    const result = await factCheck(text);
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

app.get('/api/saved', async (_req, res) => {
  try {
    res.json(await listEntries());
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/export', async (_req, res) => {
  try {
    const meta = await listEntries();
    const entries = await Promise.all(meta.map((m) => getEntry(m.videoId)));
    res.json({ entries: entries.filter(Boolean) });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

// Sub-routes for a saved entry — all before the bare /:videoId GET/DELETE

app.patch('/api/saved/:videoId/tags', async (req, res) => {
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

app.patch('/api/saved/:videoId/favorite', async (req, res) => {
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

app.post('/api/saved/:videoId/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return sendError(res, 'INTERNAL', 'text is required.', '', 400);
    }
    const note = await addNote(req.params.videoId, text);
    if (note === null) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.status(201).json(note);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId/notes/:noteId', async (req, res) => {
  try {
    const result = await deleteNote(req.params.videoId, req.params.noteId);
    if (result === null) return sendError(res, 'INTERNAL', 'Entry not found.', '', 404);
    if (result === false) return sendError(res, 'INTERNAL', 'Note not found.', '', 404);
    res.json({ ok: true });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.put('/api/saved/:videoId/highlights', async (req, res) => {
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

app.post('/api/saved/:videoId/highlights', async (req, res) => {
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

app.delete('/api/saved/:videoId/highlights/:highlightId', async (req, res) => {
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

app.get('/api/saved/:videoId', async (req, res) => {
  try {
    const e = await getEntry(req.params.videoId);
    if (!e) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(e);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/:videoId/export.md', async (req, res) => {
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

app.get('/api/clips', async (req, res) => {
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

app.post('/api/saved', async (req, res) => {
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

app.delete('/api/saved/:videoId', async (req, res) => {
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

app.post('/api/cross-digest', async (req, res) => {
  const { videoIds, options } = req.body;

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
  const entries = [];
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

  try {
    const { digest, usage } = await generateCrossDigest(entries, options || {});
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
app.post('/api/search/reindex', async (_req, res) => {
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
app.get('/api/search', async (req, res) => {
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

export { app };
