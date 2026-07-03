import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startPlaylistDigest, getJob, cancelJob } from '../playlistJob.js';

// ---------------------------------------------------------------------------
// Test helpers: fake dependencies so no real network / Claude CLI calls happen.
// ---------------------------------------------------------------------------

function makeVideos(n) {
  return Array.from({ length: n }, (_, i) => ({ videoId: `vid${i}`, title: `Video ${i}` }));
}

function makeDeps(overrides = {}) {
  const savedEntries = new Map();
  const deps = {
    extractPlaylist: async () => ({ playlistTitle: 'Fake Playlist', videos: makeVideos(3) }),
    fetchTranscript: async (videoId) => [{ text: `transcript for ${videoId}`, offset: 0 }],
    generateDigest: async () => ({ digest: 'a fake digest', usage: { inputTokens: 1, outputTokens: 1 } }),
    mergeUsage: (usages) => usages.filter(Boolean).reduce(
      (acc, u) => ({
        inputTokens: (acc.inputTokens || 0) + (u.inputTokens || 0),
        outputTokens: (acc.outputTokens || 0) + (u.outputTokens || 0),
      }),
      {},
    ),
    saveEntry: async (entry) => {
      savedEntries.set(entry.videoId, entry);
    },
    getEntry: async (videoId) => savedEntries.get(videoId) || null,
    ...overrides,
  };
  return { deps, savedEntries };
}

async function waitForJobFinish(jobId, timeoutMs = 2000) {
  const start = Date.now();
  let job = getJob(jobId);
  while (job && job.status === 'running') {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for job to finish');
    await new Promise((r) => setImmediate(r));
    job = getJob(jobId);
  }
  return job;
}

// ---------------------------------------------------------------------------
// 1. Job runs to completion, status transitions, results accumulate
// ---------------------------------------------------------------------------

test('startPlaylistDigest runs a job to completion over fake videos and accumulates results', async () => {
  const { deps, savedEntries } = makeDeps();
  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);

  const initial = getJob(jobId);
  assert.ok(initial);
  assert.equal(initial.status, 'running');

  const job = await waitForJobFinish(jobId);
  assert.ok(job);
  assert.equal(job.status, 'done');
  assert.equal(job.playlistTitle, 'Fake Playlist');
  assert.equal(job.total, 3);
  assert.equal(job.saved, 3);
  assert.equal(job.failed, 0);
  assert.equal(job.skipped, 0);
  assert.equal(job.completed, 3);
  assert.ok(job.finishedAt);
  assert.equal(job.items.length, 3);
  for (const item of job.items) {
    assert.equal(item.status, 'saved');
  }
  assert.equal(savedEntries.size, 3);
});

test('startPlaylistDigest skips videos that already have a saved digest when skipExisting is true (default)', async () => {
  const { deps, savedEntries } = makeDeps();
  savedEntries.set('vid1', { videoId: 'vid1', digest: 'already have a digest' });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.skipped, 1);
  assert.equal(job.saved, 2);
  const skippedItem = job.items.find((i) => i.videoId === 'vid1');
  assert.equal(skippedItem.status, 'skipped');
});

// ---------------------------------------------------------------------------
// 2. Cancellation
// ---------------------------------------------------------------------------

test('cancelJob stops further processing and marks the job cancelled', async () => {
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  let calls = 0;

  const { deps } = makeDeps({
    fetchTranscript: async (videoId) => {
      calls += 1;
      if (calls === 1) {
        // Let the test cancel the job while this first video is "in flight".
        await gate;
      }
      return [{ text: `transcript for ${videoId}`, offset: 0 }];
    },
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);

  // Wait until the job has started processing the first video.
  const start = Date.now();
  while (calls === 0) {
    if (Date.now() - start > 2000) throw new Error('Timed out waiting for processing to start');
    await new Promise((r) => setImmediate(r));
  }

  const cancelled = cancelJob(jobId);
  assert.equal(cancelled, true);

  const jobRightAfterCancel = getJob(jobId);
  assert.equal(jobRightAfterCancel.status, 'cancelled');

  // Let the in-flight fetchTranscript call resolve; the loop should observe
  // 'cancelled' status and stop, not overwrite it with 'done'.
  resolveGate();
  const job = await waitForJobFinish(jobId);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.finishedAt);
  // Only the first video should have been processed (saved), the rest never touched.
  assert.equal(calls, 1);
});

test('cancelJob returns false for an unknown or already-finished job', async () => {
  assert.equal(cancelJob('nonexistent-job-id'), false);

  const { deps } = makeDeps();
  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  await waitForJobFinish(jobId);

  assert.equal(cancelJob(jobId), false);
});

// ---------------------------------------------------------------------------
// 3. Error in one video doesn't crash the whole job
// ---------------------------------------------------------------------------

test('a generic per-video error is recorded and the job continues processing remaining videos', async () => {
  const { deps } = makeDeps({
    fetchTranscript: async (videoId) => {
      if (videoId === 'vid1') throw new Error('boom: transcript fetch failed');
      return [{ text: `transcript for ${videoId}`, offset: 0 }];
    },
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.saved, 2);
  assert.equal(job.failed, 1);
  assert.equal(job.completed, 3);
  const failedItem = job.items.find((i) => i.videoId === 'vid1');
  assert.equal(failedItem.status, 'failed');
  assert.equal(failedItem.error, 'boom: transcript fetch failed');
});

test('empty transcript segments are treated as a per-video failure, not a crash', async () => {
  const { deps } = makeDeps({
    fetchTranscript: async (videoId) => (videoId === 'vid0' ? [] : [{ text: 'ok', offset: 0 }]),
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.failed, 1);
  const failedItem = job.items.find((i) => i.videoId === 'vid0');
  assert.equal(failedItem.status, 'failed');
  assert.equal(failedItem.error, 'No transcript available');
});

test('a CLAUDE_NOT_INSTALLED error aborts the whole job with status "error"', async () => {
  const err = new Error('Claude CLI is not installed');
  err.echoCode = 'CLAUDE_NOT_INSTALLED';

  const { deps } = makeDeps({
    generateDigest: async () => { throw err; },
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'error');
  assert.equal(job.error, 'Claude CLI is not installed');
  assert.equal(job.failed, 1);
  // Loop should have broken after the first video, not processed the rest.
  assert.equal(job.completed, 1);
});

test('an error during extractPlaylist itself sets job status to error', async () => {
  const { deps } = makeDeps({
    extractPlaylist: async () => { throw new Error('playlist not found'); },
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'error');
  assert.equal(job.error, 'playlist not found');
});

test('an empty playlist sets job status to error with a descriptive message', async () => {
  const { deps } = makeDeps({
    extractPlaylist: async () => ({ playlistTitle: 'Empty Playlist', videos: [] }),
  });

  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'error');
  assert.equal(job.error, 'No videos found in playlist.');
  assert.equal(job.total, 0);
});

// ---------------------------------------------------------------------------
// 4. Status lookup shape
// ---------------------------------------------------------------------------

test('getJob returns a JSON-safe snapshot with the expected shape, and null for unknown ids', async () => {
  const { deps } = makeDeps();
  const { jobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(getJob('does-not-exist'), null);

  assert.equal(typeof job.id, 'string');
  assert.equal(job.id, jobId);
  assert.equal(typeof job.url, 'string');
  assert.equal(typeof job.status, 'string');
  assert.ok(typeof job.playlistTitle === 'string' || job.playlistTitle === null);
  assert.equal(typeof job.total, 'number');
  assert.equal(typeof job.completed, 'number');
  assert.equal(typeof job.saved, 'number');
  assert.equal(typeof job.failed, 'number');
  assert.equal(typeof job.skipped, 'number');
  assert.equal(typeof job.currentIndex, 'number');
  assert.ok(Array.isArray(job.items));
  for (const item of job.items) {
    assert.equal(typeof item.videoId, 'string');
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.status, 'string');
  }
  assert.ok(job.startedAt);
  assert.ok(job.finishedAt);

  // Snapshot is a deep copy, mutating it must not affect the stored job.
  job.status = 'mutated';
  const jobAgain = getJob(jobId);
  assert.equal(jobAgain.status, 'done');
});

// ---------------------------------------------------------------------------
// 5. pruneJobs behavior (exercised indirectly via startPlaylistDigest, since
//    pruneJobs itself is not exported)
// ---------------------------------------------------------------------------

test('pruning keeps the job map bounded to ~20 finished jobs, dropping the oldest first', async () => {
  const { deps } = makeDeps();

  // Create more than 20 jobs and let each finish before starting the next,
  // so startedAt ordering is deterministic.
  const jobIds = [];
  for (let i = 0; i < 25; i++) {
    const { jobId } = startPlaylistDigest(`https://www.youtube.com/playlist?list=fake${i}`, {}, deps);
    await waitForJobFinish(jobId);
    jobIds.push(jobId);
  }

  // The earliest jobs should have been pruned once the map exceeded MAX_JOBS (20).
  const firstJob = getJob(jobIds[0]);
  assert.equal(firstJob, null);

  // The most recent jobs should still be present.
  const lastJob = getJob(jobIds[jobIds.length - 1]);
  assert.ok(lastJob);
  assert.equal(lastJob.status, 'done');
});
