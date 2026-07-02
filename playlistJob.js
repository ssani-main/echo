// In-memory background job manager for batch playlist digesting.
// No external dependencies; jobs live only for the lifetime of the process.
import { extractPlaylist, fetchTranscript } from './transcript.js';
import { generateDigest, mergeUsage } from './digest.js';
import { saveEntry, getEntry } from './store.js';

const jobs = new Map();
let _jobCounter = 0;

const MAX_JOBS = 20;

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
 * Start a batch playlist digest job in the background.
 * Returns immediately with { jobId }; the actual work runs asynchronously.
 *
 * @param {string} url
 * @param {{ length?: string, format?: string, language?: string, lang?: string, skipExisting?: boolean }} [opts]
 * @returns {{ jobId: string }}
 */
export function startPlaylistDigest(url, opts = {}) {
  const jobId = generateJobId();
  const startedAt = new Date().toISOString();

  const job = {
    id: jobId,
    url,
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
  };

  jobs.set(jobId, job);
  pruneJobs();

  const skipExisting = opts.skipExisting !== false;

  async function run() {
    try {
      const { playlistTitle, videos } = await extractPlaylist(url);
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

  run();

  return { jobId };
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
