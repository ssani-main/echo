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
    channelUrl: resolveChannelUrl(entry),
    duration,
    durationText: formatDuration(duration),
    views: typeof entry.view_count === 'number' ? entry.view_count : null,
    thumbnail,
  };
}

/**
 * Resolve the best available canonical channel URL from a yt-dlp entry.
 * Flat-playlist search results don't always carry all of these fields, so
 * this falls back through channel_url -> uploader_url -> channel_id in
 * priority order and returns null (not a throw) when none are present.
 * @param {object} entry
 * @returns {string|null}
 */
function resolveChannelUrl(entry) {
  if (!entry) return null;
  if (typeof entry.channel_url === 'string' && entry.channel_url) return entry.channel_url;
  if (typeof entry.uploader_url === 'string' && entry.uploader_url) return entry.uploader_url;
  if (typeof entry.channel_id === 'string' && entry.channel_id) {
    return `https://www.youtube.com/channel/${entry.channel_id}`;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Channel / creator following
// ---------------------------------------------------------------------------

// Cache of enumerated channel uploads, keyed by the canonical channel URL.
// Avoids re-spawning yt-dlp for every follow on every inbox poll.
const CHANNEL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const channelCache = new Map(); // channelUrl -> { ts: number, data: Array<object> }

/**
 * Parse a raw channel reference (full URL, handle, or partial path) into a
 * stable channelId and a canonical uploads URL suitable for yt-dlp.
 *
 * Accepted forms:
 *   https://www.youtube.com/channel/UCxxxxxxxx[/videos]
 *   https://www.youtube.com/@handle[/videos]
 *   https://www.youtube.com/c/name[/videos]
 *   https://www.youtube.com/user/name[/videos]
 *   @handle
 *
 * @param {string} input
 * @returns {{ channelId: string, url: string }}
 */
export function normalizeChannel(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    const e = new Error('A channel URL or @handle is required.');
    e.echoCode = 'INVALID_URL';
    throw e;
  }

  const fail = () => {
    const e = new Error('Could not recognize a YouTube channel in that input.');
    e.echoCode = 'INVALID_URL';
    throw e;
  };

  // Bare handle, e.g. "@handle"
  if (/^@[\w.-]+$/.test(raw)) {
    const handle = raw.toLowerCase();
    return { channelId: handle, url: `https://www.youtube.com/${handle}/videos` };
  }

  let parsed;
  try {
    // Allow bare domains/handles without a scheme.
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return fail();
  }

  const host = parsed.hostname.toLowerCase();
  if (!/(^|\.)youtube\.com$/.test(host) && host !== 'youtu.be') {
    return fail();
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return fail();

  // /channel/UC...
  if (segments[0] === 'channel' && segments[1]) {
    const channelId = segments[1];
    return { channelId, url: `https://www.youtube.com/channel/${channelId}/videos` };
  }

  // /@handle[/videos]
  if (segments[0].startsWith('@')) {
    const handle = segments[0].toLowerCase();
    return { channelId: handle, url: `https://www.youtube.com/${handle}/videos` };
  }

  // /c/name or /user/name — no stable UC id available from the URL alone;
  // use a normalized form of the path as the channelId.
  if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
    const name = segments[1].toLowerCase();
    const channelId = `${segments[0]}/${name}`;
    return { channelId, url: `https://www.youtube.com/${segments[0]}/${name}/videos` };
  }

  return fail();
}

/**
 * Enumerate the most recent uploads for a channel via yt-dlp (flat-playlist,
 * keyless). Results are cached per channelUrl for CHANNEL_CACHE_TTL_MS to
 * avoid hammering yt-dlp on every inbox poll; pass { force: true } to bypass.
 *
 * @param {string} channelUrl  Canonical uploads URL (from normalizeChannel)
 * @param {number} [limit=10]
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Array<{ videoId: string, title: string, channel?: string }>>}
 */
export async function enumerateChannelUploads(channelUrl, limit = 10, { force = false } = {}) {
  const count = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const now = Date.now();

  if (!force) {
    const cached = channelCache.get(channelUrl);
    if (cached && (now - cached.ts) < CHANNEL_CACHE_TTL_MS) {
      return cached.data.slice(0, count);
    }
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'yt-dlp',
      [channelUrl, '--flat-playlist', '--playlist-end', String(count), '-J', '--no-warnings'],
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
    throw new Error(`Failed to parse yt-dlp channel output: ${err.message}`);
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const uploads = [];
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    uploads.push({
      videoId: entry.id,
      title: entry.title || '',
      channel: entry.channel || entry.uploader || '',
    });
    if (uploads.length >= count) break;
  }

  channelCache.set(channelUrl, { ts: now, data: uploads });
  return uploads;
}

/**
 * Like enumerateChannelUploads, but bounded by a soft timeout. If the live
 * yt-dlp fetch doesn't finish within softTimeoutMs, resolve immediately with
 * the last cached uploads (even if the 15-min TTL has lapsed) — or an empty
 * list if nothing is cached — while the real fetch keeps running in the
 * background to warm the cache for the next poll. This keeps one slow/dead
 * channel from stalling the whole inbox up to the full yt-dlp timeout.
 * Never rejects: transport errors resolve as { stale:true, error }.
 *
 * @param {string} channelUrl
 * @param {number} [limit=10]
 * @param {number} [softTimeoutMs=5000]
 * @returns {Promise<{ uploads: Array<object>, stale: boolean, error?: string }>}
 */
export function enumerateChannelUploadsBounded(channelUrl, limit = 10, softTimeoutMs = 5000) {
  const count = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const now = Date.now();
  const cached = channelCache.get(channelUrl);
  if (cached && (now - cached.ts) < CHANNEL_CACHE_TTL_MS) {
    return Promise.resolve({ uploads: cached.data.slice(0, count), stale: false });
  }
  const fallback = () => (cached ? cached.data.slice(0, count) : []);

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => done({ uploads: fallback(), stale: true }), softTimeoutMs);
    // enumerateChannelUploads writes through to channelCache on success, so a
    // fetch that lands after the timeout still warms the cache for next time.
    enumerateChannelUploads(channelUrl, count).then(
      (uploads) => done({ uploads, stale: false }),
      (err) => done({ uploads: fallback(), stale: true, error: err.message || 'Failed to check channel.' })
    );
  });
}

// Cache of paginated channel-uploads pages, keyed by
// `${channelUrl}::${offset}::${limit}`. Separate from `channelCache` (which
// only ever stores the first N uploads) since pages address arbitrary
// offsets/limits.
const channelPageCache = new Map(); // key -> { ts: number, data: { items, hasMore } }

/**
 * Fetch one page of a channel's full uploads catalog via yt-dlp
 * (flat-playlist, keyless), for the "browse a followed channel" UI.
 *
 * yt-dlp's `--playlist-start`/`--playlist-end` are 1-indexed and inclusive,
 * so a 0-indexed `{ offset, limit }` page maps to
 * `--playlist-start (offset + 1) --playlist-end (offset + limit)`.
 *
 * @param {string} channelUrl  Canonical uploads URL (from normalizeChannel)
 * @param {{ offset?: number, limit?: number, force?: boolean }} [opts]
 * @returns {Promise<{ items: Array<object>, hasMore: boolean }>}
 */
export async function getChannelUploadsPage(channelUrl, { offset = 0, limit = 12, force = false } = {}) {
  const start = Math.max(0, parseInt(offset, 10) || 0);
  const count = Math.max(1, parseInt(limit, 10) || 12);
  const cacheKey = `${channelUrl}::${start}::${count}`;
  const now = Date.now();

  if (!force) {
    const cached = channelPageCache.get(cacheKey);
    if (cached && (now - cached.ts) < CHANNEL_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const playlistStart = start + 1;
  const playlistEnd = start + count;

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'yt-dlp',
      [
        channelUrl,
        '--flat-playlist',
        '--playlist-start', String(playlistStart),
        '--playlist-end', String(playlistEnd),
        '-J',
        '--no-warnings',
      ],
      { maxBuffer: YTDLP_MAX_BUFFER, timeout: YTDLP_TIMEOUT_MS }
    ));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('yt-dlp is not installed or not on PATH.');
      e.echoCode = 'YTDLP_MISSING';
      e.hint = 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.';
      throw e;
    }
    const e = new Error(`Failed to enumerate channel uploads page: ${err.message}`);
    e.echoCode = 'YTDLP_FAILED';
    throw e;
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    const e = new Error(`Failed to parse yt-dlp channel output: ${err.message}`);
    e.echoCode = 'YTDLP_PARSE_FAILED';
    throw e;
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const result = buildChannelPage(entries, count);
  channelPageCache.set(cacheKey, { ts: now, data: result });
  return result;
}

/**
 * Pure helper: map raw yt-dlp flat-playlist entries to page cards, applying
 * the thumbnail fallback and the `hasMore` heuristic. Split out from
 * `getChannelUploadsPage` so it's unit-testable without spawning yt-dlp.
 * @param {Array<object>} entries  Raw yt-dlp entries (data.entries)
 * @param {number} count           The requested page size (limit)
 * @returns {{ items: Array<object>, hasMore: boolean }}
 */
export function buildChannelPage(entries, count) {
  const items = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const card = entryToCard(entry);
    if (!card) continue;
    if (!card.thumbnail) {
      card.thumbnail = `https://i.ytimg.com/vi/${card.videoId}/hqdefault.jpg`;
    }
    items.push(card);
  }
  return { items, hasMore: items.length === count };
}
