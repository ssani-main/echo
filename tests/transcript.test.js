import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVideoId,
  extractPlaylistId,
  isMillisecondOffsets,
  fetchWithRetry,
  isPermanentFetchError,
  fetchTranscript,
  extractPlaylist,
} from '../transcript.js';

// ---------------------------------------------------------------------------
// extractVideoId
// ---------------------------------------------------------------------------

test('extractVideoId: standard watch URL', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId: watch URL with extra query params', () => {
  assert.equal(
    extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLxyz'),
    'dQw4w9WgXcQ'
  );
});

test('extractVideoId: youtu.be short URL', () => {
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId: youtu.be short URL with query string', () => {
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
});

test('extractVideoId: shorts URL', () => {
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId: embed URL', () => {
  assert.equal(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId: bare 11-char ID', () => {
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractVideoId: watch URL that also carries a playlist id still resolves the video id', () => {
  assert.equal(
    extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij'),
    'dQw4w9WgXcQ'
  );
});

test('extractVideoId: invalid input returns null', () => {
  assert.equal(extractVideoId(''), null);
  assert.equal(extractVideoId(null), null);
  assert.equal(extractVideoId(undefined), null);
  assert.equal(extractVideoId('not a url'), null);
  assert.equal(extractVideoId('https://example.com/'), null);
  assert.equal(extractVideoId('short'), null); // too short to be a bare id
});

// ---------------------------------------------------------------------------
// extractPlaylistId
// ---------------------------------------------------------------------------

test('extractPlaylistId: pulls the list= param from a playlist URL', () => {
  assert.equal(
    extractPlaylistId('https://www.youtube.com/playlist?list=PLabcdefghij'),
    'PLabcdefghij'
  );
});

test('extractPlaylistId: pulls the list= param from a watch URL with playlist', () => {
  assert.equal(
    extractPlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij'),
    'PLabcdefghij'
  );
});

test('extractPlaylistId: returns null when no list param is present', () => {
  assert.equal(extractPlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('extractPlaylistId: invalid input returns null', () => {
  assert.equal(extractPlaylistId(''), null);
  assert.equal(extractPlaylistId(null), null);
});

// ---------------------------------------------------------------------------
// isMillisecondOffsets (offset-unit heuristic)
// ---------------------------------------------------------------------------

test('isMillisecondOffsets: detects millisecond-scale offsets via median gap', () => {
  const msOffsets = [0, 2000, 4500, 7000, 9800];
  assert.equal(isMillisecondOffsets(msOffsets), true);
});

test('isMillisecondOffsets: leaves second-scale offsets alone', () => {
  const secOffsets = [0, 2, 4.5, 7, 9.8];
  assert.equal(isMillisecondOffsets(secOffsets), false);
});

test('isMillisecondOffsets: single millisecond-scale offset detected via magnitude check', () => {
  assert.equal(isMillisecondOffsets([5000]), true);
});

test('isMillisecondOffsets: single second-scale offset detected via magnitude check', () => {
  assert.equal(isMillisecondOffsets([12]), false);
});

test('isMillisecondOffsets: empty/invalid input returns false', () => {
  assert.equal(isMillisecondOffsets([]), false);
  assert.equal(isMillisecondOffsets(null), false);
  assert.equal(isMillisecondOffsets(undefined), false);
});

test('isMillisecondOffsets: is resilient to a single anomalous long pause (median, not mean)', () => {
  // Second-scale offsets with one huge gap (e.g. a long pause) should still
  // be classified correctly because we use the median, not the mean.
  const secOffsetsWithPause = [0, 2, 4, 500, 502, 504];
  assert.equal(isMillisecondOffsets(secOffsetsWithPause), false);
});

// ---------------------------------------------------------------------------
// fetchWithRetry / isPermanentFetchError (retry-with-backoff logic)
// ---------------------------------------------------------------------------

test('isPermanentFetchError: recognizes disabled/unavailable-style messages as permanent', () => {
  assert.equal(isPermanentFetchError(new Error('Transcript is disabled on this video (abc)')), true);
  assert.equal(isPermanentFetchError(new Error('No transcripts are available for this video')), true);
  assert.equal(isPermanentFetchError(new Error('The video is no longer available')), true);
  assert.equal(isPermanentFetchError(new Error('Impossible to retrieve Youtube video ID.')), true);
});

test('isPermanentFetchError: treats generic/network-style errors as transient', () => {
  assert.equal(isPermanentFetchError(new Error('fetch failed')), false);
  assert.equal(isPermanentFetchError(new Error('ECONNRESET')), false);
  assert.equal(isPermanentFetchError(new TypeError('Network request failed')), false);
  assert.equal(isPermanentFetchError(null), false);
});

test('fetchWithRetry: succeeds immediately on first attempt without retrying', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return ['ok'];
  };
  const result = await fetchWithRetry(fetcher, 'vid', undefined, [0, 0]);
  assert.deepEqual(result, ['ok']);
  assert.equal(calls, 1);
});

test('fetchWithRetry: retries on transient failures and eventually returns', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls < 3) throw new Error('fetch failed');
    return ['recovered'];
  };
  const result = await fetchWithRetry(fetcher, 'vid', undefined, [0, 0]);
  assert.deepEqual(result, ['recovered']);
  assert.equal(calls, 3); // 2 failures + 1 success = 3 attempts total
});

test('fetchWithRetry: gives up after exhausting all retries and throws the last error', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error('fetch failed permanently transient-style');
  };
  await assert.rejects(
    () => fetchWithRetry(fetcher, 'vid', undefined, [0, 0]),
    /fetch failed permanently transient-style/
  );
  assert.equal(calls, 3); // 1 initial attempt + 2 retries
});

test('fetchWithRetry: does not retry on a permanent failure — fails fast', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error('Transcript is disabled on this video (abc)');
  };
  await assert.rejects(
    () => fetchWithRetry(fetcher, 'vid', undefined, [0, 0]),
    /disabled/
  );
  assert.equal(calls, 1); // no wasted retries on a permanent condition
});

test('fetchWithRetry: an empty retryDelaysMs array means a single attempt, no retries', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error('fetch failed');
  };
  await assert.rejects(() => fetchWithRetry(fetcher, 'vid', undefined, []));
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// fetchTranscript: retry integration via dependency injection (no network)
// ---------------------------------------------------------------------------

test('fetchTranscript: uses opts.primaryFetcher and retries transient failures before returning', async () => {
  let calls = 0;
  const primaryFetcher = async () => {
    calls += 1;
    if (calls < 2) throw new Error('fetch failed');
    return [{ text: 'hello', offset: 0 }];
  };
  const segments = await fetchTranscript('dQw4w9WgXcQ', {
    primaryFetcher,
    retryDelaysMs: [0, 0],
  });
  assert.equal(segments.length, 1);
  assert.equal(calls, 2);
});

// NOTE: fetchTranscript's yt-dlp fallback path is intentionally NOT exercised
// via integration tests here — it would spawn a real yt-dlp process and hit
// the network. The "no wasted retries on a permanent error" behavior is
// already fully covered above at the fetchWithRetry unit level.

// ---------------------------------------------------------------------------
// extractPlaylist: allowed-host validation (rejects before any yt-dlp spawn,
// so these are network-free)
// ---------------------------------------------------------------------------

test('extractPlaylist: rejects a non-YouTube host', async () => {
  await assert.rejects(
    () => extractPlaylist('https://evil.example.com/playlist?list=PLabcdefghij'),
    /must be a YouTube URL/
  );
});

test('extractPlaylist: rejects a YouTube-lookalike host', async () => {
  await assert.rejects(
    () => extractPlaylist('https://youtube.com.evil.example.com/playlist?list=PLabcdefghij'),
    /must be a YouTube URL/
  );
});

test('extractPlaylist: rejects an unparsable URL', async () => {
  // Starts with "https://" and contains "youtube" so it is NOT re-wrapped
  // into a synthetic playlist URL — it goes straight to URL parsing, which
  // fails because of the invalid port.
  await assert.rejects(
    () => extractPlaylist('https://youtube.com:notaport/playlist?list=x'),
    /not a valid URL/
  );
});

test('extractPlaylist: null/empty input resolves to an empty result without throwing', async () => {
  assert.deepEqual(await extractPlaylist(null), { playlistTitle: null, videos: [] });
  assert.deepEqual(await extractPlaylist(''), { playlistTitle: null, videos: [] });
});
