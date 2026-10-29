import {
  buildWhisperArgs, chooseModelForLanguage, isTransientDownloadFailure, withDownloadRetry, mapWhisperError,
  DEFAULT_DOWNLOAD_RETRY_DELAYS_MS, LOCAL_MEDIA_EXTENSIONS,
} from '../whisper.ts';
import { out } from './out.ts';

out('buildWhisperArgs/basic', buildWhisperArgs({ modelPath: 'm.bin', wavPath: 'a.wav', whisperLang: 'auto', threads: 4, outPrefix: 'out' }));
out('buildWhisperArgs/vad', buildWhisperArgs({ modelPath: 'C:\\m dir\\m.bin', wavPath: 'a.wav', whisperLang: 'de', threads: '8', outPrefix: 'o', vadModelPath: 'vad.bin' }));
out('buildWhisperArgs/vad empty', buildWhisperArgs({ modelPath: 'm', wavPath: 'w', whisperLang: 'en', threads: 0, outPrefix: 'o', vadModelPath: '' }));
out('buildWhisperArgs/vad null', buildWhisperArgs({ modelPath: 'm', wavPath: 'w', whisperLang: 'en', threads: 1.5, outPrefix: 'o', vadModelPath: null }));

const langs: (string | null | undefined)[] = ['en', 'EN', 'en-US', 'en_GB', 'de', ' fr ', 'NA', 'none', 'undefined', '', '  ', null, undefined, 'eng', 'ja'];
for (const requested of ['base', 'small', 'medium']) {
  langs.forEach((l, i) => out(`chooseModelForLanguage/${requested}#${i}`, chooseModelForLanguage(requested, l)));
}

out('DEFAULT_DOWNLOAD_RETRY_DELAYS_MS', DEFAULT_DOWNLOAD_RETRY_DELAYS_MS);
out('LOCAL_MEDIA_EXTENSIONS', [...LOCAL_MEDIA_EXTENSIONS]);
out('LOCAL_MEDIA_EXTENSIONS.has', ['.mp3', '.MP3', '.ts', '.txt', ''].map((e) => LOCAL_MEDIA_EXTENSIONS.has(e)));

// Errors as child_process, fs and Echo shape them: plain objects carrying the fields the mappers read
// (an Error can't be given extra fields in Seshat, see PORT.md, error-add-property).
const errs: any[] = [
  null, undefined,
  { message: 'ERROR: unable to download video data: HTTP Error 403: Forbidden' },
  { message: 'Command failed', stderr: 'HTTP Error 429: Too Many Requests' },
  { message: 'x', stderr: 'HTTP Error 503 Service Unavailable' },
  { message: 'HTTP Error 404: Not Found' },
  { message: 'Throttled by server' },
  { message: 'temporarily unavailable' },
  { message: 'read ECONNRESET' },
  { message: 'ERROR: Unable to download webpage: timed out' },
  { name: 'AbortError', message: 'HTTP Error 429' },
  { code: 'ABORT_ERR', message: 'HTTP Error 429' },
  { killed: true, message: 'HTTP Error 429' },
  { signal: 'SIGTERM', message: 'HTTP Error 429' },
  { message: 'Private video. Sign in if you have access' },
  { echoCode: 'WHISPER_MISSING', message: 'no binary', hint: 'set it' },
  { echoCode: 'X', message: 'no hint' },
  { echoCode: 'Y' },
  { code: 'ENOENT', path: 'C:\\vendor\\whisper-cli.exe', message: 'spawn ENOENT' },
  { code: 'ENOENT', message: 'spawn yt-dlp ENOENT' },
  { code: 'ENOENT', message: 'spawn ffmpeg ENOENT' },
  { code: 'ENOENT', message: 'spawn other ENOENT' },
  { message: 'ffmpeg exited with code 1: Invalid data found' },
  { message: 'ffmpeg exited with code 1', killed: true },
  { message: 'whisper timed out after 60s' },
  { message: 'timeout' },
  { message: '' },
  {},
  'a plain string',
];
errs.forEach((e, i) => {
  out(`isTransientDownloadFailure#${i}`, isTransientDownloadFailure(e));
  out(`mapWhisperError#${i}`, mapWhisperError(e));
});

// shortcut: the failures are Errors, not the plain objects above, because Seshat throws only Error objects
// (gap: throw-any); the stderr-only path is covered by the isTransientDownloadFailure cases.
async function retryCase(name: string, failures: Error[], delays: number[]): Promise<void> {
  let attempts = 0;
  let retries = 0;
  const run = async (): Promise<unknown> => {
    const failure = failures[attempts++];
    if (failure !== undefined) throw failure;
    return 'downloaded';
  };
  try {
    const result = await withDownloadRetry(run, { downloadRetryDelaysMs: delays }, () => { retries++; });
    out(`withDownloadRetry/${name}`, { result, attempts, retries });
  } catch (e) {
    out(`withDownloadRetry/${name}`, describe(e, attempts, retries));
  }
}
function describe(err: any, attempts: number, retries: number): unknown {
  return { name: err.name, message: err.message, echoCode: err.echoCode, hint: err.hint, detail: err.detail, attempts, retries };
}
const transient = new Error('Command failed: HTTP Error 403: Forbidden');
const permanent = new Error('Private video');
await retryCase('first try', [], [1, 2]);
await retryCase('one transient', [transient], [1, 2]);
await retryCase('transient throughout', [transient, transient, transient], [1, 2]);
await retryCase('transient, no retries', [transient], []);
await retryCase('permanent', [permanent], [1, 2]);
await retryCase('transient then permanent', [transient, permanent], [1, 2]);
await retryCase('transient, other text', [new Error('HTTP Error 429'), new Error('read ECONNRESET')], [1]);
