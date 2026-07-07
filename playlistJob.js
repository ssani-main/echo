// In-memory background job manager for batch playlist digesting.
// No external dependencies; jobs live only for the lifetime of the process.
import { extractPlaylist, fetchTranscript, extractVideoId } from './transcript.js';
import { generateDigest, mergeUsage } from './digest.js';
import { saveEntry, getEntry } from './store.js';

const jobs = new Map();
let _jobCounter = 0;

const MAX_JOBS = 20;

// Hard cap on how many videos a single multi-paste batch job can enqueue —
// keeps a single request from fanning out into an unbounded number of
// Claude CLI calls. Truncated silently (job.truncated=true), not rejected,
// so a big paste still runs for the first N items.
const MAX_BATCH_ITEMS = 50;

// Default dependencies, overridable via `startPlaylistDigest(url, opts, deps)`
// so tests can inject fakes without hitting the network or the Claude CLI.
const defaultDeps = { extractPlaylist, fetchTranscript, generateDigest, mergeUsage, saveEntry, getEntry };

/**
 * Generate a unique job id: `job_<timestamp>_<counter>`.
 */
function generateJobId() {
  _jobCounter += 1;
  return `job_${Date.now()}_${_jobCounter}`;
}

/**
 * Drop the oldest finished jobs once the map grows beyond MAX_JOBS,
 * keeping memory bounded for long-running server processes.
 */
function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;

  const finished = [];
  for (const [id, job] of jobs) {
    if (job.status !== 'running') finished.push([id, job]);
  }
  finished.sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0));

  let excess = jobs.size - MAX_JOBS;
  for (const [id] of finished) {
    if (excess <= 0) break;
    jobs.delete(id);
    excess -= 1;
  }
}

/**
 * Shared job runner: creates the in-memory job record, kicks off the async
 * worker, and returns { jobId } immediately. `resolveVideos()` is the only
 * thing that differs between a playlist job and a batch (multi-paste) job —
 * it must return `{ playlistTitle, videos }` where `videos` is an array of
 * `{ videoId, title }`.
 *
 * @param {object} jobDefaults - fields to seed onto the job (id/url/kind/etc. already handled by caller)
 * @param {() => Promise<{ playlistTitle: string|null, videos: Array<{videoId:string, title:string|null}> }>} resolveVideos
 * @param {object} opts
 * @param {typeof defaultDeps} deps
 * @returns {{ jobId: string }}
 */
function startJob(jobDefaults, resolveVideos, opts, deps) {
  const { fetchTranscript, generateDigest, mergeUsage, saveEntry, getEntry } = {
    ...defaultDeps,
    ...deps,
  };
  const jobId = generateJobId();
  const startedAt = new Date().toISOString();

  const job = {
    id: jobId,
    url: null,
    kind: 'playlist',
    status: 'running',
    playlistTitle: null,
    total: 0,
    completed: 0,
    saved: 0,
    failed: 0,
    skipped: 0,
    currentIndex: -1,
    items: [],
    error: null,
    startedAt,
    finishedAt: null,
    usage: null,
    ...jobDefaults,
  };

  jobs.set(jobId, job);
  pruneJobs();

  const skipExisting = opts.skipExisting !== false;

  async function run() {
    try {
      const { playlistTitle, videos } = await resolveVideos();
      job.playlistTitle = playlistTitle;
      job.total = videos.length;
      job.items = videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        status: 'pending',
      }));

      if (videos.length === 0) {
        job.status = 'error';
        job.error = 'No videos found in playlist.';
        job.finishedAt = new Date().toISOString();
        return;
      }

      for (let i = 0; i < videos.length; i++) {
        if (job.status === 'cancelled') break;

        const video = videos[i];
        const item = job.items[i];
        job.currentIndex = i;
        item.status = 'processing';

        if (skipExisting) {
          try {
            const existing = await getEntry(video.videoId);
            if (existing && existing.digest && existing.digest.trim()) {
              item.status = 'skipped';
              job.skipped += 1;
              job.completed = job.saved + job.failed + job.skipped;
              continue;
            }
          } catch {
            // If lookup fails, fall through and try to (re)process the video.
          }
        }

        try {
          const segments = await fetchTranscript(video.videoId, { lang: opts.lang });
          if (!Array.isArray(segments) || segments.length === 0) {
            throw new Error('No transcript available');
          }

          const text = segments.map((s) => s.text).join('\n');
          const { digest, usage } = await generateDigest(text, {
            length: opts.length,
            format: opts.format,
            language: opts.language,
          });

          await saveEntry({
            url: 'https://www.youtube.com/watch?v=' + video.videoId,
            videoId: video.videoId,
            title: item.title,
            segments,
            digest,
          });

          item.status = 'saved';
          job.saved += 1;
          job.usage = mergeUsage([job.usage, usage].filter(Boolean));
        } catch (err) {
          if (err && (err.echoCode === 'CLAUDE_NOT_INSTALLED' || err.echoCode === 'CLAUDE_NOT_AUTHED')) {
            item.status = 'failed';
            item.error = err.message;
            job.failed += 1;
            job.completed = job.saved + job.failed + job.skipped;
            job.status = 'error';
            job.error = err.message;
            break;
          }

          item.status = 'failed';
          item.error = (err && err.message) || 'Failed';
          job.failed += 1;
        }

        job.completed = job.saved + job.failed + job.skipped;
      }

      if (job.status !== 'cancelled' && job.status !== 'error') {
        job.status = 'done';
      }
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'error';
      job.error = (err && err.message) || 'Unexpected error during playlist digest.';
      job.finishedAt = new Date().toISOString();
    }
  }

  run().catch((err) => {
    job.status = 'error';
    job.error = (err && err.message) || 'Unexpected error during playlist digest.';
    job.finishedAt = new Date().toISOString();
  });

  return { jobId };
}

/**
 * Start a batch playlist digest job in the background.
 * Returns immediately with { jobId }; the actual work runs asynchronously.
 *
 * @param {string} url
 * @param {{ length?: string, format?: string, language?: string, lang?: string, skipExisting?: boolean }} [opts]
 * @param {Partial<typeof defaultDeps>} [deps] Injectable dependencies (tests only; defaults to real implementations)
 * @returns {{ jobId: string }}
 */
export function startPlaylistDigest(url, opts = {}, deps = {}) {
  const { extractPlaylist } = { ...defaultDeps, ...deps };
  return startJob(
    { url, kind: 'playlist' },
    () => extractPlaylist(url),
    opts,
    deps,
  );
}

/**
 * Start a batch digest job over a list of raw pasted URLs/video IDs
 * (as opposed to a single playlist URL). Resolves each item via
 * `extractVideoId`, drops unresolvable ones, dedupes preserving order, and
 * caps the total at `MAX_BATCH_ITEMS` (truncating rather than rejecting, so
 * a big paste still runs for the first N items — `job.truncated` is set
 * when that happens).
 *
 * @param {string[]} items - raw pasted URLs or bare 11-char video IDs
 * @param {{ length?: string, format?: string, language?: string, lang?: string, skipExisting?: boolean, maxItems?: number }} [opts]
 * @param {Partial<typeof defaultDeps>} [deps] Injectable dependencies (tests only; defaults to real implementations)
 * @returns {{ jobId: string }}
 */
export function startBatchDigest(items, opts = {}, deps = {}) {
  const seen = new Set();
  const ids = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const videoId = extractVideoId(typeof raw === 'string' ? raw : '');
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    ids.push(videoId);
  }

  if (ids.length === 0) {
    const err = new Error('No valid YouTube URLs or video IDs were found in the pasted list.');
    err.echoCode = 'INVALID_URL';
    throw err;
  }

  const maxItems = Number.isFinite(opts.maxItems) && opts.maxItems > 0 ? opts.maxItems : MAX_BATCH_ITEMS;
  const truncated = ids.length > maxItems;
  const usedIds = truncated ? ids.slice(0, maxItems) : ids;
  const videos = usedIds.map((videoId) => ({ videoId, title: null }));

  return startJob(
    { url: null, kind: 'batch', truncated },
    async () => ({ playlistTitle: null, videos }),
    opts,
    deps,
  );
}

/**
 * Return a JSON-safe snapshot of a job, or null if the jobId is unknown.
 * @param {string} jobId
 */
export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return JSON.parse(JSON.stringify(job));
}

/**
 * Request cancellation of a running job. The worker checks between videos
 * and stops once it observes the 'cancelled' status.
 * Returns true if the job was running and cancellation was requested,
 * false if the job doesn't exist or isn't running.
 * @param {string} jobId
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  return true;
}
