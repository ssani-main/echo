import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startBatchDigest, startPlaylistDigest, getJob } from '../playlistJob.js';

// ---------------------------------------------------------------------------
// Test helpers: fake dependencies so no real network / Claude CLI calls happen.
// (Mirrors tests/playlistJob.test.js's dependency-injection seam.)
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const savedEntries = new Map();
  const deps = {
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
// 1. Resolves mixed URLs + bare IDs, dedupes, preserves order
// ---------------------------------------------------------------------------

test('startBatchDigest resolves mixed URLs and bare IDs, dedupes, and preserves order', async () => {
  const { deps, savedEntries } = makeDeps();
  const items = [
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'bbbbbbbbbbb', // bare 11-char ID
    'https://youtu.be/ccccccccccc',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa', // duplicate of the first
  ];

  const { jobId } = startBatchDigest(items, {}, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.kind, 'batch');
  assert.equal(job.total, 3);
  assert.deepEqual(job.items.map((i) => i.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  assert.equal(job.saved, 3);
  assert.equal(savedEntries.size, 3);
});

// ---------------------------------------------------------------------------
// 2. Empty / all-invalid input throws synchronously
// ---------------------------------------------------------------------------

test('startBatchDigest throws a tagged INVALID_URL error for empty input', () => {
  const { deps } = makeDeps();
  assert.throws(
    () => startBatchDigest([], {}, deps),
    (err) => {
      assert.equal(err.echoCode, 'INVALID_URL');
      return true;
    },
  );
});

test('startBatchDigest throws a tagged INVALID_URL error when every item is unresolvable', () => {
  const { deps } = makeDeps();
  assert.throws(
    () => startBatchDigest(['not a url', '', 'short', null, 42], {}, deps),
    (err) => {
      assert.equal(err.echoCode, 'INVALID_URL');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. job.kind
// ---------------------------------------------------------------------------

test('job.kind is "batch" for startBatchDigest and "playlist" for startPlaylistDigest', async () => {
  const { deps: batchDeps } = makeDeps();
  const { jobId: batchJobId } = startBatchDigest(['https://www.youtube.com/watch?v=aaaaaaaaaaa'], {}, batchDeps);
  const batchJob = await waitForJobFinish(batchJobId);
  assert.equal(batchJob.kind, 'batch');
  assert.equal(batchJob.url, null);

  const { deps: playlistDeps } = makeDeps({
    extractPlaylist: async () => ({
      playlistTitle: 'Fake Playlist',
      videos: [{ videoId: 'ddddddddddd', title: 'Video D' }],
    }),
  });
  const { jobId: playlistJobId } = startPlaylistDigest('https://www.youtube.com/playlist?list=fake', {}, playlistDeps);
  const playlistJob = await waitForJobFinish(playlistJobId);
  assert.equal(playlistJob.kind, 'playlist');
  assert.equal(playlistJob.url, 'https://www.youtube.com/playlist?list=fake');
});

// ---------------------------------------------------------------------------
// 4. Truncation past the max item cap
// ---------------------------------------------------------------------------

test('startBatchDigest truncates past maxItems and sets job.truncated', async () => {
  const { deps } = makeDeps();
  // Each ID is exactly 11 chars from the valid YouTube ID charset, and distinct.
  const uniqueItems = Array.from({ length: 5 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  assert.equal(uniqueItems[0].length, 11);

  const { jobId } = startBatchDigest(uniqueItems, { maxItems: 3 }, deps);
  const job = await waitForJobFinish(jobId);

  assert.equal(job.truncated, true);
  assert.equal(job.total, 3);
  assert.equal(job.items.length, 3);
  assert.deepEqual(job.items.map((i) => i.videoId), uniqueItems.slice(0, 3));
});

test('startBatchDigest does not truncate when under maxItems', async () => {
  const { deps } = makeDeps();
  const { jobId } = startBatchDigest(
    ['https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb'],
    { maxItems: 3 },
    deps,
  );
  const job = await waitForJobFinish(jobId);

  assert.equal(job.truncated, false);
  assert.equal(job.total, 2);
});
