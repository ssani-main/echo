import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// The usage meter (usagelog.js + usage_stats.mjs) is what decides which
// features get cut. It was found reporting fiction: in-repo integration
// tests boot a real local-mode server and were writing real seeded saves
// (`page0000024`, `gzipvid001`, ...) straight into data/usage-events.jsonl
// on every `npm test` run. Three independent, purely read-time defenses are
// covered here:
//   1. usage_stats.mjs excludes records flagged `synthetic:true`.
//   2. ...records whose videoId matches neither the 11-char YouTube shape
//      nor the legitimate `file_<14-hex>` local-media shape.
//   3. ...records whose videoId matches a known pre-flag seed pattern
//      (`page<digits>`, `probe<digits>`, etc.) — a backstop for history
//      written before ECHO_USAGE_SYNTHETIC existed, since some of those
//      seeded ids (e.g. `page0000024`, 11 alnum chars) pass #2 undetected.
//   4. usagelog.js stamps `synthetic:true` when ECHO_USAGE_SYNTHETIC is set,
//      and rotates the log file once it crosses a size threshold.
// None of this touches data/usage-events.jsonl itself — filtering is
// entirely at read time in usage_stats.mjs.
// ---------------------------------------------------------------------------

test('usage_stats.mjs excludes seeded/synthetic ids and the flagged record, keeps real YouTube + file_ ids', () => {
  const fixture = join(tmpdir(), `echo-usage-fixture-${process.pid}-${Date.now()}.jsonl`);
  const lines = [
    { event: 'transcript', videoId: 'GRzaq5AHiV8', ok: true, chars: 100 },
    { event: 'digest', videoId: 'GRzaq5AHiV8', ok: true, chars: 100, strategy: 'single' },
    { event: 'save', videoId: 'GRzaq5AHiV8', hadDigest: true, ok: true },
    // Seeded scale-sweep id — wrong shape (10 chars), must be excluded even
    // with no flag.
    { event: 'save', videoId: 'gzipvid001', hadDigest: true, ok: true },
    // Legitimate local-media id (file_<14 lowercase hex>) — must be kept.
    { event: 'save', videoId: 'file_bb7c5719064b46', hadDigest: true, ok: true },
    // Right shape, but explicitly flagged synthetic — must still be excluded.
    { event: 'digest', videoId: 'GRzaq5AHiV8', ok: true, chars: 100, synthetic: true },
  ];
  writeFileSync(fixture, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  try {
    const stdout = execFileSync(process.execPath, ['usage_stats.mjs', fixture], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.match(stdout, /excluded 2 synthetic\/seeded events/);
    // 2 real saves survive (the YouTube id and the file_ id); the seeded
    // gzipvid001 save does not count.
    assert.match(stdout, /save\s+2\b/);
    // Only 1 real digest survives (the synthetic-flagged one is excluded).
    assert.match(stdout, /digest\s+1\b/);
  } finally {
    rmSync(fixture, { force: true });
  }
});

test('usage_stats.mjs excludes known pre-flag seed patterns (page/probe/apivid/expvid/searchvid/gzipvid) even though some pass the shape check', () => {
  const fixture = join(tmpdir(), `echo-usage-pattern-fixture-${process.pid}-${Date.now()}.jsonl`);
  const lines = [
    { event: 'transcript', videoId: 'GRzaq5AHiV8', ok: true, chars: 100 },
    { event: 'save', videoId: 'GRzaq5AHiV8', hadDigest: true, ok: true },
    // 11 alphanumeric chars — passes the YouTube-shape check, but is a known
    // scale-sweep seed id and must still be excluded by pattern.
    { event: 'save', videoId: 'page0000024', hadDigest: false, ok: true },
    // 11 chars — same story, from an external scale-sweep script.
    { event: 'save', videoId: 'probe000001', hadDigest: false, ok: true },
    // In-repo test fixture ids (already excluded by shape, but also covered
    // by the named pattern list per the requirements).
    { event: 'save', videoId: 'apivid001', hadDigest: false, ok: true },
    { event: 'save', videoId: 'expvid002', hadDigest: false, ok: true },
    { event: 'save', videoId: 'searchvid001', hadDigest: false, ok: true },
    { event: 'save', videoId: 'gzipvid001', hadDigest: false, ok: true },
  ];
  writeFileSync(fixture, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  try {
    const stdout = execFileSync(process.execPath, ['usage_stats.mjs', fixture], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.match(stdout, /excluded 6 synthetic\/seeded events/);
    // Only the one real YouTube-id save survives.
    assert.match(stdout, /save\s+1\b/);
  } finally {
    rmSync(fixture, { force: true });
  }
});

test('usage_stats.mjs id shape + seed-pattern helpers behave as documented', () => {
  const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const FILE_ID_RE = /^file_[0-9a-f]{14}$/i;
  const isRealVideoId = (id) => YOUTUBE_ID_RE.test(id) || FILE_ID_RE.test(id);

  const KNOWN_SEED_ID_PATTERNS = [
    /^page\d+$/,
    /^probe\d+$/,
    /^apivid\d+$/,
    /^expvid\d+$/,
    /^searchvid\d+$/,
    /^gzipvid\d+$/,
  ];
  const isKnownSeedId = (id) => KNOWN_SEED_ID_PATTERNS.some((re) => re.test(id));

  assert.equal(isRealVideoId('GRzaq5AHiV8'), true);
  assert.equal(isRealVideoId('gzipvid001'), false); // 10 chars
  assert.equal(isRealVideoId('file_bb7c5719064b46'), true);
  assert.equal(isRealVideoId('file_bb7c5719064b4'), false); // 13 hex chars, wrong length

  // Known, documented limitation of shape ALONE: a genuine 11-char YouTube
  // id is indistinguishable from a seeded id that HAPPENS to also be 11
  // alnum chars — isRealVideoId() alone says both are real.
  assert.equal(isRealVideoId('page0000024'), true);
  assert.equal(isRealVideoId('probe000001'), true);

  // The named seed-pattern list is what actually excludes them.
  assert.equal(isKnownSeedId('page0000024'), true);
  assert.equal(isKnownSeedId('probe000001'), true);
  assert.equal(isKnownSeedId('apivid001'), true);
  assert.equal(isKnownSeedId('expvid002'), true);
  assert.equal(isKnownSeedId('searchvid001'), true);
  assert.equal(isKnownSeedId('gzipvid001'), true);
  // A real YouTube id must never be caught by the pattern list.
  assert.equal(isKnownSeedId('GRzaq5AHiV8'), false);
});

// ---------------------------------------------------------------------------
// usagelog.js normally writes to the FIXED path data/usage-events.jsonl in
// the repo — the user's real usage history, which `npm test` runs
// concurrently across many test files (several of which now boot a real
// server and log real events, correctly stamped synthetic:true). To test
// logEvent's own behaviour without racing those files OR touching real
// history, point ECHO_USAGE_LOG_PATH at a private tmp file per test.
// ---------------------------------------------------------------------------

async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start >= timeout) return predicate();
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('usagelog.logEvent stamps synthetic:true under ECHO_USAGE_SYNTHETIC and rotates past the size threshold', async (t) => {
  const logPath = join(tmpdir(), `echo-usage-rotate-${process.pid}-${Date.now()}-${Math.random()}.jsonl`);
  const rotatedPath = logPath.replace(/\.jsonl$/, '.1.jsonl');
  process.env.ECHO_USAGE_LOG_PATH = logPath;
  process.env.ECHO_USAGE_SYNTHETIC = '1';
  process.env.ECHO_USAGE_ROTATE_BYTES = '80';
  t.after(() => {
    delete process.env.ECHO_USAGE_LOG_PATH;
    delete process.env.ECHO_USAGE_SYNTHETIC;
    delete process.env.ECHO_USAGE_ROTATE_BYTES;
    rmSync(logPath, { force: true });
    rmSync(rotatedPath, { force: true });
  });

  const { logEvent } = await import(`../usagelog.js?test=${Date.now()}-${Math.random()}`);

  // Seed the log past the (tiny, test-only) 80-byte rotation threshold so
  // the next write is forced to roll it over.
  const seedLine = JSON.stringify({ event: 'transcript', videoId: 'GRzaq5AHiV8', ok: true, seed: true }) + '\n';
  writeFileSync(logPath, seedLine.repeat(3)); // well over 80 bytes

  logEvent('save', { videoId: 'GRzaq5AHiV8', hadDigest: true, ok: true });

  await waitFor(() => existsSync(rotatedPath));
  await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"save"'));

  const rotated = readFileSync(rotatedPath, 'utf8');
  const current = readFileSync(logPath, 'utf8');

  // The old, oversized content moved to the .1 file...
  assert.equal(rotated, seedLine.repeat(3));
  // ...and the new event landed in a fresh current file, stamped synthetic.
  const record = JSON.parse(current.trim());
  assert.equal(record.event, 'save');
  assert.equal(record.videoId, 'GRzaq5AHiV8');
  assert.equal(record.synthetic, true);
});

test('usagelog.logEvent does not stamp synthetic when ECHO_USAGE_SYNTHETIC is unset', async (t) => {
  const logPath = join(tmpdir(), `echo-usage-plain-${process.pid}-${Date.now()}-${Math.random()}.jsonl`);
  process.env.ECHO_USAGE_LOG_PATH = logPath;
  delete process.env.ECHO_USAGE_SYNTHETIC;
  process.env.ECHO_USAGE_ROTATE_BYTES = String(10 * 1024 * 1024); // effectively no rotation
  t.after(() => {
    delete process.env.ECHO_USAGE_LOG_PATH;
    delete process.env.ECHO_USAGE_ROTATE_BYTES;
    rmSync(logPath, { force: true });
    rmSync(logPath.replace(/\.jsonl$/, '.1.jsonl'), { force: true });
  });

  const { logEvent } = await import(`../usagelog.js?test=${Date.now()}-${Math.random()}`);

  logEvent('save', { videoId: 'GRzaq5AHiV8', hadDigest: true, ok: true });

  await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"save"'));

  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.equal(record.event, 'save');
  assert.equal('synthetic' in record, false);
});
