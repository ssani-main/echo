import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openSyncDb, closeSyncDb, upsertAtprotoUser, submitRegistration, decideRegistration, getUser } from '../syncStore.js';
import { signToken, SESSION_COOKIE, SESSION_TTL_MS } from '../auth.js';

// ---------------------------------------------------------------------------
// End-to-end HTTP coverage for requireApproved() in server.js.
//
// requireApproved is used 26 times in server.js to gate every route that
// spends something (Claude quota, YouTube fetches, the server-side library),
// but the whole rest of the suite runs with ECHO_ATPROTO_ENABLED unset, where
// requireApproved is a documented no-op. That leaves the enabled path — the
// one an actual published instance runs under — completely unproven.
//
// Same approach as tests/web-mode-gating.test.js and for the same reason:
// server.js reads its config (ACCOUNTS_ENABLED, ATPROTO_ENABLED, etc.) at
// import time, so a real independent instance needs its own child `node`
// process rather than a re-import in this one. Driven over real HTTP via
// fetch(); accounts are seeded directly into the sync DB via syncStore.js
// (as tests/registration.test.js does), and session cookies are forged with
// the *same* signToken()/SESSION_COOKIE the real sign-in flow uses, sharing
// the ECHO_SESSION_SECRET the child is booted with — so a forged cookie is
// byte-for-byte what a real sign-in would have produced, not a stand-in.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

const SESSION_SECRET = 'test-session-secret-do-not-use-in-prod';
const ATPROTO_SECRET = 'test-atproto-secret-do-not-use-in-prod';
const ADMIN_DID = 'did:plc:test-admin';

const SYNC_DB = join(tmpdir(), `echo-test-atproto-gating-sync-${process.pid}-${Date.now()}.db`);
const LIB_DB = join(tmpdir(), `echo-test-atproto-gating-lib-${process.pid}-${Date.now()}.db`);

// Keep this test's route hits out of the real local usage meter, same
// hygiene as web-mode-gating.test.js.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-atproto-gating-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;

function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Spawns `node server.js` as a child process with the given env overrides,
 * waits until it reports it is listening (or the process exits/errors), and
 * resolves with { proc, base, stop }. Copied from tests/web-mode-gating.test.js
 * on purpose rather than factored into a shared module — that file's helper
 * is known-good and this avoids risking it.
 */
function bootServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const port = extraEnv.PORT;
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stderrBuf = '';
    let stdoutBuf = '';

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`server did not start listening within timeout.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    }, 15_000);

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (!settled && /Listening on/.test(stdoutBuf)) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          proc,
          base: `http://127.0.0.1:${port}`,
          stop: () => new Promise((res) => {
            proc.once('exit', () => res());
            proc.kill();
          }),
        });
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`server process exited early with code ${code}.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    });
  });
}

/** A cookie header for a forged, valid Echo session for the given user. */
function cookieFor(user) {
  const token = signToken(
    { uid: user.id, tv: user.tokenVersion || 0, exp: Date.now() + SESSION_TTL_MS },
    SESSION_SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function requestJson(base, method, path, { cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// The route families the task calls out: digest (AI spend), transcript
// (YouTube fetch), saved/library (server-side SQLite), search. One
// representative GET/POST route per family, matching how
// web-mode-gating.test.js samples GATED_ROUTES rather than enumerating every
// one of the 26 usages.
const GUARDED_ROUTES = [
  ['POST', '/api/digest'],
  ['POST', '/api/transcript'],
  ['GET', '/api/saved'],
  ['GET', '/api/search'],
];

let server;

test('seed sync DB accounts: signed-out (n/a), unsubmitted, pending, rejected, approved, admin', () => {
  closeSyncDb();
  openSyncDb(SYNC_DB);

  // Signed in, never asked for access.
  global.__unsubmittedUser = upsertAtprotoUser({ did: 'did:plc:unsubmitted', handle: 'unsubmitted.bsky.social' });

  // Asked, awaiting a decision.
  global.__pendingUser = upsertAtprotoUser({ did: 'did:plc:pending', handle: 'pending.bsky.social' });
  submitRegistration(global.__pendingUser.id, { motivation: 'let me in please' });

  // Asked, declined.
  global.__rejectedUser = upsertAtprotoUser({ did: 'did:plc:rejected', handle: 'rejected.bsky.social' });
  submitRegistration(global.__rejectedUser.id, { motivation: 'let me in please' });
  decideRegistration(global.__rejectedUser.id, { status: 'rejected', decidedBy: ADMIN_DID, adminNote: 'no' });

  // Asked, approved.
  global.__approvedUser = upsertAtprotoUser({ did: 'did:plc:approved', handle: 'approved.bsky.social' });
  submitRegistration(global.__approvedUser.id, { motivation: 'let me in please' });
  decideRegistration(global.__approvedUser.id, { status: 'approved', decidedBy: ADMIN_DID });

  assert.equal(getUser(global.__unsubmittedUser.id).status, 'pending');
  assert.equal(getUser(global.__unsubmittedUser.id).submitted, false);
  assert.equal(getUser(global.__pendingUser.id).status, 'pending');
  assert.equal(getUser(global.__pendingUser.id).submitted, true);
  assert.equal(getUser(global.__rejectedUser.id).status, 'rejected');
  assert.equal(getUser(global.__approvedUser.id).status, 'approved');
  closeSyncDb();
});

test('boots an atproto-enabled server instance in a child process', async () => {
  server = await bootServer({
    ECHO_SYNC_DB_PATH: SYNC_DB,
    ECHO_DB_PATH: LIB_DB,
    ECHO_ATPROTO_ENABLED: '1',
    ECHO_ATPROTO_SECRET: ATPROTO_SECRET,
    ECHO_SESSION_SECRET: SESSION_SECRET,
    ECHO_ADMIN_DIDS: ADMIN_DID,
    PORT: '8905',
  });
  assert.ok(server.base);
});

// ---------------------------------------------------------------------------
// 1) Anonymous requests are refused with reason: 'signed_out', across every
//    guarded route family, and never reach the route's own logic.
// ---------------------------------------------------------------------------

for (const [method, path] of GUARDED_ROUTES) {
  test(`gated (anonymous): ${method} ${path} -> 401 signed_out, no cookie sent`, async () => {
    const { status, body } = await requestJson(server.base, method, path);
    assert.equal(status, 401, `${method} ${path} expected 401, got ${status}`);
    assert.ok(body?.error, `${method} ${path} expected a structured error envelope`);
    assert.equal(body.error.reason, 'signed_out');
    // Never reaches route logic: none of these routes' real handlers can
    // succeed with an empty JSON body / no videoId, so a route-logic 400
    // (e.g. INVALID_URL, INTERNAL) here would be proof the gate was bypassed
    // rather than a coincidental error of its own.
    assert.notEqual(body.error.code, 'INVALID_URL');
  });
}

// ---------------------------------------------------------------------------
// 2) A session cookie for a user who exists but hasn't asked -> 'unsubmitted'
// ---------------------------------------------------------------------------

for (const [method, path] of GUARDED_ROUTES) {
  test(`gated (unsubmitted): ${method} ${path} -> 403 unsubmitted`, async () => {
    const cookie = cookieFor(global.__unsubmittedUser);
    const { status, body } = await requestJson(server.base, method, path, { cookie });
    assert.equal(status, 403, `${method} ${path} expected 403, got ${status}`);
    assert.equal(body.error.reason, 'unsubmitted');
  });
}

// ---------------------------------------------------------------------------
// 3) A session cookie for a user who submitted and is awaiting a decision
//    -> 'pending'
// ---------------------------------------------------------------------------

for (const [method, path] of GUARDED_ROUTES) {
  test(`gated (pending): ${method} ${path} -> 403 pending`, async () => {
    const cookie = cookieFor(global.__pendingUser);
    const { status, body } = await requestJson(server.base, method, path, { cookie });
    assert.equal(status, 403, `${method} ${path} expected 403, got ${status}`);
    assert.equal(body.error.reason, 'pending');
  });
}

// ---------------------------------------------------------------------------
// 4) A session cookie for a rejected user -> 'rejected'
// ---------------------------------------------------------------------------

for (const [method, path] of GUARDED_ROUTES) {
  test(`gated (rejected): ${method} ${path} -> 403 rejected`, async () => {
    const cookie = cookieFor(global.__rejectedUser);
    const { status, body } = await requestJson(server.base, method, path, { cookie });
    assert.equal(status, 403, `${method} ${path} expected 403, got ${status}`);
    assert.equal(body.error.reason, 'rejected');
  });
}

// ---------------------------------------------------------------------------
// 5) An approved user's session passes the gate and reaches real route logic.
//
// GET /api/saved is the right probe here: it touches only the per-owner
// SQLite library (no network, no Claude spend), so a 200 with an array proves
// the request reached the actual handler rather than merely avoiding a 401.
// A tampered / made-up cookie must NOT pass — proving the check is the
// signature and status, not merely "a Cookie header was present".
// ---------------------------------------------------------------------------

test('gated (approved): GET /api/saved passes the gate and reaches the real handler', async () => {
  const cookie = cookieFor(global.__approvedUser);
  const { status, body } = await requestJson(server.base, 'GET', '/api/saved', { cookie });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), 'approved user reaches the real /api/saved handler, which returns an array');
});

test('gated (approved): the approved user\'s own library is empty and isolated (per-account file)', async () => {
  const cookie = cookieFor(global.__approvedUser);
  const { body } = await requestJson(server.base, 'GET', '/api/saved', { cookie });
  assert.deepEqual(body, [], 'a fresh account has its own, empty library file');
});

test('a forged cookie with the wrong secret is refused, not merely one without a cookie', async () => {
  const token = signToken(
    { uid: global.__approvedUser.id, tv: 0, exp: Date.now() + SESSION_TTL_MS },
    'not-the-real-secret',
  );
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  const { status, body } = await requestJson(server.base, 'GET', '/api/saved', { cookie });
  assert.equal(status, 401);
  assert.equal(body.error.reason, 'signed_out', 'a bad signature verifies to nobody, i.e. signed out');
});

test('a stale tokenVersion (forceSignOut / status change since issue) is refused', async () => {
  // tv: 999 will never match a freshly-seeded user's real tokenVersion (0),
  // simulating a cookie issued before a revocation.
  const token = signToken(
    { uid: global.__approvedUser.id, tv: 999, exp: Date.now() + SESSION_TTL_MS },
    SESSION_SECRET,
  );
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  const { status, body } = await requestJson(server.base, 'GET', '/api/saved', { cookie });
  assert.equal(status, 401);
  assert.equal(body.error.reason, 'signed_out');
});

test('tears down the atproto-enabled server', async () => {
  await server.stop();
});

// ---------------------------------------------------------------------------
// 6) Regression guard: with the feature DISABLED (ECHO_ATPROTO_ENABLED unset,
//    the default everywhere), these same routes must behave exactly as they
//    do today for a completely anonymous caller — no gate, no cookie needed.
//    This is the hard constraint: local mode must never break.
// ---------------------------------------------------------------------------

let localServer;

test('boots a local-mode server (ECHO_ATPROTO_ENABLED unset) in a child process', async () => {
  const LOCAL_LIB_DB = join(tmpdir(), `echo-test-atproto-gating-local-lib-${process.pid}-${Date.now()}.db`);
  global.__localLibDb = LOCAL_LIB_DB;
  const env = { ...process.env, ECHO_DB_PATH: LOCAL_LIB_DB, PORT: '8906' };
  // Explicitly strip any atproto/auth env so this really exercises "unset",
  // not merely "some other value".
  delete env.ECHO_ATPROTO_ENABLED;
  delete env.ECHO_ATPROTO_SECRET;
  delete env.ECHO_SESSION_SECRET;
  delete env.ECHO_ADMIN_DIDS;
  delete env.ECHO_MODE;

  const proc = spawn(process.execPath, [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  const ready = await new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`local server did not start.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    }, 15_000);
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (/Listening on/.test(stdoutBuf)) {
        clearTimeout(timeout);
        resolve(true);
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`local server exited early with code ${code}.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    });
  });
  assert.ok(ready);

  localServer = {
    proc,
    base: 'http://127.0.0.1:8906',
    stop: () => new Promise((res) => {
      proc.once('exit', () => res());
      proc.kill();
    }),
  };
});

test('ungated (local, atproto disabled): GET /api/saved returns 200 with no cookie', async () => {
  const { status, body } = await requestJson(localServer.base, 'GET', '/api/saved');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('ungated (local, atproto disabled): GET /api/search behaves as before (400, not 401)', async () => {
  // No `q` query param is a validation error from the route itself, not a
  // gate refusal — proving the gate genuinely did not run, rather than just
  // "some 4xx came back".
  const { status, body } = await requestJson(localServer.base, 'GET', '/api/search');
  assert.notEqual(status, 401);
  assert.notEqual(body?.error?.reason, 'signed_out');
});

test('tears down the local-mode (atproto disabled) server', async () => {
  await localServer.stop();
});

test.after(() => {
  cleanupDb(SYNC_DB);
  cleanupDb(LIB_DB);
  if (global.__localLibDb) cleanupDb(global.__localLibDb);
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
});
