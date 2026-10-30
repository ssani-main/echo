// transcript.js's yt-dlp paths against the port, with check/fake-ytdlp.ts as yt-dlp: run.mjs builds it and puts
// it first on PATH (and FAKE_YTDLP_LOG, the arguments it was given). The json3 parsing, a track that wasn't
// written, yt-dlp's failures, and the track list (junk, a missing video, more output than execFile's 1 MiB).
import { fetchTranscript, listCaptionTracks, type Segments, type FetchTranscriptOptions } from '../transcript.ts';
import { readFileSync, rmSync } from 'node:fs';
import { out } from './out.ts';

const log = process.env.FAKE_YTDLP_LOG!;
rmSync(log, { force: true });

const disabled = async (id: string, _lang: string | undefined): Promise<Segments> => {
  throw new Error(`[YoutubeTranscript] 🚨 Transcript is disabled on this video (${id})`);
};

async function captions(id: string, lang?: string): Promise<void> {
  let result: unknown;
  try {
    const opts: FetchTranscriptOptions = { retryDelaysMs: [], primaryFetcher: disabled };
    if (lang !== undefined) opts.lang = lang;
    const segments = await fetchTranscript(id, opts);
    result = { segments, langUsed: segments.langUsed ?? null };
  } catch (e: any) {
    // The detail quotes yt-dlp's command line, whose temp file name carries Date.now().
    const detail = String(e.detail).replace(/yt_transcript_[A-Za-z0-9_-]+_\d+/g, 'yt_transcript_<id>_<now>');
    result = { message: e.message, echoCode: e.echoCode, reason: e.reason ?? null, detail };
  }
  out(`captions ${id}/${lang ?? '-'}`, result);
}

await captions('json3ok0001');
await captions('json3ok0001', 'de');
await captions('json3empty1');
await captions('json3noev01');
await captions('json3broken');
await captions('nosubs00001', 'fr');
await captions('members0001');
await captions('botblock001');
await captions('premiere001');
for (const id of ['listJunk001', 'listNone001', 'listHuge001', 'listBroken1', 'missing0001']) {
  out(`tracks ${id}`, await listCaptionTracks(id));
}
out('arguments', readFileSync(log, 'utf8').trimEnd().split('\n'));
