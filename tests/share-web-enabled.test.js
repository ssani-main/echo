import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Web-mode sharing is off by default and opt-in via ECHO_SHARES (Model A:
// volume-backed, flag-gated shares — see server.js `sharesEnabled` +
// `requireSharesEnabled`). This file covers the ECHO_SHARES=1 path end to
// end (create -> serve -> delete -> gone) plus the ECHO_SHARE_MAX_CHARS cap,
// in web mode specifically.
//
// The "web mode WITHOUT ECHO_SHARES -> 503 WEB_MODE_UNSUPPORTED" scenario is
// already covered by tests/web-mode-gating.test.js: its GATED_ROUTES list
// includes both ['POST', '/api/share'] and ['DELETE', '/api/share/some-share-id'],
// exercised against a server booted with ECHO_MODE=web and no ECHO_SHARES set
// (see web-mode-gating.test.js lines ~112-138). Not duplicated here.
//
// server.js reads ECHO_MODE / ECHO_SHARES / ECHO_SHARE_MAX_CHARS at import
// time, so — same rationale as web-mode-gating.test.js and
// desktop-mode.test.js — each distinct env combination needs its own child
// `node` process (an in-process re-import would reuse the first import's
// module state). Driven over real HTTP via fetch().
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');

const MAIN_DB = join(tmpdir(), `echo-test-share-web-enabled-main-${process.pid}-${Date.now()}.db`);
const CAP_DB = join(tmpdir(), `echo-test-share-web-enabled-cap-${process.pid}-${Date.now()}.db`);

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

let mainServer;
let capServer;

// ---------------------------------------------------------------------------
// ECHO_MODE=web, ECHO_SHARES=1 — full create -> serve -> delete -> gone flow.
// ---------------------------------------------------------------------------

test('boots a web-mode server with ECHO_SHARES=1 in a child process', async () => {
  mainServer = await bootServer({
    ECHO_MODE: 'web',
    ECHO_SHARES: '1',
    ECHO_DB_PATH: MAIN_DB,
    PORT: '8905',
  });
  assert.ok(mainServer.base);
});

test('web mode + ECHO_SHARES=1: POST /api/share returns 200 {id, path}; GET /s/:id serves it (200, contains title); DELETE removes it; GET /s/:id afterward is 404', async () => {
  const postRes = await fetch(`${mainServer.base}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId: 'web-share-vid',
      title: 'Signal Test Digest',
      sourceUrl: 'https://www.youtube.com/watch?v=web-share-vid',
      digestMd: 'This is a web-mode shareable digest body.',
    }),
  });
  assert.equal(postRes.status, 200, `expected 200, got ${postRes.status}`);
  const created = await postRes.json();
  assert.equal(typeof created.id, 'string');
  assert.ok(created.id.length > 0);
  assert.equal(created.path, `/s/${created.id}`);

  const getRes = await fetch(`${mainServer.base}${created.path}`);
  assert.equal(getRes.status, 200);
  const html = await getRes.text();
  assert.match(html, /^<!doctype html/i);
  assert.ok(html.includes('Signal Test Digest'), 'shared page should contain the digest title');

  const delRes = await fetch(`${mainServer.base}/api/share/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.deepEqual(delBody, { ok: true });

  const getAfterDelete = await fetch(`${mainServer.base}${created.path}`);
  assert.equal(getAfterDelete.status, 404);
});

test('tears down the web-mode + ECHO_SHARES=1 server', async () => {
  await mainServer.stop();
});

// ---------------------------------------------------------------------------
// ECHO_MODE=web, ECHO_SHARES=1, ECHO_SHARE_MAX_CHARS=10 — size cap.
// ---------------------------------------------------------------------------

test('boots a web-mode server with ECHO_SHARES=1 and ECHO_SHARE_MAX_CHARS=10 in a child process', async () => {
  capServer = await bootServer({
    ECHO_MODE: 'web',
    ECHO_SHARES: '1',
    ECHO_SHARE_MAX_CHARS: '10',
    ECHO_DB_PATH: CAP_DB,
    PORT: '8906',
  });
  assert.ok(capServer.base);
});

test('web mode + ECHO_SHARE_MAX_CHARS=10: POST /api/share with an oversize digestMd returns 413', async () => {
  const res = await fetch(`${capServer.base}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Too Big',
      digestMd: 'This digest is definitely longer than ten characters.',
    }),
  });
  assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  const body = await res.json();
  assert.ok(body.error);
  assert.equal(typeof body.error.code, 'string');
});

test('tears down the ECHO_SHARE_MAX_CHARS=10 server', async () => {
  await capServer.stop();
});

test.after(() => {
  cleanupDb(MAIN_DB);
  cleanupDb(CAP_DB);
});
