// whisper.js's pipelines against the port's, on stand-in programs (fake-tool.ts as whisper-cli, ffmpeg, ffprobe
// and yt-dlp, in FAKE_TOOL_DIR; their arguments logged to FAKE_TOOL_LOG) and a model cache of its own
// (ECHO_WHISPER_MODEL_DIR); run.mjs sets all three. The segments with their tags, the progress ticks, the
// errors as the server reads them, and every program's arguments.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  transcribeViaWhisper, transcribeFile, resolveWhisper, resolveWhisperBinary, resolveVadModel,
  type Segments, type WhisperOptions, type WhisperProgress,
} from '../whisper.ts';
import { out } from './out.ts';

const tools = process.env.FAKE_TOOL_DIR ?? join(tmpdir(), 'unset');
const toolLog = process.env.FAKE_TOOL_LOG ?? join(tmpdir(), 'unset.jsonl');
const cache = process.env.ECHO_WHISPER_MODEL_DIR ?? join(tmpdir(), 'unset');
const root = dirname(dirname(import.meta.dirname));
// No "whisper", "ffmpeg" or "yt-dlp" in this name: mapWhisperError reads the failed program's path for them.
const work = join(tmpdir(), 'echo-wr-cases');
rmSync(work, { recursive: true, force: true });
rmSync(cache, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(cache, { recursive: true });
writeFileSync(toolLog, '');

const bin = join(tools, 'whisper-cli.exe');
const ytdlp = join(tools, 'yt-dlp.exe');
const ffmpeg = join(tools, 'ffmpeg.exe');
const ffprobe = join(tools, 'ffprobe.exe');
const model = (name: string): string => join(work, `${name}.bin`);
for (const name of ['m-ok', 'm-empty', 'm-fail', 'm-slow', 'vad']) writeFileSync(model(name), 'ggml');
for (const name of ['good.mp3', 'corrupt.mp3', 'long.mp3', 'noprobe.mp3']) writeFileSync(join(work, name), 'ID3');

function mask(s: string): string {
  return s.split(work).join('<work>').split(tools).join('<tools>').split(cache).join('<cache>').split(root).join('<root>')
    .replace(/echo-whisper(-file)?-[A-Za-z0-9]{6}/g, 'echo-whisper$1-<tmp>');
}

function describe(e: any): unknown {
  return {
    name: e && e.name, message: mask(String(e && e.message)), echoCode: e && e.echoCode, hint: e && e.hint,
    detail: e && e.detail !== undefined ? mask(String(e.detail)) : undefined,
  };
}

// `abortOnTranscribe`: aborted when whisper-cli starts, so the abort always lands in the same step.
async function run(name: string, call: (opts: WhisperOptions) => Promise<Segments>, given: WhisperOptions, abortOnTranscribe?: AbortController): Promise<void> {
  const events: WhisperProgress[] = [];
  const onProgress = (p: WhisperProgress): void => {
    events.push(p);
    if (abortOnTranscribe && p.phase === 'transcribe') abortOnTranscribe.abort();
  };
  const opts: WhisperOptions = { ...given, onProgress };
  try {
    const segs = await call(opts);
    out(name, { segments: segs, langUsed: segs.langUsed, source: segs.source, modelUsed: segs.modelUsed ?? null, events });
  } catch (e) {
    out(name, { error: describe(e), events });
  }
}

const video = (id: string) => (opts: WhisperOptions): Promise<Segments> => transcribeViaWhisper(id, opts);
const file = (name: string) => (opts: WhisperOptions): Promise<Segments> => transcribeFile(join(work, name), opts);
const base: WhisperOptions = { whisperPath: bin, modelPath: model('m-ok'), ytDlpPath: ytdlp, threads: 2, downloadRetryDelaysMs: [1, 1] };

out('resolveWhisper/explicit', mask(JSON.stringify(resolveWhisper({ whisperPath: bin, modelPath: model('m-ok') }))));
out('resolveWhisper/no model', resolveWhisper({ whisperPath: bin, modelPath: model('absent') }));
out('resolveWhisper/no binary', resolveWhisper({ whisperPath: join(work, 'absent.exe'), modelPath: model('m-ok') }));
out('resolveWhisper/cache empty', resolveWhisper({ whisperPath: bin }));
out('resolveWhisperBinary/vendored', mask(String(resolveWhisperBinary())));
out('resolveWhisperBinary/absent', resolveWhisperBinary({ whisperPath: join(work, 'absent.exe') }));
out('resolveVadModel/none', resolveVadModel());
out('resolveVadModel/given', mask(String(resolveVadModel({ vadModelPath: model('vad') }))));
out('resolveVadModel/absent', resolveVadModel({ vadModelPath: model('absent') }));

await run('video/ok', video('okEnglish01'), base);
await run('video/lang de and vad', video('okEnglish01'), { ...base, whisperLang: 'de', vadModelPath: model('vad') });
await run('video/ffmpeg location', video('okEnglish01'), { ...base, ffmpegPath: ffmpeg });
await run('video/threads from cores', video('okEnglish01'), { ...base, threads: undefined });
await run('video/probe fails', video('probeFail01'), base);
await run('video/too long', video('tooLong0001'), base);
await run('video/too long, 2000 minutes allowed', video('tooLong0001'), { ...base, maxMinutes: 2000 });
await run('video/403 once', video('dl403once01'), base);
await run('video/403 always', video('dl403always'), base);
await run('video/private', video('dlPrivate01'), base);
await run('video/empty transcript', video('okEnglish01'), { ...base, modelPath: model('m-empty') });
await run('video/whisper fails', video('okEnglish01'), { ...base, modelPath: model('m-fail') });
await run('video/timeout', video('okEnglish01'), { ...base, modelPath: model('m-slow'), timeoutMs: 300 });
const ac = new AbortController();
await run('video/aborted', video('okEnglish01'), { ...base, modelPath: model('m-slow'), signal: ac.signal }, ac);
const acFile = new AbortController();
await run('file/aborted', file('good.mp3'), { whisperPath: bin, modelPath: model('m-slow'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, threads: 2, signal: acFile.signal }, acFile);
await run('video/no binary', video('okEnglish01'), { ...base, whisperPath: join(work, 'absent.exe') });
await run('video/no model', video('okEnglish01'), { ...base, modelPath: undefined, modelName: 'tiny' });
await run('video/no yt-dlp', video('okEnglish01'), { ...base, ytDlpPath: join(work, 'absent', 'yt-dlp.exe') });

// The language upgrade needs both models in the cache (present means the exact size).
writeFileSync(join(cache, 'ggml-base-q5_1.bin'), new Uint8Array(59707625));
await run('video/german, small not downloaded', video('germanVid01'), { ...base, modelPath: undefined, modelName: 'base' });
writeFileSync(join(cache, 'ggml-small-q5_1.bin'), new Uint8Array(190085487));
await run('video/german, upgraded to small', video('germanVid01'), { ...base, modelPath: undefined, modelName: 'base' });
await run('video/german, model pinned', video('germanVid01'), { ...base, modelName: 'base' });
await run('video/german, small asked', video('germanVid01'), { ...base, modelPath: undefined, modelName: 'small' });
await run('video/no language', video('noLanguage1'), { ...base, modelPath: undefined, modelName: 'base' });
out('resolveWhisper/cache', mask(JSON.stringify(resolveWhisper({ whisperPath: bin }))));
out('resolveWhisper/cache small', mask(JSON.stringify(resolveWhisper({ whisperPath: bin, modelName: 'small' }))));

const fileBase: WhisperOptions = { whisperPath: bin, modelPath: model('m-ok'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, threads: 2 };
await run('file/ok', file('good.mp3'), fileBase);
await run('file/corrupt', file('corrupt.mp3'), fileBase);
// whisper.js tells a decode failure by "^ffmpeg exited", so only an ffmpeg named without .exe reaches MEDIA_UNREADABLE.
await run('file/corrupt, ffmpeg without .exe', file('corrupt.mp3'), { ...fileBase, ffmpegPath: join(tools, 'ffmpeg') });
await run('file/too long', file('long.mp3'), fileBase);
await run('file/ffprobe fails', file('noprobe.mp3'), fileBase);
await run('file/no ffprobe', file('good.mp3'), { ...fileBase, ffprobePath: join(work, 'absent', 'ffprobe.exe') });
await run('file/no ffmpeg', file('good.mp3'), { ...fileBase, ffmpegPath: join(work, 'absent', 'ffmpeg.exe') });
await run('file/missing', file('absent.mp3'), fileBase);
await run('file/whisper fails', file('good.mp3'), { ...fileBase, modelPath: model('m-fail') });
await run('file/no model', file('good.mp3'), { ...fileBase, modelPath: model('absent'), modelName: 'tiny' });

readFileSync(toolLog, 'utf8').split('\n').filter((l) => l).forEach((line, i) => {
  const logged: string[] = JSON.parse(line);
  out(`args#${i}`, logged.map(mask));
});
rmSync(work, { recursive: true, force: true });
rmSync(cache, { recursive: true, force: true });
