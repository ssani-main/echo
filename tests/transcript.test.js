import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVideoId,
  extractPlaylistId,
  isMillisecondOffsets,
  fetchWithRetry,
  isPermanentFetchError,
  fetchViaPackage,
  fetchTranscript,
  extractPlaylist,
  MEMBERS_ONLY_PATTERNS,
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

// ---------------------------------------------------------------------------
// fetchViaPackage: preferred-language caption selection (no network)
// Guards the P0 fix where an omitted `lang` used to return captionTracks[0]
// (an arbitrary track), silently yielding the wrong language for English audio.
// ---------------------------------------------------------------------------

test('fetchViaPackage: no lang prefers the English track over the arbitrary default', async () => {
  const calls = [];
  const transcriptFetcher = async (id, ytOpts) => {
    calls.push(ytOpts ? ytOpts.lang : '(default)');
    if (ytOpts && ytOpts.lang === 'en') return [{ text: 'hello', offset: 0, lang: 'en' }];
    return [{ text: 'marhaba', offset: 0, lang: 'ar' }];
  };
  const segs = await fetchViaPackage('vid', undefined, { transcriptFetcher });
  assert.equal(segs[0].text, 'hello');
  assert.equal(segs.langUsed, 'en');
  assert.deepEqual(calls, ['en']); // never made the unbiased default call
});

test('fetchViaPackage: no lang falls back to the default track when no English track exists', async () => {
  const calls = [];
  const transcriptFetcher = async (id, ytOpts) => {
    calls.push(ytOpts ? ytOpts.lang : '(default)');
    if (ytOpts && ytOpts.lang === 'en') throw new Error('No transcripts available in en');
    return [{ text: 'hola', offset: 0, lang: 'es' }];
  };
  const segs = await fetchViaPackage('vid', undefined, { transcriptFetcher });
  assert.equal(segs[0].text, 'hola'); // non-English video does NOT regress
  assert.equal(segs.langUsed, 'es');
  assert.deepEqual(calls, ['en', '(default)']);
});

test('fetchViaPackage: no lang falls back when the preferred-language call returns empty', async () => {
  const calls = [];
  const transcriptFetcher = async (id, ytOpts) => {
    calls.push(ytOpts ? ytOpts.lang : '(default)');
    if (ytOpts && ytOpts.lang === 'en') return [];
    return [{ text: 'ciao', offset: 0, lang: 'it' }];
  };
  const segs = await fetchViaPackage('vid', undefined, { transcriptFetcher });
  assert.equal(segs[0].text, 'ciao');
  assert.equal(segs.langUsed, 'it');
  assert.deepEqual(calls, ['en', '(default)']);
});

test('fetchViaPackage: an explicit lang makes exactly one call and never falls back', async () => {
  const calls = [];
  const transcriptFetcher = async (id, ytOpts) => {
    calls.push(ytOpts ? ytOpts.lang : '(default)');
    return [{ text: 'bonjour', offset: 0, lang: 'fr' }];
  };
  const segs = await fetchViaPackage('vid', 'fr', { transcriptFetcher });
  assert.equal(segs[0].text, 'bonjour');
  assert.equal(segs.langUsed, 'fr');
  assert.deepEqual(calls, ['fr']); // explicit request honoured exactly, no preference logic
});

// NOTE: fetchTranscript's yt-dlp fallback path is intentionally NOT exercised
// via integration tests here — it would spawn a real yt-dlp process and hit
// the network. The "no wasted retries on a permanent error" behavior is
// already fully covered above at the fetchWithRetry unit level.

// ---------------------------------------------------------------------------
// fetchTranscript: Whisper-fallback failures are surfaced, not swallowed.
// Regression guard: a Whisper attempt that throws used to be silently caught,
// leaving the user with the generic no_captions card (which wrongly nudges
// "enable Whisper in Settings" when it is already on) and hiding the real
// blocker. Now the failure's cause is reported via reason: 'whisper_failed'.
// ---------------------------------------------------------------------------

test('fetchTranscript: a Whisper-fallback failure surfaces its cause (ffmpeg) instead of the no_captions card', async () => {
  const whisperErr = new Error('spawn ffmpeg ENOENT');
  whisperErr.echoCode = 'FFMPEG_MISSING';
  whisperErr.hint = 'Install ffmpeg — required to convert audio for Whisper.';
  await assert.rejects(
    fetchTranscript('vid', {
      primaryFetcher: async () => { throw new Error('no captions'); },
      captionFallback: async () => { throw new Error('yt-dlp: no subtitles'); },
      whisperResolver: () => ({ bin: 'whisper-cli', model: 'base' }),
      transcriber: async () => { throw whisperErr; },
      transcribe: 'fallback',
      retryDelaysMs: [],
    }),
    (e) => {
      assert.equal(e.echoCode, 'TRANSCRIPT_UNAVAILABLE');
      assert.equal(e.reason, 'whisper_failed');
      assert.equal(e.message, 'Automatic transcription needs ffmpeg');
      assert.match(e.hint, /ffmpeg/i);
      assert.match(e.detail, /Whisper transcription failed/);
      return true;
    }
  );
});

test('fetchTranscript: a generic Whisper-fallback failure (no echoCode) reports a generic whisper headline', async () => {
  await assert.rejects(
    fetchTranscript('vid', {
      primaryFetcher: async () => { throw new Error('no captions'); },
      captionFallback: async () => { throw new Error('yt-dlp: no subtitles'); },
      whisperResolver: () => ({ bin: 'whisper-cli', model: 'base' }),
      transcriber: async () => { throw new Error('some model crash'); },
      transcribe: 'fallback',
      retryDelaysMs: [],
    }),
    (e) => {
      assert.equal(e.reason, 'whisper_failed');
      assert.equal(e.message, "Whisper couldn't transcribe this video");
      return true;
    }
  );
});

test('fetchTranscript: with Whisper off, an unclassifiable failure still yields the no_captions card', async () => {
  await assert.rejects(
    fetchTranscript('vid', {
      primaryFetcher: async () => { throw new Error('no captions'); },
      captionFallback: async () => { throw new Error('yt-dlp: no subtitles'); },
      whisperResolver: () => ({ bin: 'whisper-cli', model: 'base' }),
      transcriber: async () => { throw new Error('should not be called'); },
      transcribe: 'off',
      retryDelaysMs: [],
    }),
    (e) => {
      assert.equal(e.echoCode, 'TRANSCRIPT_UNAVAILABLE');
      assert.equal(e.reason, 'no_captions');
      return true;
    }
  );
});

test('fetchTranscript: a missing subtitle FILE (fs ENOENT) is NOT misread as a missing yt-dlp binary', async () => {
  // Regression: yt-dlp runs fine but the video has no captions, so readFile of
  // the (never-written) .json3 throws a bare fs ENOENT. That used to short to
  // YTDLP_MISSING ("Install yt-dlp") AND skip the Whisper fallback.
  const fsEnoent = new Error("ENOENT: no such file or directory, open '/tmp/x.en.json3'");
  fsEnoent.code = 'ENOENT';
  fsEnoent.syscall = 'open';
  fsEnoent.path = '/tmp/x.en.json3';
  await assert.rejects(
    fetchTranscript('vid', {
      primaryFetcher: async () => { throw new Error('Transcript is disabled on this video'); },
      captionFallback: async () => { throw fsEnoent; },
      transcribe: 'off',
      retryDelaysMs: [],
    }),
    (e) => {
      assert.equal(e.echoCode, 'TRANSCRIPT_UNAVAILABLE');
      assert.equal(e.reason, 'no_captions');
      assert.notEqual(e.reason, 'ytdlp_missing');
      return true;
    }
  );
});

test('fetchTranscript: a genuine spawn ENOENT (yt-dlp binary absent) still reports ytdlp_missing', async () => {
  const spawnEnoent = new Error('spawn yt-dlp ENOENT');
  spawnEnoent.code = 'ENOENT';
  spawnEnoent.syscall = 'spawn yt-dlp';
  spawnEnoent.path = 'yt-dlp';
  await assert.rejects(
    fetchTranscript('vid', {
      primaryFetcher: async () => { throw new Error('Transcript is disabled on this video'); },
      captionFallback: async () => { throw spawnEnoent; },
      transcribe: 'off',
      retryDelaysMs: [],
    }),
    (e) => {
      assert.equal(e.echoCode, 'YTDLP_MISSING');
      assert.equal(e.reason, 'ytdlp_missing');
      return true;
    }
  );
});

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

// ---------------------------------------------------------------------------
// MEMBERS_ONLY_PATTERNS — the classification hinge for the inbox "Membership"
// badge. fetchTranscript() tests these patterns against yt-dlp's stderr/message
// to decide whether to raise echoCode MEMBERS_ONLY vs. the generic
// TRANSCRIPT_UNAVAILABLE. A false positive here mislabels an ordinary broken
// video (deleted, private, age-gated, captions-disabled) as "Membership".
// ---------------------------------------------------------------------------

test('MEMBERS_ONLY_PATTERNS: matches verbatim yt-dlp members-only stderr', () => {
  const msg =
    "ERROR: [youtube] abc123: Join this channel to get access to members-only " +
    "content like this video, and other exclusive perks.";
  assert.ok(
    MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    'expected at least one pattern to match the standard members-only message'
  );
});

test('MEMBERS_ONLY_PATTERNS: matches the tiered-membership variant wording', () => {
  const msg =
    "ERROR: [youtube] abc123: Join this channel's members on level Tier 2 to " +
    "get access to members-only content like this video.";
  assert.ok(
    MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    "expected at least one pattern to match the \"channel's members on level\" tiered wording"
  );
});

test('MEMBERS_ONLY_PATTERNS: does NOT match "Video unavailable" (deleted/private/invalid all collapse to this)', () => {
  const msg = 'ERROR: [youtube] abc123: Video unavailable';
  assert.ok(
    !MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    'must not mislabel a generic unavailable video as members-only'
  );
});

test('MEMBERS_ONLY_PATTERNS: does NOT match "Private video" sign-in message', () => {
  const msg =
    "ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video";
  assert.ok(
    !MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    'must not mislabel a private video as members-only'
  );
});

test('MEMBERS_ONLY_PATTERNS: does NOT match "Sign in to confirm your age"', () => {
  const msg = 'ERROR: [youtube] abc123: Sign in to confirm your age';
  assert.ok(
    !MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    'must not mislabel an age-gated video as members-only'
  );
});

test('MEMBERS_ONLY_PATTERNS: does NOT match a captions-disabled message', () => {
  const msg = 'Transcript is disabled on this video';
  assert.ok(
    !MEMBERS_ONLY_PATTERNS.some((p) => p.test(msg)),
    'must not mislabel a captions-disabled video as members-only'
  );
});
