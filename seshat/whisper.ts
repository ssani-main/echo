// Port of ../whisper.js: local whisper.cpp transcription, for a YouTube video (yt-dlp downloads the audio) or
// a media file (ffmpeg converts it). Local/desktop only; the server turns it off in web mode. Spawns a prebuilt
// whisper-cli: no npm dependency, no C++ toolchain. The pure parts are checked by check/whisper.cases.ts, the
// pipelines against stand-in programs by check/whisper-run.cases.ts.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
// shortcut: std/crypto, as node:crypto goes through Seshat's npm bridge (gap: node-crypto-bridged).
import { randomUUID } from 'std/crypto';
import { DEFAULT_WHISPER_MODEL, isModelPresent, modelFilePath } from './whisperModel.ts';
import { EchoError } from './errors.ts';

/** One transcript line, offset in seconds: what every transcript fetcher returns. */
export interface CaptionSegment {
  text: string;
  offset: number;
}

/** Transcript lines, tagged (non-enumerable, so not in their JSON) with the track or model really used. */
export type Segments = CaptionSegment[] & { langUsed?: unknown; source?: string; modelUsed?: string | null };

/** A progress tick: the phase (model, download, convert, transcribe) and its percent. */
export interface WhisperProgress { phase: string; pct: number; model?: string; reason?: string }

/** Everything the pipelines read; fetchTranscript passes its own options straight through. */
export interface WhisperOptions {
  whisperPath?: string;
  modelPath?: string;
  modelName?: string;
  vadModelPath?: string;
  ytDlpPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxMinutes?: number;
  threads?: number;
  whisperLang?: string;
  timeoutMs?: number;
  downloadRetryDelaysMs?: number[];
  signal?: AbortSignal;
  onProgress?: (p: WhisperProgress) => void;
}

const execFileAsync = promisify(execFile);

// The repository root: whisper.js resolves the vendored binary next to itself, and this file is in seshat/.
const ROOT_DIR = dirname(import.meta.dirname);

// yt-dlp 2026.06.09+ silently drops formats without a JS runtime (see transcript.ts).
const YTDLP_JS_RUNTIME = process.env.ECHO_YTDLP_JS_RUNTIME ?? 'node';
const YTDLP_JS_RUNTIME_ARGS: string[] = YTDLP_JS_RUNTIME ? ['--js-runtimes', YTDLP_JS_RUNTIME] : [];

const DEFAULT_MAX_MINUTES = Number(process.env.ECHO_WHISPER_MAX_MINUTES) || 180;

// The vendored binary for this platform and architecture, e.g. vendor/whisper/win32-x64/whisper-cli.exe. Absent
// platforms (darwin) fail existsSync in the callers, and the feature is off.
function vendoredBin(): string {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return join(ROOT_DIR, 'vendor', 'whisper', `${process.platform}-${process.arch}`, name);
}

function cacheModel(opts: WhisperOptions): string | null {
  const name = opts.modelName || process.env.ECHO_WHISPER_DEFAULT_MODEL || DEFAULT_WHISPER_MODEL;
  return isModelPresent(name) ? modelFilePath(name) : null;
}

export interface ResolvedWhisper { binPath: string; modelPath: string }

/** The binary and the model, most explicit first; null (Whisper off) unless both exist on disk. */
export function resolveWhisper(opts: WhisperOptions = {}): ResolvedWhisper | null {
  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  const modelPath = opts.modelPath || process.env.ECHO_WHISPER_MODEL || cacheModel(opts);
  if (!binPath || !modelPath) return null;
  if (!existsSync(binPath) || !existsSync(modelPath)) return null;
  return { binPath, modelPath };
}

/** The binary alone, whatever the model: for /api/whisper/status. */
export function resolveWhisperBinary(opts: WhisperOptions = {}): string | null {
  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  return binPath && existsSync(binPath) ? binPath : null;
}

/** The Silero VAD model, which is what turns VAD on (opt-in: see whisper.js and WHISPER.md); null when off. */
export function resolveVadModel(opts: WhisperOptions = {}): string | null {
  const vadPath = opts.vadModelPath || process.env.ECHO_WHISPER_VAD_MODEL || null;
  return vadPath && existsSync(vadPath) ? vadPath : null;
}

export interface WhisperArgsSpec {
  modelPath: string;
  wavPath: string;
  whisperLang: string;
  threads: number | string;
  outPrefix: string;
  vadModelPath?: string | null;
}

/** The whisper-cli arguments. No flag that buys speed with accuracy (see whisper.js). */
export function buildWhisperArgs(spec: WhisperArgsSpec): string[] {
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
  // so offsets stay absolute. Its own VAD defaults are left alone.
  if (vadModelPath) args.push('--vad', '-vm', vadModelPath);

  return args;
}

/**
 * whisper.cpp's `-oj` JSON as Echo's segments, offsets in seconds (whisper.cpp writes milliseconds), tagged
 * with the detected language and source 'whisper' as the caption path tags its own.
 */
export function mapWhisperJson(json: unknown): Segments {
  const transcription = isObject(json) ? json.transcription : undefined;
  const segs: unknown[] = Array.isArray(transcription) ? transcription : [];
  const out: Segments = [];
  for (const s of segs) {
    const rec = isObject(s) ? s : undefined;
    const text = String((rec && rec.text) || '').trim();
    if (!text) continue;
    const offsets = rec ? rec.offsets : undefined;
    const fromMs = isObject(offsets) ? Number(offsets.from) : undefined;
    const offset = fromMs !== undefined && Number.isFinite(fromMs) ? fromMs / 1000 : 0;
    out.push({ text, offset });
  }
  const result = isObject(json) ? json.result : undefined;
  const langUsed = (isObject(result) && result.language) || undefined;
  Object.defineProperty(out, 'langUsed', { value: langUsed, enumerable: false });
  Object.defineProperty(out, 'source', { value: 'whisper', enumerable: false });
  return out;
}

/** `v &&` with a property read after it, as whisper.js reads the parsed JSON. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Best effort: the server passes this on to an SSE channel; a progress handler never throws into the pipeline.
function reportProgress(opts: WhisperOptions, phase: string, pct: number, extra: { model: string; reason: string } | null = null): void {
  const onProgress = opts.onProgress;
  if (typeof onProgress === 'function') {
    try { onProgress(extra ? { phase, pct, ...extra } : { phase, pct }); }
    catch { /* progress is best-effort */ }
  }
}

/**
 * A child process that failed: exited non-zero, timed out (killed, SIGTERM) or was aborted (AbortError). An
 * EchoError with no code yet, so it can be tagged as whisper.js tags its plain Error.
 */
export class ProcessError extends EchoError {
  exitCode: number | null;
  stderr: string;
  killed = false;
  signal: string | null = null;
  code: string | undefined = undefined;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message, '');
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface StreamingOptions {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
  lowerPriority?: boolean;
}

/**
 * Spawns a child and passes its output on as it comes instead of buffering it: whisper-cli echoes every line
 * to stderr, which overflowed execFile's buffer on long videos. Keeps the last 4,000 characters for errors.
 */
function runStreaming(cmd: string, args: string[], { env, signal, timeoutMs, onStderr, lowerPriority }: StreamingOptions = {}): Promise<{ tail: string }> {
  return new Promise((resolve, reject) => {
    const child = env ? spawn(cmd, args, { env, windowsHide: true }) : spawn(cmd, args, { windowsHide: true });

    // Transcription is a background chore: yield CPU to the rest of the machine. Best effort.
    const pid = child.pid;
    if (lowerPriority && pid) {
      try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: fine */ }
    }

    let tail = '';
    let timedOut = false;
    let settled = false;
    const onData = (buf: Buffer): void => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      if (onStderr) { try { onStderr(s); } catch { /* parser is best-effort */ } }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const to = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    // shortcut: a settled flag instead of removeEventListener, which Seshat's AbortSignal lacks (gap:
    // abort-listener-remove).
    if (signal) {
      if (signal.aborted) child.kill('SIGTERM');
      else signal.addEventListener('abort', () => { if (!settled) child.kill('SIGTERM'); });
    }
    const cleanup = (): void => {
      settled = true;
      if (to) clearTimeout(to);
    };

    child.on('error', (err: Error) => { cleanup(); reject(err); });
    child.on('close', (code: number | null, sig: string | null) => {
      cleanup();
      if (code === 0) { resolve({ tail }); return; }
      const err = new ProcessError(`${basename(String(cmd))} exited with code ${code}${sig ? ` (${sig})` : ''}: ${tail.slice(-500)}`, code, tail);
      if (timedOut) { err.killed = true; err.signal = 'SIGTERM'; }
      if (signal && signal.aborted) { err.name = 'AbortError'; err.code = 'ABORT_ERR'; }
      reject(err);
    });
  });
}

/** The binary and the model, or the reason they can't be had; the same for a video and a file. */
function requireWhisper(opts: WhisperOptions): ResolvedWhisper {
  const resolved = resolveWhisper(opts);
  if (resolved) return resolved;

  const binPath = opts.whisperPath || process.env.ECHO_WHISPER || vendoredBin();
  if (!binPath || !existsSync(binPath)) {
    throw new EchoError(
      'Whisper transcription is not available on this platform.',
      'WHISPER_MISSING',
      'Echo ships whisper-cli for Linux and Windows on x64. On other platforms, '
        + 'point ECHO_WHISPER at a whisper-cli binary to enable it.',
    );
  }
  // Points at the Settings UI, not the env var: there is a model picker with an on-demand download.
  throw new EchoError(
    'No Whisper model downloaded yet.',
    'WHISPER_MODEL_MISSING',
    'Open Settings → Transcription and download a model (Base is about 60 MB). '
      + 'Or set ECHO_WHISPER_MODEL to a ggml model file you already have.',
  );
}

/**
 * Threads for whisper-cli: 75% of the cores (WHISPER.md says why not all).
 * shortcut: the core count from NUMBER_OF_PROCESSORS (Windows), else 4, as Seshat has no os.cpus() (gap:
 * os-cpus).
 */
function whisperThreads(opts: WhisperOptions): number {
  const cores = Number(process.env.NUMBER_OF_PROCESSORS) || 4;
  return opts.threads
    || Number(process.env.ECHO_WHISPER_THREADS)
    || Math.max(1, Math.round(cores * 0.75));
}

/** `fs.mkdtemp(join(tmpdir(), prefix))`. shortcut: a UUID's first six characters (gap: fs-mkdtemp). */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), prefix + randomUUID().slice(0, 6));
  await mkdir(dir, { recursive: true });
  return dir;
}

interface WavContext { binPath: string; modelPath: string; dir: string; durationSec?: number }

/** Transcribes a prepared 16 kHz mono s16le WAV: the half both pipelines share, so they can't drift. */
async function transcribeWav(wavPath: string, ctx: WavContext, opts: WhisperOptions): Promise<Segments> {
  const { binPath, modelPath, dir } = ctx;
  const durationSec = ctx.durationSec ?? 0;
  const whisperLang = opts.whisperLang || 'auto';

  // On Linux the .so libraries sit beside the binary (harmless elsewhere).
  const outPrefix = join(dir, 'out');
  const libraryPath: (string | undefined)[] = [dirname(binPath), process.env.LD_LIBRARY_PATH];
  const env: Record<string, string | undefined> = {
    ...process.env,
    LD_LIBRARY_PATH: libraryPath.filter((p) => Boolean(p)).join(':'),
  };

  // Minutes of work: a generous timeout from the duration.
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
    onStderr: (chunk: string): void => {
      const ms = chunk.match(/progress\s*=\s*(\d+)%/g);
      if (!ms) return;
      const pct = Math.min(99, parseInt(/(\d+)%/.exec(ms[ms.length - 1]!)![1]!, 10));
      if (pct > lastTr) { lastTr = pct; reportProgress(opts, 'transcribe', pct); }
    },
  });
  reportProgress(opts, 'transcribe', 100);

  const raw = await readFile(`${outPrefix}.json`, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const segments = mapWhisperJson(parsed);
  if (segments.length === 0) {
    throw new EchoError('Whisper produced an empty transcript.', 'WHISPER_FAILED', 'The audio may be silent or unintelligible.');
  }
  return segments;
}

/**
 * Model choice per language: `base` is English-tuned, so a known non-English video is moved up to `small`;
 * anything else is left as asked.
 */
export function chooseModelForLanguage(requested: string, language: string | null | undefined): string {
  if (requested !== 'base') return requested;
  if (!language) return requested;
  const lang = String(language).trim().toLowerCase();
  if (!lang || lang === 'na' || lang === 'none' || lang === 'undefined') return requested;
  if (lang === 'en' || lang.startsWith('en-')) return requested;
  return 'small';
}

// A refusal YouTube hands out under load and withdraws moments later, versus a
// fact about the video. Only the former is worth retrying.
const TRANSIENT_DOWNLOAD_PATTERNS = [
  /HTTP Error 403/i,
  /HTTP Error 429/i,
  /HTTP Error 5\d\d/i,
  /\bthrottl/i,
  /temporar(y|ily)/i,
  /connection reset|timed out|network|ECONNRESET|ETIMEDOUT/i,
  /Unable to download (webpage|API page|video data)/i,
];

// The error mappers read whatever child_process, fs and Echo put on an error
// (code, killed, signal, stderr, path, echoCode, hint), so they take `any`, as
// Node's own error types are in a .ts file.

/** Is this yt-dlp failure the kind that tends to succeed on a second ask? */
export function isTransientDownloadFailure(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false; // the user left
  if (err.killed || err.signal === 'SIGTERM') return false;                // our own timeout
  const blob = `${err.stderr || ''} ${err.message || ''}`;
  return TRANSIENT_DOWNLOAD_PATTERNS.some((p) => p.test(blob));
}

export const DEFAULT_DOWNLOAD_RETRY_DELAYS_MS: number[] = [800, 2400];

/**
 * Run the audio download, retrying only transient refusals, as the caption
 * path's fetchWithRetry does. The one caller ignores the result.
 */
export async function withDownloadRetry(
  run: () => Promise<unknown>,
  opts: WhisperOptions = {},
  onRetry: ((pct: number) => void) | null = null,
): Promise<unknown> {
  const delays = opts.downloadRetryDelaysMs !== undefined
    ? opts.downloadRetryDelaysMs
    : DEFAULT_DOWNLOAD_RETRY_DELAYS_MS;
  let lastErr: any;
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
  // Out of attempts. If it was transient the whole way, say so: "could not
  // transcribe this video" reads as a fact about the video, which it isn't.
  if (isTransientDownloadFailure(lastErr)) {
    throw new EchoError(
      'YouTube refused the audio download.',
      'AUDIO_DOWNLOAD_REFUSED',
      'YouTube throttles audio downloads under load. This is usually temporary — try again in a minute.',
      lastErr.stderr || lastErr.message || '',
    );
  }
  throw lastErr;
}

async function runWhisperPipeline(videoId: string, opts: WhisperOptions): Promise<Segments> {
  const { binPath, modelPath } = requireWhisper(opts);
  const ytdlp = opts.ytDlpPath || process.env.ECHO_YTDLP || 'yt-dlp';
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || null;
  const maxMinutes = opts.maxMinutes || DEFAULT_MAX_MINUTES;
  const signal = opts.signal;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Duration guard: a cheap metadata probe refuses over-long audio up front, and gives the language.
  let durationSec = 0;
  let videoLanguage: string | null = null;
  try {
    const probeArgs = [...YTDLP_JS_RUNTIME_ARGS, '--skip-download', '--no-warnings', '--print', '%(duration)s|%(language)s', videoUrl];
    const { stdout } = signal
      ? await execFileAsync(ytdlp, probeArgs, { timeout: 30000, signal })
      : await execFileAsync(ytdlp, probeArgs, { timeout: 30000 });
    const [durRaw = '', langRaw = ''] = String(stdout).trim().split('|');
    videoLanguage = langRaw.trim() || null;
    durationSec = parseFloat(durRaw);
    if (Number.isFinite(durationSec) && durationSec > maxMinutes * 60) {
      throw new EchoError(
        `Audio is too long (${Math.round(durationSec / 60)} min) for transcription; limit is ${maxMinutes} min.`,
        'WHISPER_AUDIO_TOO_LONG',
        `Whisper transcription is limited to audio under ${maxMinutes} minutes.`,
      );
    }
  } catch (err: any) {
    if (err.echoCode === 'WHISPER_AUDIO_TOO_LONG') throw err;
    if (err.code === 'ENOENT') throw err; // yt-dlp missing: mapped to YTDLP_MISSING
    // otherwise ignore the probe's failure and go on to the download
  }

  // The language is known: pick the model that can handle it. Only ever an upgrade, only when the better
  // model is already downloaded, never a downgrade of an explicit choice.
  const requestedModel = opts.modelName || process.env.ECHO_WHISPER_DEFAULT_MODEL || DEFAULT_WHISPER_MODEL;
  let modelInUse = requestedModel;
  let modelPathInUse = modelPath;
  const better = chooseModelForLanguage(requestedModel, videoLanguage);
  if (better !== requestedModel) {
    const alt = resolveWhisper({ ...opts, modelName: better });
    // A pinned model file (opts.modelPath, ECHO_WHISPER_MODEL) wins whatever modelName says, so the path must
    // really differ before claiming an upgrade.
    if (alt && alt.modelPath !== modelPath) {
      modelInUse = better;
      modelPathInUse = alt.modelPath;
      reportProgress(opts, 'model', 0, { model: better, reason: `language:${videoLanguage}` });
    }
    // The better model isn't downloaded: a mediocre transcript beats none.
  }

  const dir = await makeTempDir('echo-whisper-');
  try {
    // 2. The smallest useful audio, converted to the 16 kHz mono s16le WAV whisper.cpp needs.
    const wavPath = join(dir, 'audio.wav');
    const dlArgs = [
      ...YTDLP_JS_RUNTIME_ARGS,
      '-f', 'wa/ba[abr<50]/ba',
      '-x', '--audio-format', 'wav',
      '--postprocessor-args', 'ExtractAudio:-ar 16000 -ac 1 -c:a pcm_s16le',
      '--no-warnings', '--newline',
      '-o', join(dir, 'audio.%(ext)s'),
    ];
    if (ffmpeg) dlArgs.push('--ffmpeg-location', ffmpeg);
    dlArgs.push(videoUrl);
    reportProgress(opts, 'download', 0);
    let lastDl = -1;
    const runDownload = (): Promise<{ tail: string }> => runStreaming(ytdlp, dlArgs, {
      signal, timeoutMs: 5 * 60_000,
      onStderr: (chunk: string): void => {
        const ms = chunk.match(/\[download\]\s+([\d.]+)%/g);
        if (!ms) return;
        const pct = Math.min(99, Math.floor(parseFloat(/([\d.]+)%/.exec(ms[ms.length - 1]!)![1]!)));
        if (pct > lastDl) { lastDl = pct; reportProgress(opts, 'download', pct); }
      },
    });
    // A transient refusal (YouTube 403'd this format, and the same command worked seconds later) is retried.
    await withDownloadRetry(runDownload, opts, (pct: number): void => {
      lastDl = -1;
      reportProgress(opts, 'download', pct);
    });
    reportProgress(opts, 'download', 100);

    // 3-4. Transcribe and map: shared with the file path.
    const segs = await transcribeWav(wavPath, { binPath, modelPath: modelPathInUse, dir, durationSec }, opts);
    // The model that really ran, for the library. Non-enumerable, like source and langUsed.
    Object.defineProperty(segs, 'modelUsed', { value: modelInUse, enumerable: false });
    return segs;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Audio/video containers ffmpeg will happily decode; only for a friendlier
// up-front error than a decoder failure three steps later.
export const LOCAL_MEDIA_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.ts',
]);

/**
 * The error as the server reads it, with an echoCode and a hint: whisper.js sets them on whatever was thrown
 * without one. A ProcessError carries them itself; anything else (a spawn's ENOENT) becomes an EchoError with
 * the same message.
 */
function withEchoCode(err: unknown): EchoError {
  const m = mapWhisperError(err);
  if (err instanceof ProcessError) {
    err.echoCode = m.echoCode;
    if (!err.hint) err.hint = m.hint;
    return err;
  }
  return new EchoError(m.message ?? '', m.echoCode, m.hint);
}

function hasEchoCode(err: unknown): boolean {
  return err instanceof EchoError && err.echoCode !== '';
}

/**
 * Transcribes a media file already on disk (a podcast, a lecture, a meeting): the same Whisper stage, with one
 * ffmpeg call instead of yt-dlp. Local/desktop only.
 */
export async function transcribeFile(filePath: string, opts: WhisperOptions = {}): Promise<Segments> {
  try {
    return await runFilePipeline(filePath, opts);
  } catch (err) {
    if (hasEchoCode(err)) throw err;
    const tagged = withEchoCode(err);
    // A decode failure's message is a 500-character ffmpeg dump: it goes to detail, the headline is readable.
    if (tagged.echoCode === 'MEDIA_UNREADABLE') {
      if (!tagged.detail) tagged.detail = (tagged instanceof ProcessError ? tagged.stderr : '') || tagged.message;
      tagged.message = 'This file could not be read as audio or video.';
    }
    throw tagged;
  }
}

async function runFilePipeline(filePath: string, opts: WhisperOptions = {}): Promise<Segments> {
  const { binPath, modelPath } = requireWhisper(opts);
  const ffmpeg = opts.ffmpegPath || process.env.ECHO_FFMPEG || 'ffmpeg';
  const maxMinutes = opts.maxMinutes || DEFAULT_MAX_MINUTES;

  if (!existsSync(filePath)) {
    throw new EchoError(`File not found: ${filePath}`, 'WHISPER_FAILED', 'The uploaded file could not be read.');
  }

  // Duration guard, as on the video path. ffprobe absent or unhappy: the derived timeout bounds the work.
  let durationSec = 0;
  try {
    const ffprobe = opts.ffprobePath || process.env.ECHO_FFPROBE || 'ffprobe';
    const probeArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const signal = opts.signal;
    const { stdout } = signal
      ? await execFileAsync(ffprobe, probeArgs, { timeout: 30000, signal })
      : await execFileAsync(ffprobe, probeArgs, { timeout: 30000 });
    durationSec = parseFloat(String(stdout).trim());
    if (Number.isFinite(durationSec) && durationSec > maxMinutes * 60) {
      throw new EchoError(
        `Audio is too long (${Math.round(durationSec / 60)} min) for transcription; limit is ${maxMinutes} min.`,
        'WHISPER_AUDIO_TOO_LONG',
        `Whisper transcription is limited to audio under ${maxMinutes} minutes.`,
      );
    }
  } catch (err: any) {
    if (err.echoCode === 'WHISPER_AUDIO_TOO_LONG') throw err;
    // not fatal: the conversion below reports a real decode failure
  }

  const dir = await makeTempDir('echo-whisper-file-');
  try {
    // Exactly what whisper.cpp needs; -vn drops any video stream.
    const wavPath = join(dir, 'audio.wav');
    reportProgress(opts, 'convert', 0);
    await runStreaming(ffmpeg, [
      '-nostdin', '-y',
      '-i', filePath,
      '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath,
    ], { signal: opts.signal, timeoutMs: 15 * 60_000 });
    reportProgress(opts, 'convert', 100);

    // No language probe here: a local file has no yt-dlp metadata, so the model is the caller's choice.
    return await transcribeWav(wavPath, { binPath, modelPath, dir, durationSec }, opts);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Transcribes a YouTube video with Whisper; every error it throws carries an echoCode. */
export async function transcribeViaWhisper(videoId: string, opts: WhisperOptions = {}): Promise<Segments> {
  try {
    return await runWhisperPipeline(videoId, opts);
  } catch (err) {
    if (hasEchoCode(err)) throw err;
    throw withEchoCode(err);
  }
}

export interface WhisperErrorInfo {
  echoCode: string;
  message: string | undefined; // undefined when an echoCode error carries no message, as in the original
  hint: string;
}

// echoCode passthrough, then ENOENT+binary-name detection, then timeout, then generic.
export function mapWhisperError(err: any): WhisperErrorInfo {
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
  // ffmpeg ran and refused the input: a fact about the upload, not a server
  // fault, so it must not fall through to WHISPER_FAILED/500. After the ENOENT
  // checks (an absent binary is FFMPEG_MISSING), before the timeout check (a
  // killed conversion is a timeout).
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
