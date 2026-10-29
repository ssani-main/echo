// Port of the pure parts of ../whisper.js: the whisper-cli arguments, the
// model choice per language, the media extensions, the download-retry policy
// and the error mapping. The binary resolution, the yt-dlp/ffmpeg/whisper-cli
// spawns and mapWhisperJson (which tags its array with Object.defineProperty,
// gap: define-property-on-array) come with the Whisper routes (see PORT.md).
// Checked against the original by check/whisper.cases.ts.

import { EchoError } from './errors.ts';

export interface WhisperArgsSpec {
  modelPath: string;
  wavPath: string;
  whisperLang: string;
  threads: number | string;
  outPrefix: string;
  vadModelPath?: string | null;
}

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
 * The model to use: `base` is English-tuned, so a known non-English video is
 * moved up to `small`; anything else is left as asked.
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
  opts: { downloadRetryDelaysMs?: number[] } = {},
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

// Audio/video containers ffmpeg will happily decode; only for a friendlier
// up-front error than a decoder failure three steps later.
export const LOCAL_MEDIA_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.ts',
]);

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
