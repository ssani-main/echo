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
function reportProgress(opts, phase, pct) {
  if (typeof opts.onProgress === 'function') {
    try { opts.onProgress({ phase, pct }); } catch { /* progress is best-effort */ }
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

async function runWhisperPipeline(videoId, opts) {
  const resolved = resolveWhisper(opts);
  if (!resolved) {
    const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
    if (!binPath || !existsSync(binPath)) {
      const e = new Error('whisper-cli binary not found.');
      e.echoCode = 'WHISPER_MISSING';
      e.hint = 'Set ECHO_WHISPER to the whisper-cli binary path.';
      throw e;
    }
    const e = new Error('Whisper model file not found.');
    e.echoCode = 'WHISPER_MODEL_MISSING';
    e.hint = 'Set ECHO_WHISPER_MODEL to a ggml model file (e.g. ggml-base-q5_1.bin).';
    throw e;
  }
  const { binPath, modelPath } = resolved;
  const ytdlp = opts.ytDlpPath || process.env.ECHO_YTDLP || 'yt-dlp';
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || null;
  const maxMinutes = opts.maxMinutes || DEFAULT_MAX_MINUTES;
  // Default to ~75% of logical cores so the machine stays responsive; overridable
  // via ECHO_WHISPER_THREADS. Using every core pinned the CPU during long runs.
  const threads = opts.threads
    || Number(process.env.ECHO_WHISPER_THREADS)
    || Math.max(1, Math.round(os.cpus().length * 0.75));
  const whisperLang = opts.whisperLang || 'auto';
  const signal = opts.signal;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Duration guard — cheap metadata probe; reject over-long audio up front.
  let durationSec = 0;
  try {
    const { stdout } = await execFileAsync(ytdlp, [
      ...YTDLP_JS_RUNTIME_ARGS, '--skip-download', '--no-warnings',
      '--print', '%(duration)s', videoUrl,
    ], { timeout: 30000, signal });
    durationSec = parseFloat(String(stdout).trim());
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
    await runStreaming(ytdlp, dlArgs, {
      signal, timeoutMs: 5 * 60_000,
      onStderr: (chunk) => {
        const ms = chunk.match(/\[download\]\s+([\d.]+)%/g);
        if (!ms) return;
        const pct = Math.min(99, Math.floor(parseFloat(/([\d.]+)%/.exec(ms[ms.length - 1])[1])));
        if (pct > lastDl) { lastDl = pct; reportProgress(opts, 'download', pct); }
      },
    });
    reportProgress(opts, 'download', 100);

    // 3. Transcribe -> <prefix>.json. On Linux the .so libs live beside the binary,
    //    so LD_LIBRARY_PATH must include its dir (harmless on Windows/macOS).
    const outPrefix = path.join(dir, 'out');
    const binDir = path.dirname(binPath);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    };
    // Work is legitimately minutes-long; derive a generous timeout from duration.
    const derivedMs = Number.isFinite(durationSec) && durationSec > 0
      ? Math.max(30 * 60_000, Math.ceil(durationSec * 1500) + 60_000)
      : 60 * 60_000;
    const timeoutMs = opts.timeoutMs || Number(process.env.ECHO_WHISPER_TIMEOUT_MS) || derivedMs;
    reportProgress(opts, 'transcribe', 0);
    let lastTr = -1;
    await runStreaming(binPath, [
      '-m', modelPath,
      '-f', wavPath,
      '-l', whisperLang,
      '-t', String(threads),
      '--print-progress',
      '-oj', '-of', outPrefix,
    ], {
      env, signal, timeoutMs, lowerPriority: true,
      onStderr: (chunk) => {
        const ms = chunk.match(/progress\s*=\s*(\d+)%/g);
        if (!ms) return;
        const pct = Math.min(99, parseInt(/(\d+)%/.exec(ms[ms.length - 1])[1], 10));
        if (pct > lastTr) { lastTr = pct; reportProgress(opts, 'transcribe', pct); }
      },
    });
    reportProgress(opts, 'transcribe', 100);

    // 4. Map JSON -> Echo shape.
    const raw = await fs.readFile(`${outPrefix}.json`, 'utf8');
    const segments = mapWhisperJson(JSON.parse(raw));
    if (segments.length === 0) {
      const e = new Error('Whisper produced an empty transcript.');
      e.echoCode = 'WHISPER_FAILED';
      e.hint = 'The audio may be silent or unintelligible.';
      throw e;
    }
    return segments;
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
  if (err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(message)) {
    return { echoCode: 'WHISPER_TIMEOUT', message, hint: 'Transcription took too long and was stopped. Try a shorter video or a faster model.' };
  }
  return { echoCode: 'WHISPER_FAILED', message, hint: 'Could not transcribe this video.' };
}
