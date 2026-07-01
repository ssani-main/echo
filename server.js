import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
} from './store.js';
import {
  generateDigest,
  askVideoQuestion,
  extractChapters,
  extractQuotes,
  factCheck,
} from './digest.js';
import { getTodayUsage } from './usage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 8000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));

// --- Transcript ---

app.post('/api/transcript', async (req, res) => {
  const { url, lang } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'Could not find a valid YouTube video ID in that URL.',
    });
  }

  try {
    const segments = await fetchTranscript(videoId, { lang });
    const title = await getVideoTitle(videoId);
    return res.json({ videoId, url: req.body.url, title, segments });
  } catch (err) {
    return res.status(404).json({
      error:
        'Could not fetch transcript. The video may have captions disabled, ' +
        'be private, age-restricted, or the URL may be invalid.',
      detail: err.message,
    });
  }
});

// --- Languages ---

app.get('/api/languages', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId query parameter is required.' });
  }
  try {
    const tracks = await listCaptionTracks(videoId);
    return res.json({ tracks });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list caption tracks.', detail: err.message });
  }
});

// --- Playlist ---

app.post('/api/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required.' });
  }
  try {
    const result = await extractPlaylist(url);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to extract playlist.', detail: err.message });
  }
});

// --- Digest ---

app.post('/api/digest', async (req, res) => {
  const { text, length, format, language } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No transcript text provided.' });
  }

  try {
    const result = await generateDigest(text, { length, format, language });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to generate digest.',
      detail: err.message,
    });
  }
});

// --- Chat ---

app.post('/api/chat', async (req, res) => {
  const { text, question } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required.' });
  }
  try {
    const result = await askVideoQuestion(text, question);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to answer question.', detail: err.message });
  }
});

// --- Chapters ---

app.post('/api/chapters', async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'segments must be a non-empty array.' });
  }
  try {
    const result = await extractChapters(segments);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to extract chapters.', detail: err.message });
  }
});

// --- Quotes ---

app.post('/api/quotes', async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'segments must be a non-empty array.' });
  }
  try {
    const result = await extractQuotes(segments);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to extract quotes.', detail: err.message });
  }
});

// --- Fact-check ---

app.post('/api/factcheck', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  try {
    const result = await factCheck(text);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fact-check.', detail: err.message });
  }
});

// --- Usage ---

app.get('/api/usage', async (req, res) => {
  try {
    const usage = await getTodayUsage();
    return res.json(usage);
  } catch (err) {
    return res.json({ available: false, error: String(err) });
  }
});

// --- Library / saved routes ---

// IMPORTANT: /api/saved/export must be defined BEFORE /api/saved/:videoId
// so Express does not capture "export" as a videoId parameter.

app.get('/api/saved', async (_req, res) => {
  try {
    res.json(await listEntries());
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.get('/api/saved/export', async (_req, res) => {
  try {
    const meta = await listEntries();
    const entries = await Promise.all(meta.map((m) => getEntry(m.videoId)));
    res.json({ entries: entries.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

// Sub-routes for a saved entry — all before the bare /:videoId GET/DELETE

app.patch('/api/saved/:videoId/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array.' });
    }
    const entry = await setTags(req.params.videoId, tags);
    if (!entry) return res.status(404).json({ error: 'Not found.' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.patch('/api/saved/:videoId/favorite', async (req, res) => {
  try {
    const { favorite } = req.body;
    if (favorite === undefined || favorite === null) {
      return res.status(400).json({ error: 'favorite is required.' });
    }
    const entry = await setFavorite(req.params.videoId, Boolean(favorite));
    if (!entry) return res.status(404).json({ error: 'Not found.' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.post('/api/saved/:videoId/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text is required.' });
    }
    const note = await addNote(req.params.videoId, text);
    if (note === null) return res.status(404).json({ error: 'Not found.' });
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.delete('/api/saved/:videoId/notes/:noteId', async (req, res) => {
  try {
    const result = await deleteNote(req.params.videoId, req.params.noteId);
    if (result === null) return res.status(404).json({ error: 'Entry not found.' });
    if (result === false) return res.status(404).json({ error: 'Note not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.put('/api/saved/:videoId/highlights', async (req, res) => {
  try {
    const { highlights } = req.body;
    if (!Array.isArray(highlights)) {
      return res.status(400).json({ error: 'highlights must be an array.' });
    }
    const entry = await setHighlights(req.params.videoId, highlights);
    if (!entry) return res.status(404).json({ error: 'Not found.' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
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
      return res.status(400).json({ error: innerErr.message });
    }
    if (highlight === null) return res.status(404).json({ error: 'Not found.' });
    res.status(201).json(highlight);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.delete('/api/saved/:videoId/highlights/:highlightId', async (req, res) => {
  try {
    const result = await deleteHighlight(req.params.videoId, req.params.highlightId);
    if (result === null || result === false) {
      return res.status(404).json({ error: 'Not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.get('/api/saved/:videoId', async (req, res) => {
  try {
    const e = await getEntry(req.params.videoId);
    if (!e) return res.status(404).json({ error: 'Not found.' });
    res.json(e);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.post('/api/saved', async (req, res) => {
  try {
    const { url, videoId, title, segments, digest } = req.body;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'videoId and segments are required.' });
    }
    const meta = await saveEntry({ url, videoId, title, segments, digest });
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.delete('/api/saved/:videoId', async (req, res) => {
  try {
    const ok = await deleteEntry(req.params.videoId);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Storage error.', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
