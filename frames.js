import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const YTDLP_JS_RUNTIME = process.env.ECHO_YTDLP_JS_RUNTIME ?? 'node';
const YTDLP_JS_RUNTIME_ARGS = YTDLP_JS_RUNTIME ? ['--js-runtimes', YTDLP_JS_RUNTIME] : [];

/**
 * Extract a small set of deduplicated scene-change frames from a YouTube
 * video, for feeding into a multimodal digest. Downloads a low-res (<=480p)
 * copy of the video via yt-dlp, then uses ffmpeg's scene-detection filter to
 * pick frames where the picture changes meaningfully.
 *
 * @param {string} videoId
 * @param {{
 *   maxFrames?: number, minFrames?: number, maxMinutes?: number,
 *   sceneThreshold?: number, timeoutMs?: number,
 *   ffmpegPath?: string, ytDlpPath?: string, signal?: AbortSignal
 * }} [opts]
 * @returns {Promise<{ dir: string, frames: { path: string, offsetSec: number|null }[], count: number }>}
 */
export async function extractFrames(videoId, opts = {}) {
  const maxFrames = opts.maxFrames ?? 24;
  const minFrames = opts.minFrames ?? 6;
  const maxMinutes = opts.maxMinutes ?? 90;
  const sceneThreshold = opts.sceneThreshold ?? 0.30;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const signal = opts.signal;

  const ytdlp = opts.ytDlpPath || process.env.ECHO_YTDLP || 'yt-dlp';
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || 'ffmpeg';

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-frames-'));

  try {
    // Duration guard — cheap metadata-only lookup, don't hard-fail if it
    // can't be parsed (some videos/streams don't report a clean duration).
    try {
      const { stdout } = await execFileAsync(ytdlp, [
        ...YTDLP_JS_RUNTIME_ARGS,
        '--skip-download',
        '--no-warnings',
        '--print', '%(duration)s',
        videoUrl,
      ], { timeout: 30000, signal });
      const durationSec = parseFloat(String(stdout).trim());
      if (Number.isFinite(durationSec) && durationSec > maxMinutes * 60) {
        const e = new Error(
          `Video is too long (${Math.round(durationSec / 60)} min) for frame extraction; ` +
          `limit is ${maxMinutes} min.`
        );
        e.echoCode = 'VIDEO_TOO_LONG';
        e.hint = `Frame extraction is limited to videos under ${maxMinutes} minutes.`;
        throw e;
      }
    } catch (err) {
      if (err.echoCode === 'VIDEO_TOO_LONG') throw err;
      // Ignore duration-probe failures — proceed to download.
    }

    // Download a small, low-resolution copy of the video.
    await execFileAsync(ytdlp, [
      ...YTDLP_JS_RUNTIME_ARGS,
      '-f', 'bv*[height<=480]/best[height<=480]',
      '--no-warnings',
      '-o', path.join(dir, 'video.%(ext)s'),
      videoUrl,
    ], { timeout: timeoutMs, signal });

    const videoFile = await findVideoFile(dir);
    if (!videoFile) {
      const e = new Error('yt-dlp did not produce a video file.');
      e.echoCode = 'FRAMES_FAILED';
      throw e;
    }

    let { frames, offsets } = await runSceneExtraction(
      ffmpeg, videoFile, dir, sceneThreshold, timeoutMs, signal
    );

    if (frames.length < minFrames) {
      // Retry once with a lower scene threshold to surface more frames.
      await clearFrameFiles(dir);
      ({ frames, offsets } = await runSceneExtraction(
        ffmpeg, videoFile, dir, 0.15, timeoutMs, signal
      ));
    }

    if (frames.length < minFrames) {
      // Scene detection still isn't yielding enough frames (e.g. static
      // slideshow-style video) — fall back to a fixed-interval sample.
      await clearFrameFiles(dir);
      let durationSec = null;
      try {
        const { stdout } = await execFileAsync(ytdlp, [
          ...YTDLP_JS_RUNTIME_ARGS,
          '--skip-download',
          '--no-warnings',
          '--print', '%(duration)s',
          videoUrl,
        ], { timeout: 30000, signal });
        const parsed = parseFloat(String(stdout).trim());
        if (Number.isFinite(parsed)) durationSec = parsed;
      } catch {
        // ignore — fall back to a conservative interval below
      }
      const intervalSec = durationSec
        ? Math.max(1, Math.floor(durationSec / maxFrames))
        : 5;
      ({ frames, offsets } = await runIntervalExtraction(
        ffmpeg, videoFile, dir, intervalSec, timeoutMs, signal
      ));
    }

    // Cap to maxFrames using content-aware selection: pick the most
    // detail-rich frame per time window instead of an even-spaced subset.
    // See `selectDetailFrames` for the file-size-as-detail-proxy heuristic.
    if (frames.length > maxFrames) {
      const { kept, keptOffsets, toDelete } = await selectDetailFrames(frames, offsets, maxFrames);
      await Promise.all(toDelete.map((f) => fs.rm(f, { force: true }).catch(() => {})));
      frames = kept;
      offsets = keptOffsets;
    }

    // Renumber the surviving frames to a contiguous frame-001.jpg.. sequence.
    // Capping above can delete interior frames (leaving gaps like 001, 005,
    // 010), but callers — and the CLI digest prompt, which tells the model to
    // read "frame-001 through frame-0NN" — assume a gapless run. `frames` is
    // already in chronological order and `offsets` is aligned by index.
    const finalPaths = await renumberContiguous(dir, frames);
    const result = finalPaths.map((filePath, i) => ({
      path: filePath,
      offsetSec: i < offsets.length ? offsets[i] : null,
    }));

    return { dir, frames: result, count: result.length };
  } catch (err) {
    await cleanupFrames(dir);
    throw err;
  }
}

/** Find the yt-dlp-produced `video.*` file in dir. Returns null if none found. */
async function findVideoFile(dir) {
  const entries = await fs.readdir(dir);
  const match = entries.find((name) => name.startsWith('video.'));
  return match ? path.join(dir, match) : null;
}

/** Remove any previously-produced frame-*.jpg files from dir (between retry attempts). */
async function clearFrameFiles(dir) {
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries
      .filter((name) => name.startsWith('frame-') && name.endsWith('.jpg'))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => {}))
  );
}

/**
 * Read each candidate frame's file size in bytes. At the fixed `-q:v 3`
 * JPEG quality used by both extraction passes, byte size is a cheap proxy
 * for on-screen visual detail: text/chart/UI slides have lots of high-
 * frequency edge content and compress LARGE; smooth talking-head/bokeh
 * shots compress to a medium size; near-blank transition slides (solid
 * color, fade frames) compress TINY. So "biggest file in this time
 * window" is a decent stand-in for "most information-dense frame".
 */
async function statSizes(paths) {
  const sizes = await Promise.all(
    paths.map(async (p) => {
      try {
        const st = await fs.stat(p);
        return st.size;
      } catch {
        return 0;
      }
    })
  );
  return sizes;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Bin `candidates` (indices into frames/offsets/sizes) into `binCount` bins
 * by offset (or, if offsets are unusable, by array index), and pick the
 * largest-size candidate per bin. Returns an array of chosen indices, in
 * bin order (which is also chronological order).
 */
function pickByBins(indices, offsets, sizes, binCount) {
  const usableOffsets = indices.every((i) => Number.isFinite(offsets[i]));
  let minKey, maxKey;
  const keyOf = (i) => (usableOffsets ? offsets[i] : i);

  if (usableOffsets) {
    minKey = Math.min(...indices.map(keyOf));
    maxKey = Math.max(...indices.map(keyOf));
  } else {
    minKey = 0;
    maxKey = indices.length - 1;
  }

  const span = maxKey - minKey;
  const bins = new Map(); // binIndex -> best candidate index
  for (const i of indices) {
    const key = keyOf(i);
    let binIdx;
    if (span <= 0) {
      // Degenerate span (all offsets equal, or a single candidate) — spread
      // by rank within the pool instead of dividing by zero.
      binIdx = Math.min(binCount - 1, Math.floor((indices.indexOf(i) / indices.length) * binCount));
    } else {
      binIdx = Math.min(binCount - 1, Math.floor(((key - minKey) / span) * binCount));
    }
    const current = bins.get(binIdx);
    if (current === undefined || sizes[i] > sizes[current]) {
      bins.set(binIdx, i);
    }
  }

  return [...bins.values()].sort((a, b) => a - b);
}

/**
 * Content-aware down-selection to `maxFrames`: bins the candidate pool into
 * `maxFrames` temporal windows and keeps the largest (most detail-rich)
 * frame per window, preferring to drop near-blank frames. Returns the
 * kept frame paths/offsets (chronologically ordered) plus the paths to
 * delete.
 */
async function selectDetailFrames(frames, offsets, maxFrames) {
  const sizes = await statSizes(frames);
  const med = median(sizes);
  const blankFloor = Math.max(8 * 1024, 0.35 * med);

  const allIdx = frames.map((_, i) => i);
  let selected = pickByBins(allIdx, offsets, sizes, maxFrames);

  // Fill any remaining slots (empty bins) from the highest-size unselected
  // non-blank candidates, until we hit maxFrames or run out.
  if (selected.length < maxFrames) {
    const selectedSet = new Set(selected);
    const remainder = allIdx
      .filter((i) => !selectedSet.has(i) && sizes[i] >= blankFloor)
      .sort((a, b) => sizes[b] - sizes[a]);
    for (const i of remainder) {
      if (selected.length >= maxFrames) break;
      selected.push(i);
    }
  }

  // Prefer non-blank: swap out any selected frame below blankFloor for the
  // best unused non-blank candidate, if one exists.
  const selectedSet = new Set(selected);
  let unused = allIdx
    .filter((i) => !selectedSet.has(i) && sizes[i] >= blankFloor)
    .sort((a, b) => sizes[b] - sizes[a]);
  for (let k = 0; k < selected.length; k++) {
    const i = selected[k];
    if (sizes[i] < blankFloor && unused.length > 0) {
      const replacement = unused.shift();
      selectedSet.delete(i);
      selectedSet.add(replacement);
      selected[k] = replacement;
    }
  }

  selected.sort((a, b) => a - b);

  const kept = selected.map((i) => frames[i]);
  const keptOffsets = selected.map((i) => offsets[i]);
  const keptSet = new Set(selected);
  const toDelete = allIdx.filter((i) => !keptSet.has(i)).map((i) => frames[i]);

  return { kept, keptOffsets, toDelete };
}

/**
 * Parse ffmpeg's `showinfo` stderr output for `pts_time:<seconds>` — one
 * per output frame, in emission order — which lines up 1:1 with the
 * frame-NNN.jpg files ffmpeg writes (also in order).
 */
function parsePtsTimes(stderr) {
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) times.push(v);
  }
  return times;
}

/**
 * Rename the given frame files (in chronological order) to a contiguous
 * frame-001.jpg.. sequence. Two-phase (via `xtmp-` names that don't match the
 * `frame-`/`video.` filters) so a rename never clobbers a not-yet-moved target.
 * Returns the final paths in order.
 */
async function renumberContiguous(dir, orderedPaths) {
  const tmp = [];
  for (let i = 0; i < orderedPaths.length; i++) {
    const t = path.join(dir, `xtmp-${i}.jpg`);
    await fs.rename(orderedPaths[i], t);
    tmp.push(t);
  }
  const finalPaths = [];
  for (let i = 0; i < tmp.length; i++) {
    const f = path.join(dir, `frame-${String(i + 1).padStart(3, '0')}.jpg`);
    await fs.rename(tmp[i], f);
    finalPaths.push(f);
  }
  return finalPaths;
}

/** List frame-*.jpg files in dir, sorted by filename (which sorts by frame order). */
async function listFrameFiles(dir) {
  const entries = await fs.readdir(dir);
  return entries
    .filter((name) => name.startsWith('frame-') && name.endsWith('.jpg'))
    .sort()
    .map((name) => path.join(dir, name));
}

async function runSceneExtraction(ffmpeg, videoFile, dir, sceneThreshold, timeoutMs, signal) {
  let stderr = '';
  try {
    const res = await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-i', videoFile,
      '-vf', `select='gt(scene,${sceneThreshold})',mpdecimate,showinfo,scale=640:-1`,
      '-fps_mode', 'vfr',
      '-q:v', '3',
      path.join(dir, 'frame-%03d.jpg'),
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64, signal });
    stderr = res.stderr || '';
  } catch (err) {
    // ffmpeg can exit non-zero while still having written some frames (and its
    // showinfo lines) to stderr — in that case use what we got. But if it wrote
    // NO frames, this is a real failure (bad args, unreadable input) and must
    // surface, not be silently swallowed as an empty "0 frames" result.
    stderr = err.stderr || '';
    const written = await listFrameFiles(dir);
    if (written.length === 0) throw err;
  }
  const offsets = parsePtsTimes(stderr);
  const frames = await listFrameFiles(dir);
  return { frames, offsets };
}

async function runIntervalExtraction(ffmpeg, videoFile, dir, intervalSec, timeoutMs, signal) {
  let stderr = '';
  try {
    const res = await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-i', videoFile,
      '-vf', `fps=1/${intervalSec},showinfo,scale=640:-1`,
      '-fps_mode', 'vfr',
      '-q:v', '3',
      path.join(dir, 'frame-%03d.jpg'),
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64, signal });
    stderr = res.stderr || '';
  } catch (err) {
    stderr = err.stderr || '';
    const written = await listFrameFiles(dir);
    if (written.length === 0) throw err;
  }
  const offsets = parsePtsTimes(stderr);
  const frames = await listFrameFiles(dir);
  return { frames, offsets };
}

/**
 * Remove the temp dir created by extractFrames. Best-effort — swallows
 * errors so cleanup never masks the real result of a caller's work.
 */
export async function cleanupFrames(dir) {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Map a raw error from extractFrames into a stable { echoCode, message, hint }
 * shape suitable for surfacing to callers/UI.
 */
export function mapFramesError(err) {
  if (!err) {
    return { echoCode: 'FRAMES_FAILED', message: 'Unknown error extracting frames.', hint: 'Could not extract frames from this video.' };
  }

  if (err.echoCode) {
    return { echoCode: err.echoCode, message: err.message, hint: err.hint || 'Could not extract frames from this video.' };
  }

  const message = err.message || String(err);
  const isFfmpeg = err.code === 'ENOENT' && /ffmpeg/i.test((err.path || '') + message);
  const isYtDlp = err.code === 'ENOENT' && /yt-dlp/i.test((err.path || '') + message);

  if (isFfmpeg) {
    return {
      echoCode: 'FFMPEG_MISSING',
      message,
      hint: 'Install ffmpeg (e.g. `winget install ffmpeg` or your package manager) — required for on-screen visual digests.',
    };
  }

  if (isYtDlp) {
    return {
      echoCode: 'YTDLP_MISSING',
      message,
      hint: 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.',
    };
  }

  if (err.code === 'ENOENT') {
    // ENOENT but couldn't tell which binary — best-effort generic hint.
    return {
      echoCode: 'FRAMES_FAILED',
      message,
      hint: 'A required binary (yt-dlp or ffmpeg) was not found on PATH.',
    };
  }

  if (err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(message)) {
    return {
      echoCode: 'FRAMES_TIMEOUT',
      message,
      hint: 'Frame extraction took too long and was stopped. Try a shorter video.',
    };
  }

  return {
    echoCode: 'FRAMES_FAILED',
    message,
    hint: 'Could not extract frames from this video.',
  };
}
