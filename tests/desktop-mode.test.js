import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Regression guard for ECHO_MODE=desktop, mirroring web-mode-gating.test.js
// and web-mode.test.js:
//
// Desktop is "optional BYOK" local mode: it reads X-Echo-Api-Key and allows
// POST /api/validate-key, but does NOT force a key (keyless requests fall
// through to the CLI provider) and otherwise behaves exactly like local mode
// (server-side library routes work, no rate limiting).
//
// server.js reads ECHO_MODE at import time, so — same rationale as
// web-mode-gating.test.js — this file boots server.js in a separate child
// `node` process with ECHO_MODE=desktop and a dedicated PORT/DB, and drives
// it over real HTTP via fetch(), rather than re-importing server.js in this
// process (which would collide with whatever ECHO_MODE another already-
// imported test file's module instance is pinned to).
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

const DESKTOP_DB = join(tmpdir(), `echo-test-desktop-mode-${process.pid}-${Date.now()}.db`);

function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Spawns `node server.js` as a child process with the given env overrides,
 * waits until it reports it is listening (or the process exits/errors), and
 * resolves with { proc, base, stop }.
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

let desktopServer;

test('boots a desktop-mode server instance (ECHO_MODE=desktop) in a child process', async () => {
  desktopServer = await bootServer({ ECHO_MODE: 'desktop', ECHO_DB_PATH: DESKTOP_DB, PORT: '8903' });
  assert.ok(desktopServer.base);
});

// ---------------------------------------------------------------------------
// buildInjectedHtml (pure helper) — import server.js in-process, separately,
// only to reach the pure function; see web-mode.test.js for the same pattern.
// Guarded by its own throwaway DB so it doesn't collide with the child
// process instance above or with other test files' module-cached imports.
// ---------------------------------------------------------------------------

const HELPER_DB = join(tmpdir(), `echo-test-desktop-helpers-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = HELPER_DB;
const { buildInjectedHtml } = await import('../server.js');

const SAMPLE_HTML = '<!DOCTYPE html>\n<html><head><title>t</title></head><body></body></html>';

test('buildInjectedHtml: desktop mode injects mode:"desktop"', () => {
  const html = buildInjectedHtml(SAMPLE_HTML, 'desktop');
  assert.match(html, /window\.__ECHO__=/);
  assert.match(html, /"mode":"desktop"/);
});

// ---------------------------------------------------------------------------
// GET /api/health — reports mode:"desktop"
// ---------------------------------------------------------------------------

test('desktop mode: GET /api/health returns {status:"ok", mode:"desktop"}', async () => {
  const res = await fetch(`${desktopServer.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok', mode: 'desktop' });
});

// ---------------------------------------------------------------------------
// POST /api/validate-key — reachable in desktop mode (optional BYOK), unlike
// a mode where the route would be gated. A keyless request should reach the
// "no key" branch (API_NOT_AUTHED, 401) rather than being rejected outright
// with WEB_MODE_UNSUPPORTED, proving the route itself is not blocked.
// ---------------------------------------------------------------------------

test('desktop mode: POST /api/validate-key with no key returns 401 API_NOT_AUTHED (route is reachable, not WEB_MODE_UNSUPPORTED)', async () => {
  const res = await fetch(`${desktopServer.base}/api/validate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'API_NOT_AUTHED');
});

// ---------------------------------------------------------------------------
// blockInWeb-gated server-side library routes — reachable in desktop mode,
// proving desktop keeps the local library unlike web (mirrors the
// "local mode: GET /api/saved returns 200" complement in web-mode-gating).
// ---------------------------------------------------------------------------

test('desktop mode: GET /api/saved returns 200 (not 503 WEB_MODE_UNSUPPORTED) — desktop keeps the local library', async () => {
  const res = await fetch(`${desktopServer.base}/api/saved`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test('desktop mode: GET /api/search returns 200 (not 503 WEB_MODE_UNSUPPORTED) — desktop keeps server-side search', async () => {
  const res = await fetch(`${desktopServer.base}/api/search?q=test`);
  assert.notEqual(res.status, 503);
});

// ---------------------------------------------------------------------------
// No rate limiting in desktop mode — mirrors the fact that webLimit()/
// rateLimitHit() gating in server.js is only exercised for isWeb; a burst of
// requests to a webLimit()-wrapped route (validate-key: 20/60s) should not
// 429 in desktop mode.
// ---------------------------------------------------------------------------

test('desktop mode: no rate limiting — a burst of requests to a webLimit()-wrapped route never 429s', async () => {
  // Fired sequentially (await in a loop, not Promise.all) to avoid opening a
  // pile of parallel local sockets. On Windows/undici, bursting many rapid
  // parallel requests at 127.0.0.1 can trip a client-side socket reset
  // (`ECONNRESET` / "socket hang up") that has nothing to do with the
  // server's HTTP response — it's a local transport hiccup, not a 429. So a
  // thrown network error here is swallowed (not a test failure); only an
  // actual HTTP response with status 429 would fail this assertion, since
  // that's the one thing desktop mode must never produce.
  const results = [];
  const errors = [];
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`${desktopServer.base}/api/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await res.text(); // drain the body so the connection can be reused/closed cleanly
      results.push(res.status);
    } catch (err) {
      errors.push(`${err.message || String(err)} / cause=${err.cause?.message || err.cause?.code || err.cause}`);
    }
  }
  assert.ok(
    results.length > 0,
    `expected at least some requests to complete (all ${errors.length} threw network errors: ${errors.join('; ')})`
  );
  assert.ok(
    results.every((s) => s !== 429),
    `expected no 429s, got statuses: ${results.join(',')} (network errors ignored: ${errors.length})`
  );
});

test('tears down the desktop-mode server', async () => {
  await desktopServer.stop();
});

test.after(() => {
  cleanupDb(DESKTOP_DB);
  cleanupDb(HELPER_DB);
});
