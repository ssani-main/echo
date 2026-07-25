#!/usr/bin/env node
// Tally data/usage-events.jsonl into the product signals that decide next steps.
// Usage: node usage_stats.mjs [path-to-jsonl]
//
// Answers: (1) what is used (counts), (2) is the digest good (re-digest,
// save-after-digest), (3) long-video handling (strategy + char buckets).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(__dirname, 'data', 'usage-events.jsonl');

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch {
  console.error(`No log found at ${path}. Nothing to report yet.`);
  process.exit(0);
}

const allEvents = raw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

// Real YouTube ids are exactly 11 chars from [A-Za-z0-9_-]. Local media gets
// a legitimate synthetic id shaped `file_<14-char lowercase hex>` (see
// server.js localMediaId()) — that's real usage and must keep counting.
// Anything else in a `videoId` field (e.g. `gzipvid001`) is seeded/benchmark
// data that leaked into the log, not a user action.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const FILE_ID_RE = /^file_[0-9a-f]{14}$/i;
const isRealVideoId = (id) => YOUTUBE_ID_RE.test(id) || FILE_ID_RE.test(id);

// A pure shape check isn't enough: some seeded ids (e.g. `page0000024`,
// `probe000001`) happen to also be 11 alphanumeric characters, so they pass
// isRealVideoId() undetected. These named patterns are a BACKSTOP for
// events logged BEFORE usagelog.js's ECHO_USAGE_SYNTHETIC flag existed —
// every in-repo test now sets that flag before touching the server (see
// usagelog.js), so any *new* fixture id is already excluded via the
// `synthetic` flag above and should never need an entry here. Do not extend
// this list for a new test; fix the test to set ECHO_USAGE_SYNTHETIC=1
// instead — that's read-independent of the path a videoId happens to take.
const KNOWN_SEED_ID_PATTERNS = [
  /^page\d+$/, // tests/saved-pagination.test.js pagination fixture
  /^probe\d+$/, // external library-scale sweep script (not in-repo)
  /^apivid\d+$/, // tests/api.test.js
  /^expvid\d+$/, // tests/api.test.js
  /^searchvid\d+$/, // tests/api.test.js
  /^gzipvid\d+$/, // tests/page-serving.test.js (also excluded by shape, 10 chars)
];
const isKnownSeedId = (id) => KNOWN_SEED_ID_PATTERNS.some((re) => re.test(id));

let excludedCount = 0;
const events = allEvents.filter((e) => {
  if (e.synthetic === true) { excludedCount++; return false; }
  if (e.videoId != null && (isKnownSeedId(e.videoId) || !isRealVideoId(e.videoId))) {
    excludedCount++;
    return false;
  }
  return true;
});

console.log(`excluded ${excludedCount} synthetic/seeded events`);

if (!events.length) {
  console.log('Log is empty.');
  process.exit(0);
}

const by = (name) => events.filter((e) => e.event === name);
const count = {};
for (const e of events) count[e.event] = (count[e.event] || 0) + 1;

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

console.log(`\n=== Echo usage — ${events.length} events (${path}) ===\n`);

console.log('Action counts:');
Object.entries(count)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

// --- Core loop funnel ---
const digests = by('digest');
const saves = by('save');
const transcripts = by('transcript');
console.log('\nCore loop:');
console.log(`  transcript -> digest   ${pct(digests.length, transcripts.length)} (${digests.length}/${transcripts.length})`);
console.log(`  digest -> save         ${pct(saves.length, digests.length)} (${saves.length}/${digests.length})`);
console.log(`  saves with digest      ${saves.filter((s) => s.hadDigest).length}/${saves.length}`);

// --- Digest quality signals (per videoId) ---
// (ask-after-digest used to live here too, but the Ask feature — /api/chat —
// is gone; that line could only ever report on dead history, so it was
// removed along with the Enrich section below.)
const digestVids = digests.filter((d) => d.videoId).map((d) => d.videoId);
const redigested = new Set(digestVids.filter((v, i) => digestVids.indexOf(v) !== i)).size;
const digestVidSet = new Set(digestVids);
const saveVids = new Set(saves.filter((s) => s.videoId).map((s) => s.videoId));
const saveAfterDigest = [...saveVids].filter((v) => digestVidSet.has(v)).length;
console.log('\nDigest quality signals:');
console.log(`  re-digested videos     ${redigested} (dissatisfaction signal)`);
console.log(`  save-after-digest      ${saveAfterDigest}/${digestVidSet.size} distinct digested videos`);

// --- Long-video handling ---
const strat = {};
for (const d of digests) strat[d.strategy || 'unknown'] = (strat[d.strategy || 'unknown'] || 0) + 1;
const buckets = { '<50k': 0, '50k-200k': 0, '200k-480k': 0, '>480k': 0 };
for (const d of digests) {
  const c = d.chars || 0;
  if (c < 50000) buckets['<50k']++;
  else if (c < 200000) buckets['50k-200k']++;
  else if (c < 480000) buckets['200k-480k']++;
  else buckets['>480k']++;
}
console.log('\nLong-video handling:');
console.log(`  strategy: ${JSON.stringify(strat)}`);
console.log(`  transcript size: ${JSON.stringify(buckets)}`);

// --- Digest knobs ---
const tally = (arr, key) => {
  const t = {};
  for (const e of arr) t[e[key] || 'default'] = (t[e[key] || 'default'] || 0) + 1;
  return t;
};
console.log(`  format picks: ${JSON.stringify(tally(digests, 'format'))}`);
console.log(`  length picks: ${JSON.stringify(tally(digests, 'length'))}`);

// --- Search ---
const search = by('search');
if (search.length) {
  console.log('\nLibrary search:');
  console.log(`  runs: ${search.length}, mode: ${JSON.stringify(tally(search, 'mode'))}`);
}

// --- Cost ---
const totalCost = events.reduce((s, e) => s + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
console.log(`\nTotal logged AI cost: $${totalCost.toFixed(4)}\n`);
