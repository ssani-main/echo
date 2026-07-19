// whisper.js — local whisper.cpp transcription. Fills the caption dead-end
// (`fallback`) or upgrades transcript quality (`always`). Local/desktop only —
// the server forces this OFF in web mode. Spawns a prebuilt whisper-cli binary
// (env/opts-configured) — no npm dependency, no C++ toolchain.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// yt-dlp 2026.06.09+ silently drops formats without a JS runtime (see transcript.js).
const YTDLP_JS_RUNTIME = process.env.ECHO_YTDLP_JS_RUNTIME ?? 'node';
const YTDLP_JS_RUNTIME_ARGS = YTDLP_JS_RUNTIME ? ['--js-runtimes', YTDLP_JS_RUNTIME] : [];

const DEFAULT_MAX_MINUTES = Number(process.env.ECHO_WHISPER_MAX_MINUTES) || 180;

// Forward-compat candidate for a future vendored binary; gated by existsSync so it's
// a no-op in P1 (nothing shipped there yet). The real path in P1 comes from env/opts.
function vendoredBin() {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return path.join(process.cwd(), 'vendor', 'whisper', name);
}
// P1 has no auto-download cache yet.
function cacheModel() {
  return null;
}

// Resolve the binary + model, cheapest/most-explicit first. Returns null (feature OFF)
// unless BOTH exist on disk — this IS the "is Whisper present?" gate.
export function resolveWhisper(opts = {}) {
  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  const modelPath = opts.modelPath || process.env.ECHO_WHISPER_MODEL || cacheModel();
  if (!binPath || !modelPath) return null;
  if (!existsSync(binPath) || !existsSync(modelPath)) return null;
  return { binPath, modelPath };
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
  const threads = opts.threads || Math.max(1, os.cpus().length);
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
      '--no-warnings',
      '-o', path.join(dir, 'audio.%(ext)s'),
    ];
    if (ffmpeg) dlArgs.push('--ffmpeg-location', ffmpeg);
    dlArgs.push(videoUrl);
    await execFileAsync(ytdlp, dlArgs, { timeout: 5 * 60_000, signal });

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
    await execFileAsync(binPath, [
      '-m', modelPath,
      '-f', wavPath,
      '-l', whisperLang,
      '-t', String(threads),
      '-oj', '-of', outPrefix,
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64, signal, env });

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

// Mirrors frames.js mapFramesError: echoCode passthrough, then ENOENT+binary-name
// detection, then timeout, then generic.
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
