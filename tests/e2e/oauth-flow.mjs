// Full sign-in flow, end to end, through a real browser.
//
// A mock OIDC provider stands in for Google: it implements the authorize
// endpoint (which normally shows the account chooser) and the token endpoint.
// Everything else is Echo's real code — real redirects, real cookies, real
// callback, real session, real sync.
//
// NOT part of `npm test`: it needs Playwright, which is deliberately not a
// dependency of this repo. Run it after touching auth.js, the auth routes, or
// the account UI:
//
//     npm i --no-save playwright && npx playwright install chromium
//     node tests/e2e/oauth-flow.mjs
//     # or against a Chromium already present:
//     ECHO_CHROMIUM=/path/to/chrome node tests/e2e/oauth-flow.mjs
//
// What it does NOT prove: that Google's own configuration is right. The
// redirect URI allow-list and the consent screen live in Google Cloud Console
// and can only be checked with a real client.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'This harness needs Playwright, which is not a dependency of this repo.\n' +
    '  npm i --no-save playwright && npx playwright install chromium'
  );
  process.exit(2);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'echo-oauth-flow-'));

const MOCK_PORT = 8140;
const ECHO_PORT = 8141;
const CLIENT_ID = 'mock-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'mock-client-secret';
const SUB = 'mock-google-sub-12345';
const EMAIL = 'real.flow@example.com';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// --- Mock Google -----------------------------------------------------------
const issued = new Map(); // code -> { challenge, redirectUri }

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);

  // The account chooser. Google would render a page here; we approve at once
  // and bounce straight back with a code, which is what a user's click does.
  if (url.pathname === '/authorize') {
    const code = `code-${Math.random().toString(16).slice(2)}`;
    issued.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirectUri: url.searchParams.get('redirect_uri'),
      clientId: url.searchParams.get('client_id'),
    });
    mock.lastAuthorize = Object.fromEntries(url.searchParams);
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  // The token endpoint. Verifies the PKCE verifier and the client secret the
  // way Google would, then mints an ID token.
  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const form = new URLSearchParams(body);
      mock.lastTokenRequest = Object.fromEntries(form);
      const record = issued.get(form.get('code'));

      const fail = (why) => {
        mock.tokenFailure = why;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: why }));
      };

      if (!record) return fail('invalid_grant');
      if (form.get('client_secret') !== CLIENT_SECRET) return fail('invalid_client');

      // PKCE: S256(verifier) must equal the challenge sent at /authorize.
      const verifier = form.get('code_verifier');
      const computed = createHash('sha256').update(verifier || '').digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (computed !== record.challenge) return fail('invalid_pkce');

      issued.delete(form.get('code')); // codes are single-use, as Google's are
      const idToken = `${b64({ alg: 'RS256' })}.${b64({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: SUB,
        email: EMAIL,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}.mock-signature`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id_token: idToken, access_token: 'mock', token_type: 'Bearer' }));
    });
  }

  res.writeHead(404).end();
});

await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

// --- Echo, pointed at the mock --------------------------------------------
const echo = spawn(process.execPath, ['server.js'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    ECHO_MODE: 'web',
    PORT: String(ECHO_PORT),
    ECHO_DB_PATH: join(TMP, 'flow-main.db'),
    ECHO_SYNC_DB_PATH: join(TMP, 'flow-sync.db'),
    ECHO_GOOGLE_CLIENT_ID: CLIENT_ID,
    ECHO_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    ECHO_SESSION_SECRET: 'flow-test-session-secret',
    ECHO_PUBLIC_URL: `http://127.0.0.1:${ECHO_PORT}`,
    ECHO_GOOGLE_AUTH_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}/authorize`,
    ECHO_GOOGLE_TOKEN_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}/token`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error(`echo did not start: ${buf}`)), 15000);
  echo.stdout.on('data', (d) => { buf += d; if (/Listening on/.test(buf)) { clearTimeout(t); resolve(); } });
  echo.stderr.on('data', (d) => { buf += d; });
});

const BASE = `http://127.0.0.1:${ECHO_PORT}`;

// --- Drive it --------------------------------------------------------------
const executablePath = process.env.ECHO_CHROMIUM || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#settingsBtn');
await page.waitForTimeout(500);

check('the sign-in button is offered when accounts are configured',
  await page.isVisible('#signInBtn'));

// The click that starts everything: Echo → mock authorize → back to callback.
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith('/api/'), { timeout: 15000 }),
  page.click('#signInBtn'),
]);
await page.waitForTimeout(1500);

check('the flow lands back on Echo', page.url().startsWith(BASE), page.url());
check('PKCE challenge was sent to the provider',
  !!(mock.lastAuthorize && mock.lastAuthorize.code_challenge) && mock.lastAuthorize.code_challenge_method === 'S256');
check('only openid+email were requested',
  mock.lastAuthorize && mock.lastAuthorize.scope === 'openid email', mock.lastAuthorize?.scope);
check('the code exchange sent the verifier and the secret',
  !!(mock.lastTokenRequest && mock.lastTokenRequest.code_verifier && mock.lastTokenRequest.client_secret));
check('the provider accepted the exchange (PKCE verified)', !mock.tokenFailure, mock.tokenFailure || '');

// A session should now exist.
const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
check('a session was established for the right account', me.user && me.user.email === EMAIL,
  JSON.stringify(me));

// The signed-in UI should reflect it without a manual reload.
await page.click('#settingsBtn').catch(() => {});
await page.waitForTimeout(500);
check('the UI shows the signed-in account',
  await page.evaluate(() => document.getElementById('accountEmail')?.textContent) === EMAIL);

// Sync should work for that session.
await page.evaluate(async () => {
  await Library.saveEntry({
    videoId: 'flowvideo01',
    url: 'https://www.youtube.com/watch?v=flowvideo01',
    title: 'Saved after a real sign-in',
    segments: [{ text: 'it works', offset: 0 }],
  });
});
await page.waitForTimeout(2500);

const pulled = await page.evaluate(async () => (await fetch('/api/sync/pull')).json());
check('the library synced under the new session',
  Array.isArray(pulled.entries) && pulled.entries.some((e) => e.videoId === 'flowvideo01'),
  JSON.stringify(pulled).slice(0, 120));

// Signing out must actually end the session.
await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST' }); });
const after = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
check('signing out ends the session', after.user === null, JSON.stringify(after));

// A second sign-in must reuse the same account, not create another.
await page.goto(`${BASE}/api/auth/google`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const me2 = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
check('signing in again returns to the same account', me2.user && me2.user.email === EMAIL);
const pulled2 = await page.evaluate(async () => (await fetch('/api/sync/pull')).json());
check('the library is still there after signing back in',
  pulled2.entries.some((e) => e.videoId === 'flowvideo01'));

check('no page errors throughout', errors.length === 0, errors.join(' | '));

await browser.close();
echo.kill();
await new Promise((r) => mock.close(r));

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   → ${r.detail}`}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
