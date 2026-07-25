import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The sign-in and sync routes, driven over real HTTP.
//
// Google itself is never contacted: the redirect step is checked by inspecting
// where the server sends the browser, and everything after sign-in is checked
// by minting a session cookie with the same secret the server was started
// with — which is exactly what the callback would have produced.
//
// The cases that matter here are the refusals: sync without a session, sync
// with a forged cookie, and one account reaching another's library.
// ---------------------------------------------------------------------------

const SECRET = 'integration-test-secret';
const DB = join(tmpdir(), `echo-test-authroutes-${process.pid}-${Date.now()}.db`);
const SYNC_DB = join(tmpdir(), `echo-test-authsync-${process.pid}-${Date.now()}.db`);

process.env.ECHO_DB_PATH = DB;
// Keep this integration test's real route hits out of the real local usage
// meter (data/usage-events.jsonl) — see usagelog.js. Belt and braces: the
// synthetic flag alone still filters at read time, but pointing the log at a
// throwaway path means this test never appends to the real file at all.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-authroutes-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;
process.env.ECHO_SYNC_DB_PATH = SYNC_DB;
process.env.ECHO_GOOGLE_CLIENT_ID = 'test-client-id';
process.env.ECHO_GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.ECHO_SESSION_SECRET = SECRET;
process.env.ECHO_PUBLIC_URL = 'https://echo.test';

const { app } = await import('../server.js');
const { signToken, SESSION_COOKIE, SESSION_TTL_MS } = await import('../auth.js');
const { upsertUser, bumpTokenVersion, getUser } = await import('../syncStore.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  for (const path of [DB, SYNC_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
});

/** A session cookie for a user id, as the callback would have set. */
function sessionCookie(userId, tokenVersion) {
  const tv = tokenVersion === undefined ? (getUser(userId)?.tokenVersion || 0) : tokenVersion;
  const token = signToken({ uid: userId, tv, exp: Date.now() + SESSION_TTL_MS }, SECRET);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

// --- The redirect ----------------------------------------------------------

test('GET /api/auth/google redirects to Google with PKCE and a state cookie', async () => {
  const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
  assert.equal(res.status, 302);

  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('client_id'), 'test-client-id');
  assert.equal(location.searchParams.get('scope'), 'openid email');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('state'), 'state is the CSRF defence');

  // redirect_uri must be built from the configured public origin, since Google
  // matches it against its allow-list exactly.
  assert.equal(location.searchParams.get('redirect_uri'), 'https://echo.test/api/auth/callback');

  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /echo_oauth=/);
  assert.match(setCookie, /HttpOnly/);
});

// --- The callback's refusals ----------------------------------------------

test('the callback refuses a request with no transaction cookie', async () => {
  // i.e. someone hitting the callback URL directly.
  const res = await fetch(`${base}/api/auth/callback?code=abc&state=xyz`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /signin=failed/);
});

test('the callback refuses a state that does not match the one it issued', async () => {
  // CSRF: an attacker-initiated flow arrives with a state we never minted.
  const start = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
  const oauthCookie = (start.headers.get('set-cookie') || '').split(';')[0];

  const res = await fetch(`${base}/api/auth/callback?code=abc&state=not-the-state`, {
    redirect: 'manual',
    headers: { cookie: oauthCookie },
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /signin=failed/);
});

// --- Session state ---------------------------------------------------------

test('GET /api/auth/me reports accounts enabled and nobody signed in', async () => {
  const res = await fetch(`${base}/api/auth/me`);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.user, null);
});

test('GET /api/auth/me returns the signed-in address', async () => {
  const user = upsertUser({ sub: 'route-user-1', email: 'me@example.com' });
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: sessionCookie(user.id) } });
  const body = await res.json();
  assert.equal(body.user.email, 'me@example.com');
});

test('a forged session cookie is not a session', async () => {
  const forged = `${SESSION_COOKIE}=${encodeURIComponent('eyJ1aWQiOiJhZG1pbiJ9.deadbeef')}`;
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: forged } });
  assert.equal((await res.json()).user, null);
});

test('POST /api/auth/logout clears the cookie', async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') || '', /Max-Age=0/);
});

// --- Sync requires a session ----------------------------------------------

test('sync refuses an anonymous caller', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/sync/pull', undefined],
    ['POST', '/api/sync/push', JSON.stringify({ entries: [] })],
  ]) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await res.json()).error.code, 'API_NOT_AUTHED');
  }
});

test('sign-out-everywhere invalidates a session already in use elsewhere', async () => {
  // The scenario: a cookie is on a device you no longer have. Stateless
  // sessions cannot be revoked by expiry alone, so this is the escape hatch.
  const user = upsertUser({ sub: 'revoke-me', email: 'revoke@example.com' });
  const cookie = sessionCookie(user.id);

  const before = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal((await before.json()).user.email, 'revoke@example.com');

  const out = await fetch(`${base}/api/auth/signout-everywhere`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);

  // The SAME cookie must now be worthless.
  const after = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal((await after.json()).user, null, 'the old cookie must stop working');

  // And it must not be usable for sync either.
  const sync = await fetch(`${base}/api/sync/pull`, { headers: { cookie } });
  assert.equal(sync.status, 401);
});

test('a session minted at the current version still works after someone else revokes', async () => {
  const victim = upsertUser({ sub: 'revoke-other' });
  const bystander = upsertUser({ sub: 'revoke-bystander', email: 'by@example.com' });
  bumpTokenVersion(victim.id);

  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: sessionCookie(bystander.id) } });
  assert.equal((await res.json()).user.email, 'by@example.com');
});

test('push then pull round-trips a library for a signed-in user', async () => {
  const user = upsertUser({ sub: 'route-user-2', email: 'sync@example.com' });
  const cookie = sessionCookie(user.id);

  const push = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      entries: [{
        videoId: 'routevid001',
        title: 'Synced video',
        segments: [{ text: 'hello', offset: 0 }],
        digest: 'A digest.',
        updatedAt: '2026-07-20T00:00:00.000Z',
        savedAt: '2026-07-20T00:00:00.000Z',
      }],
    }),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).applied, 1);

  const pull = await fetch(`${base}/api/sync/pull`, { headers: { cookie } });
  const body = await pull.json();
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].title, 'Synced video');
  assert.ok(body.serverTime);
});

test('one signed-in user cannot pull another user\'s library', async () => {
  const alice = upsertUser({ sub: 'route-alice', email: 'alice@example.com' });
  const bob = upsertUser({ sub: 'route-bob', email: 'bob@example.com' });

  await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie(alice.id) },
    body: JSON.stringify({
      entries: [{ videoId: 'aliceonly01', title: 'Alice only', updatedAt: '2026-07-20T00:00:00.000Z' }],
    }),
  });

  const bobPull = await fetch(`${base}/api/sync/pull`, { headers: { cookie: sessionCookie(bob.id) } });
  const ids = (await bobPull.json()).entries.map((e) => e.videoId);
  assert.ok(!ids.includes('aliceonly01'), `Bob must not see Alice's library, got ${ids}`);
});

test('push rejects a body that is not an entries array', async () => {
  const user = upsertUser({ sub: 'route-user-3' });
  const res = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie(user.id) },
    body: JSON.stringify({ entries: 'not an array' }),
  });
  assert.equal(res.status, 400);
});

test('an API key sent by a client is never persisted server-side', async () => {
  // The promise in DEPLOY.md — the server never stores a key — has to survive
  // accounts. A client that mistakenly includes one must not create a record.
  const user = upsertUser({ sub: 'route-user-4' });
  const cookie = sessionCookie(user.id);

  await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      entries: [{
        videoId: 'keyleak0001',
        title: 'Has a key attached',
        apiKey: 'sk-ant-must-not-be-stored',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }],
    }),
  });

  const pull = await fetch(`${base}/api/sync/pull`, { headers: { cookie } });
  const stored = (await pull.json()).entries.find((e) => e.videoId === 'keyleak0001');
  assert.ok(stored, 'the entry itself should sync');
  assert.equal(stored.apiKey, undefined, 'but the key must be stripped');
});
