// Does the page actually render correctly? A unit test structurally cannot say.
//
// `node --test` never loads public/index.html in a browser, so every layout
// rule in app.css is unasserted. That is not theoretical: two regressions
// shipped past a fully green suite and were caught by a human noticing the
// page "looked kind of broken" —
//
//   1. .local-file-row was never enrolled in the top-chrome group, so it
//      stretched to --col-max and hung 120px outside the reading column.
//   2. .command-bar kept a `flex-direction: column` override written for a
//      "Get transcript" button that no longer exists, so on a phone it stacked
//      a decorative glyph above a half-width input.
//
// Both are invariants a browser can check in a second. This file checks them.
//
// NOT part of `npm test`: the glob is tests/*.test.js, and this needs a real
// Chrome. It needs no npm dependency though — Node 22 ships a global WebSocket,
// so it drives Chrome's DevTools Protocol directly.
//
//     npm run test:page
//     ECHO_CHROME=/path/to/chrome npm run test:page
//
// Missing Chrome is a skip locally and a failure in CI (ECHO_REQUIRE_BROWSER=1),
// so it can never silently stop running where it is meant to run.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRE_BROWSER = process.env.ECHO_REQUIRE_BROWSER === '1';

// An explicitly-set ECHO_CHROME is authoritative: if it is wrong, say so rather
// than quietly testing a different browser than the one that was asked for.
const CHROME_CANDIDATES = process.env.ECHO_CHROME
  ? [process.env.ECHO_CHROME]
  : [
      'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
      '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium',
    ];

function resolveChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) {
      if (existsSync(c)) return c;
      continue;
    }
    try {
      const p = execFileSync('which', [c], { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch { /* not on PATH */ }
  }
  return null;
}

const CHROME = resolveChrome();
if (!CHROME) {
  const msg = 'no Chrome found (set ECHO_CHROME to a binary path)';
  if (REQUIRE_BROWSER) { console.error(`FAIL  ${msg} — required because ECHO_REQUIRE_BROWSER=1`); process.exit(1); }
  console.log(`SKIP  page smoke test: ${msg}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) { passes.push(name); console.log(`  pass  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- boot a real server, the way a user runs one ------------------------------
const dbDir = mkdtempSync(join(tmpdir(), 'echo-smoke-'));
const dbPath = join(dbDir, 'smoke.db');
const PORT = 8731;
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), ECHO_DB_PATH: dbPath, ECHO_MODE: process.env.ECHO_MODE || 'local' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}

// --- drive Chrome over CDP ----------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'echo-smoke-chrome-'));
const CDP_PORT = 9455;
let chrome, ws;

function cleanup(code) {
  try { ws?.close(); } catch { /* already closed */ }
  try { chrome?.kill(); } catch { /* already dead */ }
  try { server.kill(); } catch { /* already dead */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const badResponses = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text || 'evaluate failed'));
  return r.result.result.value;
}

/** Load the landing page fresh at a given viewport and return measurements. */
async function measureAt(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await send('Page.navigate', { url: BASE });
  await sleep(2000);
  return evaluate(`
    (() => {
      // Runs FIRST, before anything below is force-revealed, or it would mask
      // the very leak it exists to catch. A class that sets display beats the
      // UA [hidden] rule, so el.hidden can silently do nothing — the local-file
      // row was always visible that way, including in web mode where its route
      // 503s. checkVisibility() rather than computed display: a child of a
      // display:none ancestor still computes its own display, which would
      // report every guard-less element inside a closed pane.
      // (No backticks anywhere in this block: it lives inside a template
      // literal, and one would terminate it.)
      const hiddenLeaks = [];
      for (const el of document.querySelectorAll('[hidden]')) {
        if (el.checkVisibility && el.checkVisibility()) {
          hiddenLeaks.push(el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0]);
        }
      }

      // The local-file row only reveals itself once Whisper has a binary AND a
      // model, which CI has neither of. Force every top-chrome member visible
      // before measuring: this asserts the *layout rule*, not the reveal logic,
      // and without it CI would silently skip the very element that regressed.
      for (const sel of ['#localFileRow', '#status', '.next-action-nudge']) {
        const el = document.querySelector(sel);
        if (el) { el.hidden = false; if (!el.textContent.trim()) el.textContent = '\\u200b'; }
      }
      const group = ['.hero-title', '.command-bar', '#localFileRow', '#status', '.next-action-nudge'];
      const boxes = {};
      for (const sel of group) {
        const el = document.querySelector(sel);
        if (!el) { boxes[sel] = null; continue; }
        const b = el.getBoundingClientRect();
        boxes[sel] = { left: Math.round(b.left), width: Math.round(b.width) };
      }
      // Vertical rhythm: nothing in the top-chrome stack should butt directly
      // against its neighbour. The local-file row shipped with margin-bottom: 0.
      const stack = ['.command-bar', '#localFileRow', '#status'].map((s) => document.querySelector(s)).filter(Boolean);
      const tightGaps = [];
      for (let i = 1; i < stack.length; i++) {
        const gap = stack[i].getBoundingClientRect().top - stack[i - 1].getBoundingClientRect().bottom;
        // Plain concatenation, not a nested template literal: this whole block
        // is itself inside one, and a nested backtick would terminate it.
        if (gap < 4) {
          const from = stack[i - 1].id || stack[i - 1].className;
          const to = stack[i].id || stack[i].className;
          tightGaps.push(from + '->' + to + '=' + Math.round(gap) + 'px');
        }
      }

      const bar = document.querySelector('.command-bar');
      const glyph = document.querySelector('.command-glyph');
      const input = document.querySelector('#urlInput');
      const fileBtn = document.querySelector('#localFileBtn');
      const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
      let sheetRules = 0;
      for (const s of document.styleSheets) { try { sheetRules += s.cssRules.length; } catch { /* cross-origin */ } }
      return {
        boot: !!input,
        boxes,
        sheetRules,
        barDirection: bar ? getComputedStyle(bar).flexDirection : null,
        glyphInline: (glyph && input) ? Math.abs(mid(glyph) - mid(input)) < 6 : null,
        inputWidth: input ? Math.round(input.getBoundingClientRect().width) : 0,
        // Boxes lining up is not the same as text lining up: the field insets
        // its own text by border + padding + glyph, so the link below it needs
        // a matching indent or it reads as shoved to the left.
        textOffset: (input && fileBtn)
          ? Math.round(input.getBoundingClientRect().left - fileBtn.getBoundingClientRect().left)
          : null,
        barWidth: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        hiddenLeaks,
        tightGaps,
      };
    })()
  `);
}

/** Every visible member of the top-chrome group must share one column. */
function assertColumn(label, boxes) {
  const present = Object.entries(boxes).filter(([, b]) => b && b.width > 0);
  if (present.length < 2) { check(`${label}: top-chrome group is measurable`, false, 'fewer than 2 members found'); return; }
  const [, first] = present[0];
  const strays = present.filter(([, b]) => Math.abs(b.left - first.left) > 2 || Math.abs(b.width - first.width) > 2);
  check(
    `${label}: every top-chrome element shares one column`,
    strays.length === 0,
    strays.length ? strays.map(([sel, b]) => `${sel} at left=${b.left} w=${b.width} vs left=${first.left} w=${first.width}`).join('; ') : ''
  );
}

try {
  if (!(await waitForServer())) { console.error('FAIL  server never became healthy'); cleanup(1); }

  chrome = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  if (!target) { console.error('FAIL  Chrome never exposed a page target'); cleanup(1); }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('uncaught: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      badResponses.push(`${m.params.response.status} ${m.params.response.url}`);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  console.log('\ndesktop (1440x900)');
  const desktop = await measureAt(1440, 900);
  check('desktop: page boots and the app renders', desktop.boot === true);
  check('desktop: stylesheets load and apply', desktop.sheetRules > 100, `only ${desktop.sheetRules} rules parsed`);
  assertColumn('desktop', desktop.boxes);
  check('desktop: command bar is a row', desktop.barDirection === 'row', `got ${desktop.barDirection}`);
  check('desktop: glyph sits inline with the input', desktop.glyphInline === true);
  check('desktop: the file link starts where the URL text starts', Math.abs(desktop.textOffset) <= 2,
    `link text is ${desktop.textOffset}px from the input text`);
  check('desktop: no horizontal overflow', desktop.scrollWidth <= desktop.innerWidth + 1,
    `scrollWidth ${desktop.scrollWidth} > innerWidth ${desktop.innerWidth}`);
  check('desktop: [hidden] actually hides', desktop.hiddenLeaks.length === 0,
    `still visible: ${desktop.hiddenLeaks.join(', ')}`);
  check('desktop: nothing in the top-chrome stack touches its neighbour', desktop.tightGaps.length === 0,
    desktop.tightGaps.join(', '));

  console.log('\nmobile (390x844)');
  const mobile = await measureAt(390, 844);
  check('mobile: page boots and the app renders', mobile.boot === true);
  assertColumn('mobile', mobile.boxes);
  check('mobile: command bar stays a row', mobile.barDirection === 'row', `got ${mobile.barDirection}`);
  check('mobile: glyph sits inline with the input', mobile.glyphInline === true);
  // The regression shrank the input to roughly half the bar. Anything under
  // two-thirds means something is stacking or floating beside it again.
  check('mobile: input fills most of the command bar', mobile.inputWidth > mobile.barWidth * 0.66,
    `input ${mobile.inputWidth}px inside a ${mobile.barWidth}px bar`);
  check('mobile: the file link starts where the URL text starts', Math.abs(mobile.textOffset) <= 2,
    `link text is ${mobile.textOffset}px from the input text`);
  check('mobile: no horizontal overflow', mobile.scrollWidth <= mobile.innerWidth + 1,
    `scrollWidth ${mobile.scrollWidth} > innerWidth ${mobile.innerWidth}`);

  console.log('\npage health');
  // The landing page only exposes the elements visible at rest. Panes the user
  // opens are where guard-less [hidden] elements actually surface: the digest
  // export row (Copy / Download .md / Print) appeared with nothing to export
  // the moment the Digest tab was opened, because `hidden` was doing nothing.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(2000);
  const paneLeaks = await evaluate(`
    (() => {
      const leaks = [];
      const scan = (where) => {
        for (const el of document.querySelectorAll('[hidden]')) {
          if (el.checkVisibility && el.checkVisibility()) {
            leaks.push(where + ':' + (el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0]));
          }
        }
      };
      scan('landing');
      for (const id of ['#tabDigest', '#tabTranscript', '#libraryBtn']) {
        const tab = document.querySelector(id);
        if (tab) { tab.click(); scan(id); }
      }
      return leaks;
    })()
  `);
  check('[hidden] holds in every pane the user can open', paneLeaks.length === 0, paneLeaks.join(', '));

  // The landing page is not the layout users spend their time in. Once a
  // transcript loads, body.has-transcript hides the hero and reveals the
  // content header and lens tabs — a different stack, and one where the
  // local-file row misalignment was first spotted by eye. Simulated rather
  // than fetched: CI has no network, and this asserts the CSS, not the fetch.
  console.log('\nloaded state (has-transcript)');
  const loaded = await evaluate(`
    (() => {
      document.body.classList.add('has-transcript');
      for (const sel of ['#localFileRow', '#status', '.content-header', '.tab-bar']) {
        const el = document.querySelector(sel);
        if (el) { el.hidden = false; if (!el.textContent.trim()) el.textContent = '\\u200b'; }
      }
      const group = ['.command-bar', '#localFileRow', '#status', '.content-header', '.tab-bar'];
      const boxes = {};
      for (const sel of group) {
        const el = document.querySelector(sel);
        if (!el) { boxes[sel] = null; continue; }
        const b = el.getBoundingClientRect();
        boxes[sel] = { left: Math.round(b.left), width: Math.round(b.width) };
      }
      const hero = document.querySelector('.hero-landing');
      return {
        boxes,
        heroHidden: hero ? getComputedStyle(hero).display === 'none' : null,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()
  `);
  check('loaded: the hero gives way to the reader', loaded.heroHidden === true);
  assertColumn('loaded', loaded.boxes);
  check('loaded: no horizontal overflow', loaded.scrollWidth <= loaded.innerWidth + 1,
    `scrollWidth ${loaded.scrollWidth} > innerWidth ${loaded.innerWidth}`);

  check('no uncaught JS errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests on the landing page', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

  console.log(`\n${passes.length}/${passes.length + failures.length} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  cleanup(failures.length ? 1 : 0);
} catch (err) {
  console.error('FAIL  page smoke test threw:', err && err.message ? err.message : err);
  cleanup(1);
}
