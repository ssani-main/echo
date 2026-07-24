// End-to-end check of the Chrome extension, driven through a real Chromium
// with the unpacked extension loaded.
//
// Not part of `npm test`: it needs Playwright, which is deliberately NOT a
// dependency of this repo (the suite stays dependency-free and sub-3s). Run it
// by hand after touching content.js / background.js / the manifest:
//
//     npx playwright install chromium     # once
//     node extension/test/e2e.mjs
//
// Two things it must keep proving, because both are invisible to unit tests:
//   - the content script survives YouTube's SPA navigation (no reload between
//     videos), and
//   - a click actually lands on the configured Echo server with ?v=<id>.
//
// NOTE: `channel: 'chromium'` is required. Playwright's default headless build
// is the headless *shell*, which cannot load extensions at all — the symptom is
// zero service workers and no injected button, with no error.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// Resolved at runtime so the failure is a sentence rather than ERR_MODULE_NOT_FOUND.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'This harness needs Playwright, which is not a dependency of this repo.\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n' +
    '  (or run with NODE_PATH pointing at a global install)'
  );
  process.exit(2);
}

// Stand-in for a running Echo so the opened tab actually resolves — otherwise
// the navigation fails and we would be asserting against chrome-error://.
const echoStub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Echo stub</title><body data-req="${req.url}">`);
});
await new Promise((r) => echoStub.listen(8000, '127.0.0.1', r));

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'echo-ext-'));

// A stand-in for YouTube's watch page: only the bits the content script needs.
const WATCH_PAGE = (title) => `<!doctype html><html><head><title>${title}</title></head>
<body>
  <ytd-watch-metadata>
    <div id="actions">
      <div id="top-level-buttons-computed">
        <button id="yt-like">Like</button>
        <button id="yt-share">Share</button>
      </div>
    </div>
  </ytd-watch-metadata>
</body></html>`;

// ECHO_CHROMIUM lets you point at a Chromium that is already on the machine
// (a system install, or a Playwright browser cache belonging to a different
// Playwright version) instead of downloading one.
const executablePath = process.env.ECHO_CHROMIUM || undefined;

const ctx = await chromium.launchPersistentContext(userDataDir, {
  // 'chromium' is the FULL build. The default headless shell cannot load
  // extensions — see the note at the top of this file.
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); };

const page = await ctx.newPage();
// Serve the fixture AS youtube.com so the content-script match pattern applies.
await page.route('https://www.youtube.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: WATCH_PAGE('Video One') }));

await page.goto('https://www.youtube.com/watch?v=GRzaq5AHiV8');
await page.waitForSelector('#echo-read-button', { timeout: 8000 });

const btn = await page.$('#echo-read-button');
check('button injects on a watch page', !!btn);
check('button label reads "Read in Echo"', (await btn.innerText()).trim() === 'Read in Echo',
  await btn.innerText());
check('button carries the current video id', await btn.getAttribute('data-video-id') === 'GRzaq5AHiV8',
  await btn.getAttribute('data-video-id'));
check('button is placed first in the actions row',
  await page.evaluate(() => document.querySelector('#top-level-buttons-computed').firstElementChild.id === 'echo-read-button'));

// Clicking must open Echo at the configured server with ?v=<id>.
const [newPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }),
  btn.click(),
]);
check('click opens Echo with the right deep link',
  newPage.url() === 'http://localhost:8000/?v=GRzaq5AHiV8', newPage.url());
await newPage.close();

// SPA navigation: URL changes with no reload, button must follow.
await page.evaluate(() => {
  history.pushState({}, '', '/watch?v=dQw4w9WgXcQ');
  document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
});
await page.waitForFunction(
  () => document.querySelector('#echo-read-button')?.dataset.videoId === 'dQw4w9WgXcQ',
  null, { timeout: 8000 }).catch(() => {});
check('button follows SPA navigation to a new video',
  await page.$eval('#echo-read-button', (el) => el.dataset.videoId) === 'dQw4w9WgXcQ',
  await page.$eval('#echo-read-button', (el) => el.dataset.videoId));

// Leaving a video page must remove it.
await page.evaluate(() => {
  history.pushState({}, '', '/feed/subscriptions');
  document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
});
await page.waitForFunction(() => !document.querySelector('#echo-read-button'), null, { timeout: 8000 }).catch(() => {});
check('button is removed when not on a video', await page.$('#echo-read-button') === null);

// No duplicate buttons after repeated re-renders.
await page.evaluate(() => {
  history.pushState({}, '', '/watch?v=GRzaq5AHiV8');
  for (let i = 0; i < 5; i++) document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
});
await page.waitForTimeout(600);
check('exactly one button after repeated navigation events',
  (await page.$$('#echo-read-button')).length === 1,
  String((await page.$$('#echo-read-button')).length));

await ctx.close();
await new Promise((r) => echoStub.close(r));

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   → got: ${r.detail}`}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
