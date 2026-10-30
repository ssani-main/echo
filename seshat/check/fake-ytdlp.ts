// A stand-in yt-dlp for check/ytdlp.cases.ts: run.mjs builds it with Seshat as yt-dlp.exe and puts it first on
// PATH for that case file, so the original and the port spawn the same program. It logs its arguments (to
// FAKE_YTDLP_LOG) and answers by the video id at the end of the URL.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_YTDLP_LOG;
// The temp file's name carries Date.now(), so it is masked in the log.
if (log) appendFileSync(log, JSON.stringify(args.map((a) => a.replace(/yt_transcript_[A-Za-z0-9_-]+_\d+/, 'yt_transcript_<id>_<now>'))) + '\n');

const url = args[args.length - 1] ?? '';
const id = url.slice(url.indexOf('v=') + 2);
const listing = args.includes('-J');
const outIndex = args.indexOf('-o');
const langIndex = args.indexOf('--sub-langs');
const base = outIndex >= 0 ? args[outIndex + 1] ?? '' : '';
const lang = langIndex >= 0 ? args[langIndex + 1] ?? '' : '';

const JSON3 = '{"wireMagic": "pb3", "events": ['
  + '{"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "Hello"}, {"utf8": " world", "tOffsetMs": 300}]},'
  + '{"tStartMs": 1500, "segs": [{"utf8": "\\n"}]},'
  + '{"tStartMs": 2000, "dDurationMs": 800},'
  + '{"tStartMs": 2500, "segs": [{"utf8": "it&amp;#39;s\\nsplit &amp;quot;here&amp;quot; &lt;tag&gt;"}]},'
  + '{"segs": [{"utf8": "no start"}, {"tOffsetMs": 5}, {"utf8": ""}]},'
  + '{"tStartMs": 7250, "segs": [{"utf8": "  caf\\u00e9 \\ud83d\\ude00  "}]}]}';

function fail(stderr: string, code: number): void {
  process.stderr.write(stderr);
  process.exit(code);
}

if (listing) {
  if (id === 'listJunk001') {
    process.stdout.write('{"automatic_captions": {"en": [{"name": "English (auto)"}], "de": [], "fr": "x", "zh-Hans": [{}]},'
      + ' "subtitles": {"en": [{"name": "English"}], "es": [{"name": "Spanish", "ext": "vtt"}]}}');
  } else if (id === 'listNone001') {
    process.stdout.write('{}');
  } else if (id === 'listHuge001') {
    // Over execFile's default 1 MiB maxBuffer.
    process.stdout.write(`{"subtitles": {"en": [{"name": "English"}]}, "padding": "${'x'.repeat(1_200_000)}"}`);
  } else if (id === 'listBroken1') {
    process.stdout.write('{not json');
  } else {
    fail(`ERROR: [youtube] ${id}: Video unavailable\n`, 1);
  }
} else if (id === 'json3ok0001') {
  writeFileSync(`${base}.${lang}.json3`, JSON3);
} else if (id === 'json3empty1') {
  writeFileSync(`${base}.${lang}.json3`, '{"events": [{"tStartMs": 1, "segs": [{"utf8": " "}]}]}');
} else if (id === 'json3noev01') {
  writeFileSync(`${base}.${lang}.json3`, '{}');
} else if (id === 'json3broken') {
  writeFileSync(`${base}.${lang}.json3`, '{"events": [');
} else if (id === 'nosubs00001') {
  // Runs fine and writes nothing: captions off.
} else if (id === 'members0001') {
  fail('ERROR: [youtube] members0001: Join this channel to get access to members-only content like this video\n', 1);
} else if (id === 'botblock001') {
  fail("ERROR: [youtube] botblock001: Sign in to confirm you're not a bot. Use --cookies-from-browser\n", 1);
} else {
  fail(`ERROR: [youtube] ${id}: Premieres in 3 days\n`, 1);
}
