// whisper.js — local whisper.cpp transcription. Fills the caption dead-end
// (`fallback`) or upgrades transcript quality (`always`). Local/desktop only —
// the server forces this OFF in web mode. Spawns a prebuilt whisper-cli binary
// (env/opts-configured) — no npm dependency, no C++ toolchain.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFilePath, isModelPresent, DEFAULT_WHISPER_MODEL } from './whisperModel.js';

const execFileAsync = promisify(execFile);

// Directory of this module — used to resolve the vendored binary relative to the
// code, NOT the cwd (the Tauri sidecar and `npm start` have different cwds).
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// yt-dlp 2026.06.09+ silently drops formats without a JS runtime (see transcript.js).
const YTDLP_JS_RUNTIME = process.env.ECHO_YTDLP_JS_RUNTIME ?? 'node';
const YTDLP_JS_RUNTIME_ARGS = YTDLP_JS_RUNTIME ? ['--js-runtimes', YTDLP_JS_RUNTIME] : [];

const DEFAULT_MAX_MINUTES = Number(process.env.ECHO_WHISPER_MAX_MINUTES) || 180;

// Vendored binary (P3): shipped in the repo / Tauri bundle per platform+arch, e.g.
// vendor/whisper/linux-x64/whisper-cli. Resolved module-relative so it works the same
// under `npm start` and the Tauri sidecar. Only populated platforms exist on disk;
// absent ones (e.g. darwin — no prebuilt whisper-cli CLI) fail existsSync in the
// callers and the feature degrades cleanly to off.
function vendoredBin() {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const platArch = `${process.platform}-${process.arch}`;
  return path.join(MODULE_DIR, 'vendor', 'whisper', platArch, name);
}
// P2: resolve the selected/default model from the download cache if fully present.
function cacheModel(opts = {}) {
  const name = opts.modelName || process.env.ECHO_WHISPER_DEFAULT_MODEL || DEFAULT_WHISPER_MODEL;
  return isModelPresent(name) ? modelFilePath(name) : null;
}

// Resolve the binary + model, cheapest/most-explicit first. Returns null (feature OFF)
// unless BOTH exist on disk — this IS the "is Whisper present?" gate.
export function resolveWhisper(opts = {}) {
  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  const modelPath = opts.modelPath || process.env.ECHO_WHISPER_MODEL || cacheModel(opts);
  if (!binPath || !modelPath) return null;
  if (!existsSync(binPath) || !existsSync(modelPath)) return null;
  return { binPath, modelPath };
}

// Binary-only presence check (independent of any model) — for /api/whisper/status.
export function resolveWhisperBinary(opts = {}) {
  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  return binPath && existsSync(binPath) ? binPath : null;
}

/**
 * Resolve the Silero VAD model, which is what turns Voice Activity Detection
 * on. There is no separate on/off flag: pointing at a model IS the opt-in, and
 * with no model resolved the transcription runs exactly as it did before.
 *
 * VAD makes whisper skip non-speech instead of decoding it, so the saving is
 * proportional to how much of the audio isn't speech — music intros, applause,
 * long pauses. It also removes whisper's best-known failure mode, which is
 * hallucinating text over silence.
 *
 * It is opt-in rather than default because the trade is not free in both
 * directions: if the detector scores quiet speech below its threshold, that
 * audio is never transcribed at all, and silently missing a sentence is worse
 * for Echo than transcribing a silent one. Verify it against your own audio
 * before leaving it on — see WHISPER.md.
 *
 * @param {{ vadModelPath?: string }} [opts]
 * @returns {string|null} path to the VAD model, or null when VAD is off
 */
export function resolveVadModel(opts = {}) {
  const vadPath = opts.vadModelPath || process.env.ECHO_WHISPER_VAD_MODEL || null;
  return vadPath && existsSync(vadPath) ? vadPath : null;
}

/**
 * Build the whisper-cli argument list. Pure, so the flag contract is unit
 * testable without spawning anything (nothing in the test suite ever runs the
 * real binary — see the "tests miss runtime" note in CLAUDE.md).
 *
 * Deliberately absent: any flag that buys speed by giving up accuracy.
 * `-bs`/`-bo` (beam size / best-of, both 5 by default) and `-nf` (drop the
 * temperature fallback) would all be faster and all decode worse, and `-p`
 * (parallel processors) splits the audio into independently-decoded chunks,
 * which costs accuracy at every boundary. Flash attention is already on by
 * default in whisper.cpp 1.9.1, so there is nothing to add there.
 *
 * @param {{ modelPath: string, wavPath: string, whisperLang: string,
 *           threads: number, outPrefix: string, vadModelPath?: string|null }} spec
 * @returns {string[]}
 */
export function buildWhisperArgs(spec) {
  const { modelPath, wavPath, whisperLang, threads, outPrefix, vadModelPath } = spec;

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', whisperLang,
    '-t', String(threads),
    '--print-progress',
    '-oj', '-of', outPrefix,
  ];

  // whisper.cpp maps VAD-segment timestamps back onto the original timeline,
  // so offsets stay absolute and the timecoded view keeps deep-linking to the
  // right second. Its own defaults (0.5 threshold, 30 ms speech padding,
  // 100 ms min silence) are the conservative end, so they are left alone.
  if (vadModelPath) args.push('--vad', '-vm', vadModelPath);

  return args;
}

// Pure mapper: whisper.cpp `-oj` JSON -> Echo's [{text, offset}] (offset in SECONDS).
// whisper.cpp emits `transcription[].offsets` in MILLISECONDS (verified 2026-07-18)
// -> divide by 1000. Stamps langUsed + source non-enumerably, matching the caption path.
export function mapWhisperJson(json) {
  const segs = (json && json.transcription) || [];
  const out = [];
  for (const s of segs) {
    const text = String((s && s.text) || '').trim();
    if (!text) continue;
    const fromMs = s.offsets && Number(s.offsets.from);
    const offset = Number.isFinite(fromMs) ? fromMs / 1000 : 0;
    out.push({ text, offset });
  }
  const langUsed = (json && json.result && json.result.language) || undefined;
  Object.defineProperty(out, 'langUsed', { value: langUsed, enumerable: false });
  Object.defineProperty(out, 'source', { value: 'whisper', enumerable: false });
  return out;
}

// Best-effort progress callback: server threads this to an SSE channel so the
// browser can show a real % + elapsed timer. Never let a progress handler throw
// into the transcription pipeline.
function reportProgress(opts, phase, pct, extra = null) {
  if (typeof opts.onProgress === 'function') {
    try { opts.onProgress(extra ? { phase, pct, ...extra } : { phase, pct }); }
    catch { /* progress is best-effort */ }
  }
}

// Spawn a child and STREAM its output line-by-line to `onStderr` instead of
// buffering it. This is what lets long transcripts work at all: whisper-cli
// echoes every recognised line to stderr, which overflowed execFile's 64 MB
// maxBuffer on ~100-min videos and got the process killed (a spurious
// WHISPER_FAILED). Streaming also gives us live progress and honours abort.
// Only the last few KB of output are retained, for error messages.
function runStreaming(cmd, args, { env, signal, timeoutMs, onStderr, lowerPriority } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env, windowsHide: true });
    } catch (err) { reject(err); return; }

    // Yield CPU to the rest of the machine — transcription is a background chore,
    // not an interactive one. Best-effort; ignored if the OS refuses.
    if (lowerPriority && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted — fine */ }
    }

    let tail = '';
    let timedOut = false;
    const onData = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      if (onStderr) { try { onStderr(s); } catch { /* parser is best-effort */ } }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const to = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    const onAbort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) child.kill('SIGTERM');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (to) clearTimeout(to);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code, sig) => {
      cleanup();
      if (code === 0) { resolve({ tail }); return; }
      const err = new Error(`${path.basename(String(cmd))} exited with code ${code}${sig ? ` (${sig})` : ''}: ${tail.slice(-500)}`);
      err.exitCode = code;
      err.stderr = tail;
      if (timedOut) { err.killed = true; err.signal = 'SIGTERM'; }
      if (signal && signal.aborted) { err.name = 'AbortError'; err.code = 'ABORT_ERR'; }
      reject(err);
    });
  });
}

/**
 * Resolve the binary + model, or throw the specific reason it could not be.
 * Shared by both entry points so a YouTube job and a local-file job fail
 * identically when Whisper isn't set up.
 */
function requireWhisper(opts) {
  const resolved = resolveWhisper(opts);
  if (resolved) return resolved;

  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  if (!binPath || !existsSync(binPath)) {
    const e = new Error('Whisper transcription is not available on this platform.');
    e.echoCode = 'WHISPER_MISSING';
    e.hint = 'Echo ships whisper-cli for Linux and Windows on x64. On other platforms, '
      + 'point ECHO_WHISPER at a whisper-cli binary to enable it.';
    throw e;
  }
  // Points at the Settings UI, not the env var: since P2 there IS a model
  // picker with an on-demand download, and a user who just picked a file has
  // no reason to learn about ECHO_WHISPER_MODEL to get past this.
  const e = new Error('No Whisper model downloaded yet.');
  e.echoCode = 'WHISPER_MODEL_MISSING';
  e.hint = 'Open Settings → Transcription and download a model (Base is about 60 MB). '
    + 'Or set ECHO_WHISPER_MODEL to a ggml model file you already have.';
  throw e;
}

/** Threads to give whisper-cli. See WHISPER.md for why this is 75% and not all. */
function whisperThreads(opts) {
  return opts.threads
    || Number(process.env.ECHO_WHISPER_THREADS)
    || Math.max(1, Math.round(os.cpus().length * 0.75));
}

/**
 * Transcribe a prepared 16 kHz mono s16le WAV. This is the half of the
 * pipeline that has nothing to do with where the audio came from — both the
 * YouTube path and the local-file path converge here, so they cannot drift in
 * flags, timeout policy, or error mapping.
 *
 * @param {string} wavPath
 * @param {{ binPath: string, modelPath: string, dir: string, durationSec?: number }} ctx
 * @param {object} opts
 * @returns {Promise<Array<{text:string, offset:number}>>}
 */
async function transcribeWav(wavPath, ctx, opts) {
  const { binPath, modelPath, dir, durationSec = 0 } = ctx;
  const whisperLang = opts.whisperLang || 'auto';

  // On Linux the .so libs live beside the binary, so LD_LIBRARY_PATH must
  // include its dir (harmless on Windows/macOS).
  const outPrefix = path.join(dir, 'out');
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [path.dirname(binPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };

  // Work is legitimately minutes-long; derive a generous timeout from duration.
  const derivedMs = Number.isFinite(durationSec) && durationSec > 0
    ? Math.max(30 * 60_000, Math.ceil(durationSec * 1500) + 60_000)
    : 60 * 60_000;
  const timeoutMs = opts.timeoutMs || Number(process.env.ECHO_WHISPER_TIMEOUT_MS) || derivedMs;

  reportProgress(opts, 'transcribe', 0);
  let lastTr = -1;
  await runStreaming(binPath, buildWhisperArgs({
    modelPath,
    wavPath,
    whisperLang,
    threads: whisperThreads(opts),
    outPrefix,
    vadModelPath: resolveVadModel(opts),
  }), {
    env,
    signal: opts.signal,
    timeoutMs,
    lowerPriority: true,
    onStderr: (chunk) => {
      const ms = chunk.match(/progress\s*=\s*(\d+)%/g);
      if (!ms) return;
      const pct = Math.min(99, parseInt(/(\d+)%/.exec(ms[ms.length - 1])[1], 10));
      if (pct > lastTr) { lastTr = pct; reportProgress(opts, 'transcribe', pct); }
    },
  });
  reportProgress(opts, 'transcribe', 100);

  const raw = await fs.readFile(`${outPrefix}.json`, 'utf8');
  const segments = mapWhisperJson(JSON.parse(raw));
  if (segments.length === 0) {
    const e = new Error('Whisper produced an empty transcript.');
    e.echoCode = 'WHISPER_FAILED';
    e.hint = 'The audio may be silent or unintelligible.';
    throw e;
  }
  return segments;
}

/**
 * Which model should actually run, given the model asked for and the language
 * YouTube reports for the video?
 *
 * Measured 2026-07-25 (see WHISPER.md): `base` is fine on English but degrades
 * badly on other languages — on an Indonesian video it rendered "niatnya bagus"
 * ("their intent is good") as "nyanyi bagus" ("sings well"), among a run of
 * mangled words. `small` renders the same passage cleanly. That is a model-size
 * artefact, not a language limit, so the fix is to use `small` when we know the
 * audio is not English.
 *
 * Deliberately conservative: it only ever upgrades `base`, never downgrades an
 * explicit `small`, and stays put when the language is unknown ('NA', which is
 * what yt-dlp reports when YouTube has no metadata). Guessing wrong here costs
 * the user ~3x the runtime, so it only acts on a definite non-English answer.
 *
 * @param {string} requested - model the caller asked for
 * @param {string|null} language - ISO code from yt-dlp, or null/'NA' if unknown
 * @returns {string} the model to use
 */
export function chooseModelForLanguage(requested, language) {
  if (requested !== 'base') return requested;
  if (!language) return requested;
  const lang = String(language).trim().toLowerCase();
  if (!lang || lang === 'na' || lang === 'none' || lang === 'undefined') return requested;
  if (lang === 'en' || lang.startsWith('en-')) return requested;
  return 'small';
}

// A refusal YouTube hands out under load and withdraws moments later, versus a
// fact about the video. Only the former is worth retrying: retrying a private
// or members-only video just makes the user wait three times as long for the
// same answer.
const TRANSIENT_DOWNLOAD_PATTERNS = [
  /HTTP Error 403/i,
  /HTTP Error 429/i,
  /HTTP Error 5\d\d/i,
  /\bthrottl/i,
  /temporar(y|ily)/i,
  /connection reset|timed out|network|ECONNRESET|ETIMEDOUT/i,
  /Unable to download (webpage|API page|video data)/i,
];

/** Is this yt-dlp failure the kind that tends to succeed on a second ask? */
export function isTransientDownloadFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false; // the user left
  if (err.killed || err.signal === 'SIGTERM') return false;                // our own timeout
  const blob = `${err.stderr || ''} ${err.message || ''}`;
  return TRANSIENT_DOWNLOAD_PATTERNS.some((p) => p.test(blob));
}

export const DEFAULT_DOWNLOAD_RETRY_DELAYS_MS = [800, 2400];

/**
 * Run the audio download, retrying only transient refusals. Mirrors the caption
 * path's fetchWithRetry so both halves of the transcript pipeline survive the
 * same weather.
 */
export async function withDownloadRetry(run, opts = {}, onRetry = null) {
  const delays = opts.downloadRetryDelaysMs !== undefined
    ? opts.downloadRetryDelaysMs
    : DEFAULT_DOWNLOAD_RETRY_DELAYS_MS;
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < delays.length && isTransientDownloadFailure(err);
      if (!canRetry) break;
      if (onRetry) { try { onRetry(0); } catch { /* progress is best-effort */ } }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  // Out of attempts. If it was transient the whole way, say so — "could not
  // transcribe this video" reads as a fact about the video and stops the user
  // trying again, which is exactly the wrong conclusion here.
  if (isTransientDownloadFailure(lastErr)) {
    const e = new Error('YouTube refused the audio download.');
    e.echoCode = 'AUDIO_DOWNLOAD_REFUSED';
    e.hint = 'YouTube throttles audio downloads under load. This is usually temporary — try again in a minute.';
    e.detail = lastErr.stderr || lastErr.message || '';
    throw e;
  }
  throw lastErr;
}

async function runWhisperPipeline(videoId, opts) {
  const { binPath, modelPath } = requireWhisper(opts);
  const ytdlp = opts.ytDlpPath || process.env.ECHO_YTDLP || 'yt-dlp';
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || null;
  const maxMinutes = opts.maxMinutes || DEFAULT_MAX_MINUTES;
  const signal = opts.signal;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Duration guard — cheap metadata probe; reject over-long audio up front.
  //    The same call also yields the video's language at no extra cost, which
  //    decides the model below.
  let durationSec = 0;
  let videoLanguage = null;
  try {
    const { stdout } = await execFileAsync(ytdlp, [
      ...YTDLP_JS_RUNTIME_ARGS, '--skip-download', '--no-warnings',
      '--print', '%(duration)s|%(language)s', videoUrl,
    ], { timeout: 30000, signal });
    const [durRaw, langRaw] = String(stdout).trim().split('|');
    videoLanguage = (langRaw || '').trim() || null;
    durationSec = parseFloat(durRaw);
    if (Number.isFinite(durationSec) && durationSec > maxMinutes * 60) {
      const e = new Error(`Audio is too long (${Math.round(durationSec / 60)} min) for transcription; limit is ${maxMinutes} min.`);
      e.echoCode = 'WHISPER_AUDIO_TOO_LONG';
      e.hint = `Whisper transcription is limited to audio under ${maxMinutes} minutes.`;
      throw e;
    }
  } catch (err) {
    if (err.echoCode === 'WHISPER_AUDIO_TOO_LONG') throw err;
    if (err.code === 'ENOENT') throw err; // yt-dlp missing -> mapped to YTDLP_MISSING
    // otherwise ignore probe failure and proceed to the download
  }

  // Now that the language is known, pick the model that can actually handle it.
  // Only ever an upgrade, only when the better model is already downloaded —
  // never a silent 190 MB download, and never a downgrade of an explicit choice.
  const requestedModel = opts.modelName || process.env.ECHO_WHISPER_DEFAULT_MODEL || DEFAULT_WHISPER_MODEL;
  let modelInUse = requestedModel;
  let modelPathInUse = modelPath;
  const better = chooseModelForLanguage(requestedModel, videoLanguage);
  if (better !== requestedModel) {
    const alt = resolveWhisper({ ...opts, modelName: better });
    // The path must actually differ before claiming an upgrade. An explicit
    // opts.modelPath or ECHO_WHISPER_MODEL pins one file, and resolveWhisper
    // returns it whatever modelName says — reporting "small" while running the
    // pinned file would put a lie in the library. An explicit pin also *is* the
    // operator's choice, so it rightly wins.
    if (alt && alt.modelPath !== modelPath) {
      modelInUse = better;
      modelPathInUse = alt.modelPath;
      reportProgress(opts, 'model', 0, { model: better, reason: `language:${videoLanguage}` });
    }
    // If the better model is not downloaded we proceed with what we have rather
    // than failing — a mediocre transcript beats no transcript.
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-'));
  try {
    // 2. Download smallest useful audio + convert to 16kHz mono s16le WAV (whisper.cpp
    //    requires exactly this PCM). -x needs a real file on disk (no `-o -`).
    const wavPath = path.join(dir, 'audio.wav');
    const dlArgs = [
      ...YTDLP_JS_RUNTIME_ARGS,
      '-f', 'wa/ba[abr<50]/ba',
      '-x', '--audio-format', 'wav',
      '--postprocessor-args', 'ExtractAudio:-ar 16000 -ac 1 -c:a pcm_s16le',
      '--no-warnings', '--newline',
      '-o', path.join(dir, 'audio.%(ext)s'),
    ];
    if (ffmpeg) dlArgs.push('--ffmpeg-location', ffmpeg);
    dlArgs.push(videoUrl);
    reportProgress(opts, 'download', 0);
    let lastDl = -1;
    const runDownload = () => runStreaming(ytdlp, dlArgs, {
      signal, timeoutMs: 5 * 60_000,
      onStderr: (chunk) => {
        const ms = chunk.match(/\[download\]\s+([\d.]+)%/g);
        if (!ms) return;
        const pct = Math.min(99, Math.floor(parseFloat(/([\d.]+)%/.exec(ms[ms.length - 1])[1])));
        if (pct > lastDl) { lastDl = pct; reportProgress(opts, 'download', pct); }
      },
    });
    // The caption path has retried since day one; this one never did, so a
    // single transient refusal threw away an already-resolved binary and model.
    // Observed in practice: YouTube 403'd this exact format, and the identical
    // yt-dlp command succeeded seconds later.
    await withDownloadRetry(runDownload, opts, (pct) => {
      lastDl = -1;
      reportProgress(opts, 'download', pct);
    });
    reportProgress(opts, 'download', 100);

    // 3-4. Transcribe + map — shared with the local-file path.
    const segs = await transcribeWav(wavPath, { binPath, modelPath: modelPathInUse, dir, durationSec }, opts);
    // Record which model actually ran, so the library stores the truth rather
    // than whatever the client asked for. Non-enumerable, like source/langUsed.
    Object.defineProperty(segs, 'modelUsed', { value: modelInUse, enumerable: false });
    return segs;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Audio/video containers ffmpeg will happily decode. Used only to give a
// friendlier up-front error than a decoder failure three steps later.
export const LOCAL_MEDIA_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.ts',
]);

/**
 * Transcribe a media file already on disk — a podcast download, a lecture
 * recording, a meeting capture. Same Whisper stage as the YouTube path; only
 * the "get me a 16 kHz mono WAV" half differs, and here that is one ffmpeg
 * call instead of yt-dlp.
 *
 * Local/desktop only, like everything else Whisper-shaped: the server never
 * exposes this in web mode.
 *
 * @param {string} filePath - absolute path to the source media
 * @param {object} [opts] - same shape as transcribeViaWhisper's opts
 * @returns {Promise<Array<{text:string, offset:number}>>} segments, stamped
 *   with a non-enumerable `source` of 'whisper' (see mapWhisperJson)
 */
export async function transcribeFile(filePath, opts = {}) {
  try {
    return await runFilePipeline(filePath, opts);
  } catch (err) {
    // Parity with transcribeViaWhisper: the server maps errors by echoCode, and
    // anything without one degrades to a bare 500 "unexpected server error".
    // ffmpeg rejecting a corrupt upload used to land there — a dead end the
    // user could neither understand nor act on.
    if (!err.echoCode) {
      const m = mapWhisperError(err);
      err.echoCode = m.echoCode;
      if (!err.hint) err.hint = m.hint;
      // renderTranscriptError shows `message` as the headline and tucks `detail`
      // behind "Show technical details". A decode failure's message is a 500-char
      // ffmpeg dump, so it belongs in detail — the headline has to be readable.
      if (m.echoCode === 'MEDIA_UNREADABLE') {
        if (!err.detail) err.detail = err.stderr || err.message;
        err.message = 'This file could not be read as audio or video.';
      }
    }
    throw err;
  }
}

async function runFilePipeline(filePath, opts = {}) {
  const { binPath, modelPath } = requireWhisper(opts);
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || 'ffmpeg';
  const maxMinutes = opts.maxMinutes || DEFAULT_MAX_MINUTES;

  if (!existsSync(filePath)) {
    const e = new Error(`File not found: ${filePath}`);
    e.echoCode = 'WHISPER_FAILED';
    e.hint = 'The uploaded file could not be read.';
    throw e;
  }

  // Duration guard, mirroring the yt-dlp probe on the other path. ffprobe ships
  // with ffmpeg; if it is missing or the file is odd, fall through and let the
  // derived timeout do the bounding rather than refusing to try.
  let durationSec = 0;
  try {
    const ffprobe = opts.ffprobePath || process.env.ECHO_FFPROBE || 'ffprobe';
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000, signal: opts.signal });
    durationSec = parseFloat(String(stdout).trim());
    if (Number.isFinite(durationSec) && durationSec > maxMinutes * 60) {
      const e = new Error(`Audio is too long (${Math.round(durationSec / 60)} min) for transcription; limit is ${maxMinutes} min.`);
      e.echoCode = 'WHISPER_AUDIO_TOO_LONG';
      e.hint = `Whisper transcription is limited to audio under ${maxMinutes} minutes.`;
      throw e;
    }
  } catch (err) {
    if (err.echoCode === 'WHISPER_AUDIO_TOO_LONG') throw err;
    // ffprobe absent or unhappy — not fatal, the conversion below will report
    // a real decode failure if the file is genuinely unusable.
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-whisper-file-'));
  try {
    // Convert to exactly what whisper.cpp requires: 16 kHz mono s16le PCM.
    // -vn drops any video stream, so a .mp4 lecture costs no more than its audio.
    const wavPath = path.join(dir, 'audio.wav');
    reportProgress(opts, 'convert', 0);
    await runStreaming(ffmpeg, [
      '-nostdin', '-y',
      '-i', filePath,
      '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ], { signal: opts.signal, timeoutMs: 15 * 60_000 });
    reportProgress(opts, 'convert', 100);

    // No language probe on this path: a local file has no yt-dlp metadata, so
    // the model is whatever the caller chose.
    return await transcribeWav(wavPath, { binPath, modelPath, dir, durationSec }, opts);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Public entry — ensures every thrown error carries an echoCode for the server.
export async function transcribeViaWhisper(videoId, opts = {}) {
  try {
    return await runWhisperPipeline(videoId, opts);
  } catch (err) {
    if (!err.echoCode) {
      const m = mapWhisperError(err);
      err.echoCode = m.echoCode;
      if (!err.hint) err.hint = m.hint;
    }
    throw err;
  }
}

// echoCode passthrough, then ENOENT+binary-name detection, then timeout, then generic.
export function mapWhisperError(err) {
  if (!err) {
    return { echoCode: 'WHISPER_FAILED', message: 'Unknown error during transcription.', hint: 'Could not transcribe this video.' };
  }
  if (err.echoCode) {
    return { echoCode: err.echoCode, message: err.message, hint: err.hint || 'Could not transcribe this video.' };
  }
  const message = err.message || String(err);
  const blob = (err.path || '') + ' ' + message;
  if (err.code === 'ENOENT' && /whisper/i.test(blob)) {
    return { echoCode: 'WHISPER_MISSING', message, hint: 'Set ECHO_WHISPER to the whisper-cli binary path.' };
  }
  if (err.code === 'ENOENT' && /yt-dlp/i.test(blob)) {
    return { echoCode: 'YTDLP_MISSING', message, hint: 'Install yt-dlp: `pip install yt-dlp` or `winget install yt-dlp`.' };
  }
  if (err.code === 'ENOENT' && /ffmpeg/i.test(blob)) {
    return { echoCode: 'FFMPEG_MISSING', message, hint: 'Install ffmpeg — required to convert audio for Whisper.' };
  }
  // ffmpeg ran and refused the input: the file is corrupt, truncated, or not
  // really media. That is a fact about the *upload*, not a server fault, so it
  // must not fall through to the generic WHISPER_FAILED/500 — the user can act
  // on it (re-export, pick another file) once told. Ordered after the ENOENT
  // check above so an absent binary still reports FFMPEG_MISSING, and before
  // the timeout check so a killed conversion is still reported as a timeout.
  if (!err.killed && err.signal !== 'SIGTERM' && /^ffmpeg exited with code/i.test(message)) {
    return {
      echoCode: 'MEDIA_UNREADABLE',
      message,
      hint: 'This file could not be decoded — it may be corrupt, truncated, or not an audio/video file.',
    };
  }
  if (err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(message)) {
    return { echoCode: 'WHISPER_TIMEOUT', message, hint: 'Transcription took too long and was stopped. Try a shorter video or a faster model.' };
  }
  return { echoCode: 'WHISPER_FAILED', message, hint: 'Could not transcribe this video.' };
}
