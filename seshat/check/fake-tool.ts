// Stand-ins for whisper-cli, ffmpeg, ffprobe and yt-dlp, for check/whisper-run.cases.ts: run.mjs builds this
// once with Seshat and copies it under the four names, so the original and the port spawn the same programs.
// Which one it is comes from its arguments; what it does, from the video id, the input file's name or the
// model file's name. It logs its arguments to FAKE_TOOL_LOG, temp folder names masked.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_TOOL_LOG;
const masked = args.map((a) => a.replace(/echo-whisper(-file)?-[A-Za-z0-9]{6}/g, 'echo-whisper$1-<tmp>'));

function after(flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? '' : '';
}

function done(code: number, stderr = '', stdout = ''): void {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function whisperCli(): Promise<void> {
  const model = after('-m');
  const out = after('-of');
  const lang = after('-l');
  if (model.includes('m-slow')) { await sleep(20000); done(0); return; }
  // One write, so the reader sees one chunk (its parser reads the last percent of each chunk).
  process.stderr.write('whisper_init_from_file: loading model\n'
    + [5, 30, 30, 75].map((p) => `whisper_print_progress_callback: progress = ${p}%\n`).join(''));
  if (model.includes('m-fail')) { done(3, 'error: failed to decode the audio\n'); return; }
  const empty = model.includes('m-empty');
  const segments = empty ? '[{"offsets":{"from":0,"to":500},"text":"  "}]'
    : '[{"timestamps":{"from":"00:00:00,000"},"offsets":{"from":0,"to":2500},"text":" Hello there."},'
      + '{"offsets":{"from":2500,"to":4100},"text":" "},'
      + '{"offsets":{"from":"bad"},"text":"No offset."},'
      + '{"text":" Model ' + (model.includes('small') ? 'small' : 'base') + ' at ' + lang + '."}]';
  writeFileSync(`${out}.json`, `{"systeminfo":"fake","result":{"language":"${lang === 'auto' ? 'en' : lang}"},"transcription":${segments}}`);
  done(0, 'whisper_print_timings: total time = 1.0 ms\n');
}

function ytDlp(): void {
  const url = args[args.length - 1] ?? '';
  const id = url.slice(url.indexOf('v=') + 2);
  if (args.includes('--print')) {
    if (id === 'probeFail01') { done(1, 'ERROR: [youtube] probeFail01: Video unavailable\n'); return; }
    if (id === 'tooLong0001') { done(0, '', '99999|en\n'); return; }
    if (id === 'germanVid01') { done(0, '', '600.5|de\n'); return; }
    if (id === 'noLanguage1') { done(0, '', '120|NA\n'); return; }
    done(0, '', '61|en\n');
    return;
  }
  const outPattern = after('-o');
  const wav = outPattern.replace('%(ext)s', 'wav');
  const marker = outPattern.replace('%(ext)s', 'tried');
  if (id === 'dl403always') { done(1, 'ERROR: unable to download video data: HTTP Error 403: Forbidden\n'); return; }
  if (id === 'dl403once01' && !existsSync(marker)) {
    writeFileSync(marker, '');
    done(1, '[download]  10.0% of 1.00MiB\nERROR: unable to download video data: HTTP Error 403: Forbidden\n');
    return;
  }
  if (id === 'dlPrivate01') { done(1, 'ERROR: [youtube] dlPrivate01: Private video. Sign in if you\'ve been granted access\n'); return; }
  process.stderr.write('[youtube] Extracting URL\n');
  process.stdout.write('[download]   0.0% of 1.00MiB\n[download]  12.5% of 1.00MiB\n'
    + '[download]  12.5% of 1.00MiB\n[download]  99.9% of 1.00MiB\n[download] 100.0% of 1.00MiB\n');
  if (id !== 'dlNoFile001') writeFileSync(wav, 'RIFF fake wav');
  done(0);
}

function ffprobe(): void {
  const file = args[args.length - 1] ?? '';
  if (file.includes('long')) { done(0, '', '86400.0\n'); return; }
  if (file.includes('noprobe')) { done(1, 'noprobe: Invalid data\n'); return; }
  done(0, '', '12.5\n');
}

function ffmpeg(): void {
  const input = after('-i');
  const wav = args[args.length - 1] ?? '';
  if (input.includes('corrupt')) { done(1, `${input}: Invalid data found when processing input\n`); return; }
  writeFileSync(wav, 'RIFF fake wav');
  done(0, 'size=       1kB time=00:00:12.50\n');
}

// Not the slow model's runs: they are killed 300 ms in, sometimes before this line, so the log's order would vary.
if (log && !after('-m').includes('m-slow')) appendFileSync(log, JSON.stringify(masked) + '\n');
if (args.includes('-oj')) await whisperCli();
else if (args.includes('-show_entries')) ffprobe();
else if (args.includes('-nostdin')) ffmpeg();
else ytDlp();
