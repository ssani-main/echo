// transcript.js's fetching against the port, on the real YouTube and the real yt-dlp: oEmbed, the track list,
// captions through the youtube-transcript package against youtube.ts, and yt-dlp's json3 fallback. Needs the
// network and yt-dlp on PATH; YouTube's answers can change between the three runs, so a difference here is
// worth one rerun before it is believed.
import { getVideoMeta, listCaptionTracks, fetchViaPackage, fetchTranscript, type Segments } from '../transcript.ts';
import { out } from './out.ts';

const ID = 'GRzaq5AHiV8';

/** A transcript in a line: its length, track, ends and total text, rather than every segment. */
function summary(segments: Segments): unknown {
  return {
    count: segments.length,
    langUsed: segments.langUsed ?? null,
    first: segments.slice(0, 3),
    last: segments.slice(-2),
    chars: segments.reduce((n, s) => n + s.text.length, 0),
    offsets: segments.reduce((n, s) => n + s.offset, 0),
  };
}

async function attempt(name: string, f: () => Promise<unknown>): Promise<void> {
  try {
    out(name, await f());
  } catch (e: any) {
    out(name, { error: String(e.message), echoCode: e.echoCode ?? null, reason: e.reason ?? null });
  }
}

const disabled = async (_id: string, _lang: string | undefined): Promise<Segments> => {
  throw new Error(`[YoutubeTranscript] 🚨 Transcript is disabled on this video (${ID})`);
};

await attempt('getVideoMeta', () => getVideoMeta(ID));
await attempt('getVideoMeta missing video', () => getVideoMeta('aaaaaaaaaa0'));
await attempt('listCaptionTracks', async () => {
  const tracks = await listCaptionTracks(ID);
  return { count: tracks.length, manual: tracks.filter((t) => !t.auto), first: tracks.slice(0, 5), last: tracks.slice(-2) };
});
await attempt('listCaptionTracks missing video', () => listCaptionTracks('aaaaaaaaaa0'));
await attempt('captions', async () => summary(await fetchViaPackage(ID, undefined)));
await attempt('captions en', async () => summary(await fetchViaPackage(ID, 'en')));
await attempt('captions in a missing language', async () => summary(await fetchViaPackage(ID, 'xx')));
await attempt('yt-dlp fallback', async () => summary(await fetchTranscript(ID, { retryDelaysMs: [], primaryFetcher: disabled })));
await attempt('yt-dlp fallback, missing language', async () => summary(await fetchTranscript(ID, { lang: 'zz', retryDelaysMs: [], primaryFetcher: disabled })));
