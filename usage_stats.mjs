#!/usr/bin/env node
// Tally data/usage-events.jsonl into the product signals that decide next steps.
// Usage: node usage_stats.mjs [path-to-jsonl]
//
// Answers: (1) what is used (counts), (2) is the digest good (re-digest,
// ask-after-digest, save-after-digest), (3) long-video handling (strategy +
// char buckets), (4) is web-grounded enrich trustworthy (grounded rate).

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

const events = raw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

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
const digestVids = digests.filter((d) => d.videoId).map((d) => d.videoId);
const redigested = new Set(digestVids.filter((v, i) => digestVids.indexOf(v) !== i)).size;
const digestVidSet = new Set(digestVids);
const askVids = new Set(by('ask').filter((a) => a.videoId).map((a) => a.videoId));
const saveVids = new Set(saves.filter((s) => s.videoId).map((s) => s.videoId));
const askAfterDigest = [...askVids].filter((v) => digestVidSet.has(v)).length;
const saveAfterDigest = [...saveVids].filter((v) => digestVidSet.has(v)).length;
console.log('\nDigest quality signals:');
console.log(`  re-digested videos     ${redigested} (dissatisfaction signal)`);
console.log(`  ask-after-digest       ${askAfterDigest} videos (digest left a gap)`);
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

// --- Enrich grounding ---
const enrich = by('enrich');
console.log('\nEnrich:');
console.log(`  mode: ${JSON.stringify(tally(enrich, 'mode'))}`);
const grounded = enrich.filter((e) => e.grounded === true).length;
const searched = enrich.filter((e) => e.results != null).length;
console.log(`  grounded (web returned hits): ${pct(grounded, searched)} (${grounded}/${searched} web-search runs)`);

// --- Search ---
const search = by('search');
if (search.length) {
  console.log('\nLibrary search:');
  console.log(`  runs: ${search.length}, mode: ${JSON.stringify(tally(search, 'mode'))}`);
}

// --- Cost ---
const totalCost = events.reduce((s, e) => s + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
console.log(`\nTotal logged AI cost: $${totalCost.toFixed(4)}\n`);
