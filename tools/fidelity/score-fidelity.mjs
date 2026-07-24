#!/usr/bin/env node
// Dev-only eval: measure how faithfully Echo's saved digests carry the
// transcript's concrete specifics.
//
//   npm run digest:fidelity              # every saved digest in data/library.db
//   npm run digest:fidelity -- --json    # machine-readable, for tracking over time
//   npm run digest:fidelity -- <videoId> # one entry
//
// Read-only: never writes to data/library.db, never calls a model, fully
// deterministic. Not imported by server.js or any bundled module.
//
// WHAT THIS IS FOR
// ----------------
// The digest prompt promises two things that pull against each other: keep
// every concrete specific, and never invent one. Both are checkable without a
// judge, and together they are the closest thing to a measurement of the claim
// Echo's whole positioning rests on. Track them when the prompt changes — a
// prompt edit that quietly starts dropping numbers is otherwise invisible until
// a user notices.
//
// WHAT IT IS NOT
// --------------
// Not a quality score. A digest can preserve every number and still misread the
// video, and a low `unsupported` count on a digest that says nothing is not a
// win. Read the numbers next to the compression ratio, and read the flagged
// items — some "unsupported" specifics are legitimate rephrasings ("about a
// third" for "34%"), which is exactly why this prints them instead of just
// scoring them.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { compareFidelity } from './specifics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DB_PATH = process.env.ECHO_DB_PATH || join(REPO_ROOT, 'data', 'library.db');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const onlyId = args.find((a) => !a.startsWith('--'));

if (!existsSync(DB_PATH)) {
  console.error(`No library database at ${DB_PATH}. Save a digest first, or set ECHO_DB_PATH.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(`
  SELECT videoId, title, segments, digest
  FROM videos
  WHERE digest IS NOT NULL AND TRIM(digest) != ''
  ${onlyId ? 'AND videoId = ?' : ''}
  ORDER BY savedAt DESC
`).all(...(onlyId ? [onlyId] : []));

if (rows.length === 0) {
  console.error(onlyId ? `No saved digest for ${onlyId}.` : 'No saved digests to score yet.');
  process.exit(1);
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
/** Chars, readable at both ends of the range — a 200k transcript and a 400-char digest. */
const chars = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : `${n}`);

const results = [];
for (const row of rows) {
  let transcript = '';
  try {
    transcript = JSON.parse(row.segments || '[]').map((s) => s.text || '').join(' ');
  } catch { /* unparseable segments — treated as an empty transcript below */ }
  if (!transcript.trim()) continue;

  const m = compareFidelity(transcript, row.digest);
  results.push({ videoId: row.videoId, title: row.title || row.videoId, ...m });
}

if (asJson) {
  console.log(JSON.stringify({ db: DB_PATH, scored: results.length, results }, null, 2));
  process.exit(0);
}

console.log(`\nFidelity — ${results.length} digest${results.length === 1 ? '' : 's'} from ${DB_PATH}\n`);

for (const r of results) {
  const title = r.title.length > 58 ? `${r.title.slice(0, 57)}…` : r.title;
  console.log(`${title}  [${r.videoId}]`);
  console.log(`  length      ${chars(r.transcriptChars)} chars → ${chars(r.digestChars)}  (${pct(r.compression)} of source)`);
  console.log(`  numbers     ${r.numeric.retained}/${r.numeric.inDigest} in the digest are in the transcript (${pct(r.numeric.supportedRate)} supported) · ${pct(r.numeric.coverage)} of the transcript's carried through`);

  if (r.proper.meaningful) {
    console.log(`  names       ${r.proper.retained}/${r.proper.inDigest} supported (${pct(r.proper.supportedRate)}) · ${pct(r.proper.coverage)} coverage`);
  } else {
    // Auto-captions are frequently lowercase, which would make every name look
    // invented. Saying so beats printing a meaningless 0%.
    console.log('  names       (transcript carries no capitalisation — proper-noun check skipped)');
  }

  const flagged = [
    ...r.numeric.unsupported.slice(0, 6),
    ...(r.proper.meaningful ? r.proper.unsupported.slice(0, 6) : []),
  ];
  if (flagged.length > 0) {
    console.log(`  ⚠ not in transcript: ${flagged.join(', ')}`);
  }
  console.log('');
}

// Aggregate. Weighted by count, not averaged per entry, so one short digest
// cannot swing the number.
const totals = results.reduce((acc, r) => ({
  numDigest: acc.numDigest + r.numeric.inDigest,
  numRetained: acc.numRetained + r.numeric.retained,
  numSource: acc.numSource + r.numeric.inTranscript,
  chars: acc.chars + r.transcriptChars,
  digestChars: acc.digestChars + r.digestChars,
}), { numDigest: 0, numRetained: 0, numSource: 0, chars: 0, digestChars: 0 });

console.log('─'.repeat(64));
console.log(`numbers supported   ${pct(totals.numDigest ? totals.numRetained / totals.numDigest : 1)}  (${totals.numRetained}/${totals.numDigest} stated in digests are in their transcripts)`);
console.log(`numbers carried     ${pct(totals.numSource ? totals.numRetained / totals.numSource : 1)}  (${totals.numRetained}/${totals.numSource} of the transcripts')`);
console.log(`overall compression ${pct(totals.chars ? totals.digestChars / totals.chars : 0)}`);
console.log('\nFlagged items are candidates, not verdicts — "about a third" for "34%" is a');
console.log('legitimate rephrasing. Read them; do not just watch the percentage.\n');
