import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// yt-dlp search calls can return a fair amount of JSON for 20-40 results —
// give ourselves headroom and a hard timeout so a hung process doesn't
// block the request indefinitely.
const YTDLP_MAX_BUFFER = 20 * 1024 * 1024; // 20MB
const YTDLP_TIMEOUT_MS = 25_000;

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'your', 'have', 'about', 'what', 'when',
  'where', 'which', 'their', 'there', 'these', 'those', 'will', 'into',
  'over', 'under', 'they', 'them', 'than', 'then', 'were', 'been', 'being',
  'does', 'doing', 'done', 'here', 'just', 'like', 'more', 'most', 'some',
  'such', 'only', 'very', 'also', 'each', 'every', 'both', 'because', 'while',
  'video', 'part', 'full', 'episode', 'official',
]);

/**
 * Format a duration in seconds as "M:SS" or "H:MM:SS".
 * @param {number|null|undefined} sec
 * @returns {string}
 */
function formatDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const totalSeconds = Math.floor(sec);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const secStr = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secStr}`;
  }
  return `${minutes}:${secStr}`;
}

/**
 * Map a raw yt-dlp flat-playlist entry to the Card contract.
 * @param {object} entry
 * @returns {object|null} null if the entry has no id
 */
function entryToCard(entry) {
  if (!entry || !entry.id) return null;
  const videoId = entry.id;
  const duration = typeof entry.duration === 'number' ? entry.duration : null;
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const thumbnail = thumbs.length > 0 ? (thumbs.at(-1)?.url ?? null) : null;

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: entry.title || '',
    channel: entry.channel || entry.uploader || '',
    duration,
    durationText: formatDuration(duration),
    views: typeof entry.view_count === 'number' ? entry.view_count : null,
    thumbnail,
  };
}

/**
 * Search YouTube (keyless, via yt-dlp's ytsearch) and return a list of Cards.
 * @param {string} query
 * @param {{ n?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function searchVideos(query, { n = 20 } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];

  const count = Math.min(Math.max(parseInt(n, 10) || 20, 1), 40);

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'yt-dlp',
      [`ytsearch${count}:${q}`, '--flat-playlist', '-J', '--no-warnings'],
      { maxBuffer: YTDLP_MAX_BUFFER, timeout: YTDLP_TIMEOUT_MS }
    ));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('yt-dlp is not installed or not on PATH.');
      e.echoCode = 'YTDLP_MISSING';
      e.hint = 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.';
      throw e;
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed to parse yt-dlp search output: ${err.message}`);
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const cards = [];
  for (const entry of entries) {
    const card = entryToCard(entry);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Derive up to 3 query terms from a saved library, preferring tag frequency
 * then falling back to salient words from recent titles.
 * @param {Array<object>} savedItems
 * @returns {string[]}
 */
function deriveQueryTerms(savedItems) {
  const terms = [];

  // 1. Top tags by frequency across the whole library.
  const tagCounts = new Map();
  for (const item of savedItems) {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    for (const rawTag of tags) {
      const tag = String(rawTag || '').trim().toLowerCase();
      if (!tag) continue;
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .slice(0, 3);
  terms.push(...topTags);

  // 2. Backfill from salient words in recent titles if fewer than 3 tags.
  if (terms.length < 3) {
    const recent = savedItems.slice(0, 10);
    for (const item of recent) {
      if (terms.length >= 3) break;
      const title = String(item?.title || '');
      const words = title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      for (const word of words) {
        if (terms.length >= 3) break;
        if (word.length < 4) continue;
        if (STOPWORDS.has(word)) continue;
        if (terms.includes(word)) continue;
        terms.push(word);
      }
    }
  }

  return terms;
}

/**
 * Build a "For You" discovery feed based on the saved library.
 * @param {Array<object>} savedItems  Result of store.listEntries()
 * @param {{ n?: number }} [opts]
 * @returns {Promise<{ results: Array<object>, basedOn: string[] }>}
 */
export async function forYou(savedItems, { n = 24 } = {}) {
  const items = Array.isArray(savedItems) ? savedItems : [];
  if (items.length === 0) return { results: [], basedOn: [] };

  const basedOn = deriveQueryTerms(items);
  if (basedOn.length === 0) return { results: [], basedOn: [] };

  const cap = Math.max(1, parseInt(n, 10) || 24);
  const savedIds = new Set(items.map((it) => it?.videoId).filter(Boolean));

  const seen = new Set();
  const results = [];

  // Run the per-term searches concurrently (each is an independent yt-dlp
  // subprocess). Wall time is the slowest single search rather than the sum.
  // Results are merged in basedOn order to preserve term priority in the feed.
  const perTerm = await Promise.all(
    basedOn.map((term) => searchVideos(term, { n: 8 }).catch(() => [])),
  );

  for (const cards of perTerm) {
    for (const card of cards) {
      if (savedIds.has(card.videoId)) continue;
      if (seen.has(card.videoId)) continue;
      seen.add(card.videoId);
      results.push(card);
      if (results.length >= cap) break;
    }
    if (results.length >= cap) break;
  }

  return { results, basedOn };
}
