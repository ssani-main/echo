import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// server.js opens the SQLite store at import time — point it at a throwaway
// DB file so this test file doesn't collide with other test files' DBs.
const DB = join(tmpdir(), `echo-test-web-mode-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const { rateLimitHit, buildInjectedHtml, ECHO_MODE, isWeb, ECHO_ERROR_STATUS } = await import('../server.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// Default (local) mode — imported without ECHO_MODE=web, confirms NO-OP
// ---------------------------------------------------------------------------

test('ECHO_MODE defaults to "local" and isWeb is false when ECHO_MODE env var is unset', () => {
  assert.equal(ECHO_MODE, 'local');
  assert.equal(isWeb, false);
});

// ---------------------------------------------------------------------------
// rateLimitHit — pure sliding-window helper
// ---------------------------------------------------------------------------

test('rateLimitHit: allows up to maxPerWindow hits, then flags the Nth+1 hit as limited', () => {
  const store = new Map();
  const key = 'ip-1';
  const max = 3;
  const windowMs = 60_000;
  const now = 1_000_000;

  // First `max` hits (at the same instant) should NOT be limited.
  for (let i = 0; i < max; i++) {
    const limited = rateLimitHit(key, max, windowMs, store, now);
    assert.equal(limited, false, `hit ${i + 1} should not be limited`);
  }

  // The (max + 1)th hit within the same window IS limited.
  const limited = rateLimitHit(key, max, windowMs, store, now);
  assert.equal(limited, true);
});

test('rateLimitHit: prunes timestamps outside the window, allowing new hits after it elapses', () => {
  const store = new Map();
  const key = 'ip-2';
  const max = 2;
  const windowMs = 1000;

  assert.equal(rateLimitHit(key, max, windowMs, store, 0), false);
  assert.equal(rateLimitHit(key, max, windowMs, store, 100), false);
  // Third hit still inside the window -> limited
  assert.equal(rateLimitHit(key, max, windowMs, store, 200), true);

  // Well past the window -> old timestamps pruned, allowed again
  assert.equal(rateLimitHit(key, max, windowMs, store, 5000), false);
});

test('rateLimitHit: tracks separate keys independently', () => {
  const store = new Map();
  const windowMs = 60_000;
  const now = 0;

  assert.equal(rateLimitHit('a', 1, windowMs, store, now), false);
  assert.equal(rateLimitHit('a', 1, windowMs, store, now), true);
  // A different key is unaffected by "a"'s limit.
  assert.equal(rateLimitHit('b', 1, windowMs, store, now), false);
});

// ---------------------------------------------------------------------------
// buildInjectedHtml — pure HTML-injection builder (Step 1)
// ---------------------------------------------------------------------------

const SAMPLE_HTML = '<!DOCTYPE html>\n<html><head><title>t</title></head><body></body></html>';

test('buildInjectedHtml: web mode injects mode:"web"', () => {
  const html = buildInjectedHtml(SAMPLE_HTML, 'web');
  assert.match(html, /window\.__ECHO__=/);
  assert.match(html, /"mode":"web"/);
});

test('buildInjectedHtml: local mode injects mode:"local"', () => {
  const html = buildInjectedHtml(SAMPLE_HTML, 'local');
  assert.match(html, /"mode":"local"/);
});

test('buildInjectedHtml: injected script is placed immediately before </head> and other markup is untouched', () => {
  const html = buildInjectedHtml(SAMPLE_HTML, 'local');
  assert.ok(html.includes('<title>t</title>'));
  assert.ok(html.includes('<body></body></html>'));
  const scriptIdx = html.indexOf('window.__ECHO__');
  const headCloseIdx = html.indexOf('</head>');
  assert.ok(scriptIdx > 0 && headCloseIdx > 0);
  assert.ok(scriptIdx < headCloseIdx, 'injected script must appear before </head>');
});

// ---------------------------------------------------------------------------
// ECHO_ERROR_STATUS — BYOK/Anthropic API error code mapping
// ---------------------------------------------------------------------------

test('ECHO_ERROR_STATUS maps API error codes from providers.js to correct HTTP status codes', () => {
  assert.equal(ECHO_ERROR_STATUS.API_NOT_AUTHED, 401);
  assert.equal(ECHO_ERROR_STATUS.API_RATE_LIMITED, 429);
  assert.equal(ECHO_ERROR_STATUS.API_FAILED, 502);
});

test('ECHO_ERROR_STATUS maps MEMBERS_ONLY to 422 (pinned: a missing entry would silently degrade to 500)', () => {
  assert.equal(ECHO_ERROR_STATUS.MEMBERS_ONLY, 422);
});
