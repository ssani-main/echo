import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
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
// Keep the local-mode instance's real route hits out of the real local usage
// meter (data/usage-events.jsonl) — see usagelog.js. Set before bootServer()
// so it's inherited by both spawned child processes' env. Belt and braces:
// the synthetic flag alone still filters at read time, but pointing the log
// at a throwaway path means neither child process ever appends to the real
// file at all.
process.env.ECHO_USAGE_SYNTHETIC = '1';
const USAGE_LOG = join(tmpdir(), `echo-test-web-gating-usage-${process.pid}-${Date.now()}.jsonl`);
process.env.ECHO_USAGE_LOG_PATH = USAGE_LOG;

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

// The full set of routes gated by blockInWeb(): the server-side library/search
// routes (persistence lives in the browser in web mode) and the Whisper routes,
// including its progress stream — Whisper never runs in web mode, so a hosted
// visitor could only ever hold that stream open for a job that cannot exist.
const GATED_ROUTES = [
  ['GET', '/api/saved'],
  ['GET', '/api/saved/export'],
  ['GET', '/api/saved/some-video-id'],
  ['GET', '/api/saved/some-video-id/export.md'],
  ['POST', '/api/saved'],
  ['DELETE', '/api/saved/some-video-id'],
  ['PATCH', '/api/saved/some-video-id/tags'],
  ['GET', '/api/search'],
  ['POST', '/api/vault/sync'],
  ['GET', '/api/whisper/status'],
  ['POST', '/api/whisper/model'],
  ['GET', '/api/transcript/progress?jobId=probe'],
];

let webServer;
let localServer;

// A fake `claude` first on the web server's PATH: it only leaves a marker, so a
// request that wrongly reaches the CLI is visible and never runs the real one.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'echo-fake-claude-'));
const CLI_HIT = join(FAKE_BIN, 'hit');
if (process.platform === 'win32') {
  writeFileSync(join(FAKE_BIN, 'claude.cmd'), '@echo off\r\necho hit> "%~dp0hit"\r\n');
} else {
  writeFileSync(join(FAKE_BIN, 'claude'), '#!/bin/sh\necho hit > "$(dirname "$0")/hit"\n', { mode: 0o755 });
}
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

test('boots a web-mode server instance (ECHO_MODE=web) in a child process', async () => {
  webServer = await bootServer({
    ECHO_MODE: 'web', ECHO_DB_PATH: WEB_DB, PORT: '8901',
    [PATH_KEY]: FAKE_BIN + delimiter + (process.env[PATH_KEY] || ''),
  });
  assert.ok(webServer.base);
});

for (const [method, path] of GATED_ROUTES) {
  test(`web mode: ${method} ${path} returns 503 WEB_MODE_UNSUPPORTED`, async () => {
    await assertWebModeUnsupported(webServer.base, method, path);
  });
}

// The registry hides the CLI from the web picker; this is the server enforcing
// it, so a hand-written header plus any dummy key cannot spend the operator's
// `claude` quota.
for (const path of ['/api/digest', '/api/validate-key']) {
  test(`web mode: POST ${path} naming the CLI provider is refused with 400 PROVIDER_UNKNOWN`, async () => {
    const res = await fetch(`${webServer.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echo-Provider': 'cli', 'X-Echo-Api-Key': 'dummy-key' },
      body: JSON.stringify({ text: 'a transcript', length: 'short' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'PROVIDER_UNKNOWN');
    assert.equal(existsSync(CLI_HIT), false, 'the CLI must never be spawned');
  });
}


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
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
  try { rmSync(FAKE_BIN, { recursive: true, force: true }); } catch { /* ignore */ }
});
