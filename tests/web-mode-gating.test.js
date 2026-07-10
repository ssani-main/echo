import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end regression guard for the blockInWeb() gate in server.js:
// every server-side SQLite-library/search route must return 503
// WEB_MODE_UNSUPPORTED when ECHO_MODE=web, and must work normally (unchanged)
// in local mode.
//
// server.js reads ECHO_MODE at import time (`const ECHO_MODE = ...`), so it
// cannot be re-imported with a different value inside this process once
// another test file has already imported it with a different ECHO_MODE
// (ESM module instances are cached per resolved specifier+process). To get a
// real, independent web-mode server instance without disturbing any other
// test file's local-mode instance, this file boots server.js in a separate
// child `node` process with ECHO_MODE=web and a dedicated PORT, and drives it
// over real HTTP via fetch(). This is the most robust option on Windows,
// where signal-based teardown and in-process module un-caching are unreliable.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

const WEB_DB = join(tmpdir(), `echo-test-web-gating-web-${process.pid}-${Date.now()}.db`);
const LOCAL_DB = join(tmpdir(), `echo-test-web-gating-local-${process.pid}-${Date.now()}.db`);

function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Spawns `node server.js` as a child process with the given env overrides,
 * waits until it reports it is listening (or the process exits/errors), and
 * resolves with { proc, base, stop } where `base` is the server's HTTP
 * origin and `stop()` tears the child process down.
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

async function assertWebModeUnsupported(base, method, path) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
  });
  assert.equal(res.status, 503, `${method} ${path} expected 503, got ${res.status}`);
  const body = await res.json();
  assert.ok(body.error, `${method} ${path} expected a structured error envelope`);
  assert.equal(body.error.code, 'WEB_MODE_UNSUPPORTED', `${method} ${path} expected code WEB_MODE_UNSUPPORTED, got ${body.error.code}`);
}

// The full set of server-side library/search routes gated by blockInWeb().
const GATED_ROUTES = [
  ['GET', '/api/saved'],
  ['GET', '/api/saved/export'],
  ['GET', '/api/saved/some-video-id'],
  ['GET', '/api/saved/some-video-id/export.md'],
  ['POST', '/api/saved'],
  ['DELETE', '/api/saved/some-video-id'],
  ['PATCH', '/api/saved/some-video-id/tags'],
  ['GET', '/api/search'],
  ['POST', '/api/playlist'],
  ['POST', '/api/share'],
  ['DELETE', '/api/share/some-share-id'],
];

let webServer;
let localServer;

test('boots a web-mode server instance (ECHO_MODE=web) in a child process', async () => {
  webServer = await bootServer({ ECHO_MODE: 'web', ECHO_DB_PATH: WEB_DB, PORT: '8901' });
  assert.ok(webServer.base);
});

for (const [method, path] of GATED_ROUTES) {
  test(`web mode: ${method} ${path} returns 503 WEB_MODE_UNSUPPORTED`, async () => {
    await assertWebModeUnsupported(webServer.base, method, path);
  });
}

// ---------------------------------------------------------------------------
// POST /api/playlist is gated via an inline `if (isWeb)` check (not the
// shared blockInWeb() middleware, since it also needs webLimit()), so it is
// worth a dedicated assertion with a realistic playlist URL body, in addition
// to its entry in GATED_ROUTES above (which only sends `{}`) — proving the
// isWeb short-circuit fires before any yt-dlp playlist enumeration is
// attempted, regardless of what the caller sends.
// ---------------------------------------------------------------------------

test('web mode: POST /api/playlist with a real playlist URL body returns 503 WEB_MODE_UNSUPPORTED (never spawns yt-dlp)', async () => {
  const res = await fetch(`${webServer.base}/api/playlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/playlist?list=PLxyz' }),
  });
  assert.equal(res.status, 503, `expected 503, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error.code, 'WEB_MODE_UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// POST /api/enrich mode:'factcheck' ("Verify") is disabled in web mode (the
// enrich Verify button and the "Verify claims" button are also hidden
// client-side — see public/index.html's ECHO.mode==='web' init block), while
// every other enrich mode stays available (gated the normal way, behind
// requireWebKey since no API key is sent here).
// ---------------------------------------------------------------------------

test('web mode: POST /api/enrich mode:"factcheck" returns 400 FACTCHECK_DISABLED_IN_WEB', async () => {
  const res = await fetch(`${webServer.base}/api/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection: 'The sky is blue.', mode: 'factcheck' }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error.code, 'FACTCHECK_DISABLED_IN_WEB');
});

test('web mode: POST /api/enrich mode:"explain" is not blocked by the factcheck gate (falls through to the normal API-key requirement)', async () => {
  const res = await fetch(`${webServer.base}/api/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection: 'The sky is blue.', mode: 'explain' }),
  });
  // No API key was sent, so this hits requireWebKey rather than succeeding —
  // the point of this test is that it is NOT rejected as FACTCHECK_DISABLED_IN_WEB.
  const body = await res.json();
  assert.notEqual(body.error && body.error.code, 'FACTCHECK_DISABLED_IN_WEB');
  assert.equal(body.error.code, 'API_NOT_AUTHED');
});

test('tears down the web-mode server', async () => {
  await webServer.stop();
});

test('boots a local-mode server instance (ECHO_MODE unset) in a child process', async () => {
  const env = { ECHO_DB_PATH: LOCAL_DB, PORT: '8902' };
  // Explicitly ensure ECHO_MODE is NOT set for this child, proving local
  // behavior is the unaffected default rather than something this test
  // forces via an explicit 'local' value.
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: (() => {
      const merged = { ...process.env, ...env };
      delete merged.ECHO_MODE;
      return merged;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    base: 'http://127.0.0.1:8902',
    stop: () => new Promise((res) => {
      proc.once('exit', () => res());
      proc.kill();
    }),
  };
});

// ---------------------------------------------------------------------------
// Complement: local mode (ECHO_MODE unset) is NOT gated — GET /api/saved
// returns 200, proving blockInWeb() is a web-mode-only gate and local
// behavior is unchanged.
// ---------------------------------------------------------------------------

test('local mode: GET /api/saved returns 200 (not 503) — gate is web-mode-only', async () => {
  const res = await fetch(`${localServer.base}/api/saved`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test('tears down the local-mode server', async () => {
  await localServer.stop();
});

test.after(() => {
  cleanupDb(WEB_DB);
  cleanupDb(LOCAL_DB);
});
