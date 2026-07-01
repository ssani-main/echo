import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractVideoId, fetchTranscript } from './transcript.js';
import { generateDigest } from './digest.js';
import { getTodayUsage } from './usage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 8000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));

app.post('/api/transcript', async (req, res) => {
  const { url } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'Could not find a valid YouTube video ID in that URL.',
    });
  }

  try {
    const segments = await fetchTranscript(videoId);
    return res.json({ videoId, segments });
  } catch (err) {
    return res.status(404).json({
      error:
        'Could not fetch transcript. The video may have captions disabled, ' +
        'be private, age-restricted, or the URL may be invalid.',
      detail: err.message,
    });
  }
});

app.post('/api/digest', async (req, res) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No transcript text provided.' });
  }

  try {
    const result = await generateDigest(text);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to generate digest.',
      detail: err.message,
    });
  }
});

app.get('/api/usage', async (req, res) => {
  try {
    const usage = await getTodayUsage();
    return res.json(usage);
  } catch (err) {
    return res.json({ available: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
