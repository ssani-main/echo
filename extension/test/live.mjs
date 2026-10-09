// Live check of the extension against real YouTube: loads the unpacked
// extension into a real, non-headless Chrome and asserts that the in-page
// button and the toolbar click each open Echo with the transcript in the URL
// fragment — before and after an in-app (SPA) navigation.
//
// Not part of `npm test`: it needs a real Chrome, a residential IP and live
// YouTube. No npm dependency — CDP over a pipe, as in tests/e2e/page-smoke.mjs.
//
//     ECHO_CHROME=/path/to/chrome node extension/test/live.mjs [youtube-url ...]
//
// The extension is pointed at a stub server, so nothing reaches a real Echo.
//
// Two launch details are load-bearing:
//   - `--remote-debugging-pipe` sets navigator.webdriver, and YouTube then
//     answers the transcript panel's get_transcript request with HTTP 400 —
//     the panel spins forever and every scrape "fails". Hence
//     `--disable-blink-features=AutomationControlled`. Headless fails the
//     same way and has no such switch (see CLAUDE.md).
//   - An occluded window stops rendering, so the panel never loads while
//     another window covers this one. Hence the three backgrounding switches.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = 8123;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const urls = process.argv.slice(2);
if (urls.length === 0) urls.push('https://www.youtube.com/watch?v=GRzaq5AHiV8');

if (!process.env.ECHO_CHROME) {
  console.error('Set ECHO_CHROME to a Chrome/Chromium binary (137+, for Extensions.loadUnpacked).');
  process.exit(2);
}

const stub = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Echo stub</title>');
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(process.env.ECHO_CHROME, [
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--disable-blink-features=AutomationControlled',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'echo-ext-live-'))}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1300,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const [, , , toChrome, fromChrome] = chrome.stdio;

// CDP over the pipe: NUL-terminated JSON in both directions.
let nextId = 0;
let buffer = '';
const pending = new Map();
fromChrome.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  pending.set(++nextId, resolve);
  toChrome.write(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const evaluate = async (sessionId, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.error) throw new Error(r.error.message);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
};
const targets = async () => (await send('Target.getTargets')).result.targetInfos;
const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function finish() {
  try { chrome.kill(); } catch { /* already gone */ }
  stub.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

const loaded = await send('Extensions.loadUnpacked', { path: EXT });
if (loaded.error) {
  console.error('Could not load the extension: ' + loaded.error.message);
  failures++;
  finish();
}

let worker;
for (let i = 0; i < 40 && !worker; i++) {
  await sleep(250);
  worker = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(loaded.result.id));
}
const workerSession = await attach(worker.targetId);
await evaluate(workerSession, `chrome.storage.sync.set({ server: '${STUB}' })`);

const page = (await targets()).find((t) => t.type === 'page');
const session = await attach(page.targetId);
await send('Page.enable', {}, session);
// Skip the EU consent interstitial a fresh profile gets.
await send('Network.setCookie', { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', secure: true }, session);

const currentVideo = () => evaluate(session, `new URLSearchParams(location.search).get('v')`);
const transcriptVisible = () => evaluate(session,
  `(() => { const n = document.querySelector('ytd-transcript-segment-renderer, transcript-segment-view-model'); return !!(n && n.offsetParent); })()`);

async function waitForPlayer() {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await evaluate(session, `!!document.querySelector('#movie_player')?.getPlayerResponse?.()`)) break;
  }
  await sleep(5000); // the actions row and description render after the player
}

/** Wait for the tab the extension opens on the stub, decode what its URL carried, close it. */
async function takeOpenedTab(known) {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const tab = (await targets()).find((t) => t.type === 'page' && t.url.startsWith(STUB) && !known.has(t.targetId));
    if (!tab) continue;
    const url = new URL(tab.url);
    const match = url.hash.match(/^#echo-tx=(.+)$/);
    const tx = match ? JSON.parse(gunzipSync(Buffer.from(match[1], 'base64url')).toString('utf8')) : null;
    await send('Target.closeTarget', { targetId: tab.targetId });
    await send('Target.activateTarget', { targetId: page.targetId });
    return { v: url.searchParams.get('v'), tx };
  }
  return null;
}

async function expectHandoff(label, trigger) {
  const videoId = await currentVideo();
  const known = new Set((await targets()).map((t) => t.targetId));
  await trigger(videoId);
  const opened = await takeOpenedTab(known);
  check(`${label}: opens Echo for the video on screen`, !!opened && opened.v === videoId, opened ? `v=${opened.v}` : 'no tab opened');
  const tx = opened && opened.tx;
  check(`${label}: carries the transcript`, !!tx && tx.videoId === videoId && tx.segments.length > 0,
    tx ? `${tx.segments.length} segments, "${tx.title}"` : 'no #echo-tx fragment');
  check(`${label}: carries real timestamps`, !!tx && tx.segments.at(-1).offset > 0);
}

const clickPageButton = () => evaluate(session, `document.getElementById('echo-read-button').click()`);
// A real toolbar click cannot be synthesised over CDP, so dispatch the event
// the worker listens for, with the tab object a real click would hand it.
const clickToolbar = (videoId) => evaluate(workerSession,
  `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
     chrome.action.onClicked.dispatch({ id: tab.id, url: 'https://www.youtube.com/watch?v=${videoId}' });
   })`);

for (const url of urls) {
  console.log(`\n${url}`);
  await send('Page.navigate', { url }, session);
  await waitForPlayer();

  const injected = await evaluate(session, `document.getElementById('echo-read-button')?.dataset.videoId || null`);
  check('button is injected for this video', injected === await currentVideo(), String(injected));
  if (!injected) continue;

  await expectHandoff('in-page button', clickPageButton);
  check('transcript panel is closed again afterwards', !(await transcriptVisible()));

  await evaluate(session, `document.querySelector('ytd-watch-next-secondary-results-renderer a[href^="/watch?v="]').click()`);
  await sleep(1500);
  await waitForPlayer();
  const after = await evaluate(session, `document.getElementById('echo-read-button')?.dataset.videoId || null`);
  check('button follows an in-app navigation', after === await currentVideo(), String(after));

  await expectHandoff('toolbar click after navigation', clickToolbar);
  await expectHandoff('in-page button after navigation', clickPageButton);
}
finish();
