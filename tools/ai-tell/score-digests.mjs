#!/usr/bin/env node
// Dev-only eval: score Echo's saved digests (or an ad-hoc text file / stdin)
// with the vendored "avoid-ai-writing" detector (see README.md in this dir).
//
// Usage:
//   npm run digest:aitell                # scores every saved digest in data/library.db
//   npm run digest:aitell -- path/to.txt # scores a single ad-hoc .txt/.md file
//   npm run digest:aitell -- -           # scores stdin
//
// Read-only: never writes to data/library.db. Not imported by server.js or
// any bundled backend module — this is a dev tool only.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AIDetector = require('./patterns.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DB_PATH = join(REPO_ROOT, 'data', 'library.db');

function scoreOne(title, text) {
  const r = AIDetector.analyzeText(text);
  const catCounts = {};
  for (const issue of r.issues) {
    catCounts[issue.type] = (catCounts[issue.type] || 0) + 1;
  }
  const topCats = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return {
    title,
    wordCount: r.stats.wordCount ?? 0,
    score: r.score,
    label: r.label,
    classification: r.document_classification,
    topCats,
    issues: r.issues,
  };
}

function printTable(results) {
  console.log('═'.repeat(100));
  console.log('PER-DIGEST SCORES');
  console.log('═'.repeat(100));
  for (const res of results) {
    const catStr = res.topCats.map(([t, n]) => `${t}(${n})`).join(', ') || 'none';
    console.log(`\n▸ "${String(res.title).slice(0, 70)}"`);
    console.log(`  words=${res.wordCount}  score=${res.score}  band="${res.label}"  class=${res.classification}`);
    console.log(`  top categories: ${catStr}`);
  }
}

function printAggregate(results) {
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const n = scores.length;
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : 0;
  const median = n
    ? (n % 2 === 1
        ? scores[(n - 1) / 2]
        : (scores[n / 2 - 1] + scores[n / 2]) / 2)
    : 0;
  const min = n ? scores[0] : 0;
  const max = n ? scores[n - 1] : 0;

  const bandCounts = {};
  for (const res of results) bandCounts[res.label] = (bandCounts[res.label] || 0) + 1;

  console.log('\n' + '═'.repeat(100));
  console.log('AGGREGATE STATS');
  console.log('═'.repeat(100));
  console.log(`n = ${n}`);
  console.log(`mean score   = ${mean.toFixed(1)}`);
  console.log(`median score = ${median.toFixed(1)}`);
  console.log(`min score    = ${min}`);
  console.log(`max score    = ${max}`);
  console.log('\nBand distribution:');
  for (const [band, count] of Object.entries(bandCounts)) {
    console.log(`  ${band}: ${count}`);
  }
}

function printCategoryBreakdown(results) {
  const globalCatCounts = {};
  const globalCatTexts = {};
  for (const res of results) {
    for (const issue of res.issues) {
      globalCatCounts[issue.type] = (globalCatCounts[issue.type] || 0) + 1;
      if (!globalCatTexts[issue.type]) globalCatTexts[issue.type] = [];
      if (globalCatTexts[issue.type].length < 3) globalCatTexts[issue.type].push(issue.text);
    }
  }
  const sortedCats = Object.entries(globalCatCounts).sort((a, b) => b[1] - a[1]);

  console.log('\n' + '═'.repeat(100));
  console.log('RECURRING PATTERN CATEGORIES');
  console.log('═'.repeat(100));
  if (sortedCats.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const [cat, count] of sortedCats) {
    const examples = (globalCatTexts[cat] || []).join(' | ');
    console.log(`  ${cat.padEnd(28)} count=${count}   e.g. ${examples}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const arg = process.argv[2];

  if (arg) {
    // Ad-hoc single-text mode: a file path or "-" for stdin.
    let text;
    if (arg === '-') {
      text = await readStdin();
    } else {
      const filePath = resolve(process.cwd(), arg);
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      text = readFileSync(filePath, 'utf8');
    }

    if (!text || !text.trim()) {
      console.error('No text to score (input was empty).');
      process.exit(1);
    }

    const result = scoreOne(arg === '-' ? '(stdin)' : arg, text);
    printTable([result]);
    printAggregate([result]);
    printCategoryBreakdown([result]);
    console.log('\nDone.');
    return;
  }

  // Default mode: score every non-empty digest in the library DB, read-only.
  if (!existsSync(DB_PATH)) {
    console.error(`Library DB not found at ${DB_PATH}`);
    console.error('Nothing to score. Save at least one digest, or pass a text file / "-" for stdin.');
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  console.log(`DB opened read-only from: ${DB_PATH}\n`);

  const allRows = db.prepare('SELECT videoId, title, digest FROM videos ORDER BY savedAt DESC').all();
  const withDigest = allRows.filter((r) => r.digest && String(r.digest).trim().length > 0);

  console.log(`Total saved entries: ${allRows.length}`);
  console.log(`Entries with a non-empty digest: ${withDigest.length}\n`);

  if (withDigest.length === 0) {
    console.log('No digests to score.');
    db.close();
    return;
  }

  const results = withDigest.map((row) => scoreOne(row.title || '(untitled)', String(row.digest)));

  printTable(results);
  printAggregate(results);
  printCategoryBreakdown(results);
  console.log('\nDone.');

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
