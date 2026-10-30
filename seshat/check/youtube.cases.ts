// The youtube-transcript package against seshat/youtube.ts, through the package's own `fetch` option: a
// stand-in YouTube answers each request from a script, and every request made is printed too, so the two
// must ask for the same things in the same order as well as return the same segments or errors.
import { fetchTranscript, type FetchInit } from '../youtube.ts';
import { out } from './out.ts';

interface Answer { status: number; body: string }
interface Script {
  player?: Answer | 'throw';
  page?: Answer | 'throw';
  tracks?: Record<string, Answer>;
}

const ID = 'GRzaq5AHiV8';
const T = 'https://www.youtube.com/api/timedtext?v=GRzaq5AHiV8';
const json = (v: unknown): Answer => ({ status: 200, body: JSON.stringify(v) });
const tracklist = (tracks: unknown[]): unknown => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
const page = (player: unknown, extra = ''): Answer => ({
  status: 200,
  body: `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var other = {"a":1};</script>${extra}"playabilityStatus":{}</html>`,
});

const SRV3 = '<timedtext format="3"><body>'
  + '<p t="1200" d="2000"><s>Hello</s><s t="300"> world</s></p>'
  + '<p t="3400" d="1000" w="1">Plain &amp;amp; &lt;b&gt;tags&lt;/b&gt; <font color="#fff">inside</font></p>'
  + '<p t="5000" d="10"></p>'
  + '<p t="6000" d="1500"><s>caf&#233; &#x1F600; &quot;q&quot; &#39;s&#39; &apos;a&apos;</s></p>'
  + '<p t="9000" d="1000">  \n  </p>'
  + '</body></timedtext>';
const CLASSIC = '<transcript><text start="0.5" dur="1.25">first &amp;#39;line&amp;#39;</text>'
  + '<text start="2" dur="3">second &amp;quot;line&amp;quot;</text><text start="x" dur="y">odd</text>'
  + '<text start="7.75" dur="1"></text></transcript>';

// The script the stand-in answers from, and the requests it was sent.
let script: Script = {};
let requests: string[] = [];

async function fake(url: string, init: FetchInit): Promise<Response> {
  // Field by field: the package passes two shapes of init, and Seshat prints a type's keys in the first
  // literal's order (being changed there to each value's own order).
  requests.push(JSON.stringify({ url, method: init.method, headers: init.headers, body: init.body }));
  let answer: Answer | 'throw' | undefined;
  if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) answer = script.player;
  else if (url.startsWith('https://www.youtube.com/watch?v=')) answer = script.page;
  else answer = script.tracks?.[url];
  // shortcut: typeof, because Seshat doesn't narrow on `=== 'throw'` (gap: literal-equality-narrowing).
  if (typeof answer === 'string') throw new Error(`network down for ${url}`);
  if (answer === undefined) return new Response('nope', { status: 404 });
  return new Response(answer.body, { status: answer.status });
}

async function run(name: string, id: string, lang: string | undefined, given: Script): Promise<void> {
  script = given;
  requests = [];
  let result: unknown;
  try {
    result = await fetchTranscript(id, lang === undefined ? { fetch: fake } : { lang, fetch: fake });
  } catch (e) {
    result = e instanceof Error ? `ERR ${e.message}` : 'ERR (not an Error)';
  }
  out(name, { result, requests });
}

const EN = { languageCode: 'en', baseUrl: `${T}&lang=en` };
const DE = { languageCode: 'de', baseUrl: `${T}&lang=de` };
const srv3 = { status: 200, body: SRV3 };

await run('innertube, first track', ID, undefined, { player: json(tracklist([EN, DE])), tracks: { [EN.baseUrl]: srv3 } });
await run('innertube, lang de', ID, 'de', { player: json(tracklist([EN, DE])), tracks: { [DE.baseUrl]: { status: 200, body: CLASSIC } } });
await run('innertube, lang missing', ID, 'fr', { player: json(tracklist([EN, DE, { baseUrl: 'x' }, { languageCode: null }])), page: page(tracklist([EN])) });
await run('innertube 500, page', ID, 'en', { player: { status: 500, body: '' }, page: page(tracklist([EN])), tracks: { [EN.baseUrl]: srv3 } });
await run('innertube bad json, page classic', ID, undefined, { player: { status: 200, body: '{not json' }, page: page(tracklist([DE])), tracks: { [DE.baseUrl]: { status: 200, body: CLASSIC } } });
await run('innertube throws, page', ID, undefined, { player: 'throw', page: page(tracklist([EN])), tracks: { [EN.baseUrl]: srv3 } });
await run('innertube no tracks, recaptcha', ID, undefined, { player: json({ captions: {} }), page: { status: 200, body: '<div class="g-recaptcha"></div>' } });
await run('page without playabilityStatus', 'https://youtu.be/GRzaq5AHiV8', undefined, { player: json({}), page: { status: 200, body: '<html></html>' } });
await run('page without tracks', ID, undefined, { player: json(tracklist([])), page: page({ captions: null }) });
await run('page json with a brace in a string', ID, undefined, { player: json({}), page: page({ title: 'a } b', captions: tracklist([EN]) }) });
await run('page throws', ID, undefined, { player: json({}), page: 'throw' });
await run('track on another host', ID, undefined, { player: json(tracklist([{ languageCode: 'en', baseUrl: 'https://evil.example.com/x' }])), page: page(tracklist([{ languageCode: 'en', baseUrl: 'https://evil.example.com/x' }])) });
await run('track url invalid', ID, undefined, { player: json({}), page: page(tracklist([{ languageCode: 'en', baseUrl: 'not a url' }])) });
await run('track url missing', ID, undefined, { player: json({}), page: page(tracklist([{ languageCode: 'en' }])) });
await run('track null', ID, undefined, { player: json({}), page: page(tracklist([null])) });
await run('track fetch 404', ID, undefined, { player: json(tracklist([EN])), page: page(tracklist([EN])), tracks: { [EN.baseUrl]: { status: 404, body: '' } } });
await run('track body empty', ID, undefined, { player: json(tracklist([EN])), tracks: { [EN.baseUrl]: { status: 200, body: '' } } });
await run('track host youtube.com itself', ID, undefined, { player: json({}), page: page(tracklist([{ languageCode: 'en', baseUrl: 'https://youtube.com/api' }])) });
await run('id from embed url', 'https://www.youtube.com/embed/GRzaq5AHiV8?start=3', 'en', { player: json(tracklist([EN])), tracks: { [EN.baseUrl]: srv3 } });
await run('id not found', 'not a video', undefined, {});
await run('lang empty string', ID, '', { player: json(tracklist([EN, DE])), tracks: { [EN.baseUrl]: srv3 } });
