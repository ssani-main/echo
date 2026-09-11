#!/usr/bin/env node
// Dev-only eval: run the SAME transcript through two providers and compare the
// digests they produce, on the two axes Echo's positioning actually rests on.
//
//   npm run digest:ab                          # 4 shortest saved transcripts, both providers
//   npm run digest:ab -- --limit 8             # more of the corpus
//   npm run digest:ab -- --ids GRzaq5AHiV8     # specific entries
//   npm run digest:ab -- --providers deepseek  # one arm only
//   npm run digest:ab -- --dry-run             # list the corpus, call nothing
//
// WHAT THIS IS FOR
// ----------------
// The provider seam exists so this question can be answered with evidence:
// does a second provider write worse digests than the first? Two things are
// checkable without a judge, and both already have a tool in this repo:
//
//   fidelity  — does the digest carry the transcript's concrete specifics, and
//               does it invent any? (tools/fidelity/specifics.mjs)
//   ai-tell   — does it read like generic AI writing? (tools/ai-tell/)
//
// This calls BOTH of those rather than reimplementing either, so a fix in the
// scoring lands here for free and the two can never disagree.
//
// WHAT IT IS NOT
// --------------
// Not a verdict. A digest can keep every number and still misread the video, and
// reasoning, prompt and language all move the numbers. Read it next to the
// digests themselves — the arms are printed side by side precisely so a human
// can look at the prose the numbers are summarising.
//
// FAIRNESS
// --------
// Format, language and reasoning level are FIXED for every arm and printed at
// the top, because a comparison where the provider is not the only variable is
// not a comparison. Reasoning in particular defaults to `off`: two providers
// that disagree about whether to think before answering are not being compared
// on the model.
//
// Read-only: never writes to the library, and writes nothing at all unless
// --out is given. The pure parts (corpus selection, scoring, aggregation) are
// exported so tests/ab-compare.test.js can guard the numbers a reader decides on.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { generateDigest } from '../digest.js';
import { PROVIDERS, getProviderId, getReasoningLevel } from '../providers.js';
import { compareFidelity } from './fidelity/specifics.mjs';

const require = createRequire(import.meta.url);
const AIDetector = require('./ai-tell/patterns.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DB_PATH = process.env.ECHO_DB_PATH || join(REPO_ROOT, 'data', 'library.db');

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The opts one arm runs with.
 *
 * Exported so a test can assert that an unset --timeout-ms does NOT appear here.
 * Production's own default has to stay in force unless the eval deliberately
 * changes it, or the numbers describe a different program than the one users run.
 *
 * @param {{ provider: string, format: string, language: string, title: string, reasoning: string, timeoutMs?: number }} o
 */
export function buildDigestOpts({ provider, format, language, title, reasoning, timeoutMs = 0 }) {
  const opts = { provider, format, language, title, reasoning };
  // Only when asked for. digest.js's own default (180s) otherwise, which is what
  // a real user gets.
  if (timeoutMs > 0) opts.timeoutMs = timeoutMs;
  return opts;
}

/** Production's per-call ceiling, so the report can flag runs that only finished
 * because the eval raised it. Kept in sync with DEFAULT_TIMEOUT_MS in digest.js;
 * it is repeated rather than imported because this is a reporting threshold, not
 * a behaviour. */
const PRODUCTION_TIMEOUT_MS = 180_000;

/**
 * Turns library rows into a corpus, cheapest-first.
 *
 * A row whose segments will not parse, or that carries no text at all, is
 * skipped rather than failing the run: this is an eval, and one unreadable entry
 * should not cost you the other nine.
 *
 * @param {Array<{videoId:string,title?:string,segments?:string}>} rows
 * @param {{ onlyIds?: string[], limit?: number }} [opts]
 * @returns {Array<{videoId:string,title:string,transcript:string,chars:number}>}
 */
export function pickCorpus(rows, { onlyIds = [], limit = 4 } = {}) {
  const corpus = [];
  for (const row of rows) {
    if (onlyIds.length && !onlyIds.includes(row.videoId)) continue;
    let transcript = '';
    try {
      transcript = JSON.parse(row.segments || '[]').map((s) => s.text || '').join(' ');
    } catch { /* unparseable — skipped below */ }
    if (!transcript.trim()) continue;
    corpus.push({
      videoId: row.videoId,
      title: row.title || row.videoId,
      transcript,
      chars: transcript.length,
    });
    // A limit only applies when picking automatically. Naming ids means you
    // asked for those ids, so honouring a default limit of 4 there would
    // silently drop half of what was requested.
    if (!onlyIds.length && corpus.length >= limit) break;
  }
  return corpus;
}

/**
 * Scores one digest on both axes. Thin, but it is the only place the two
 * scorers are wired together, so a change to either is felt here.
 *
 * @param {string} transcript
 * @param {string} digest
 */
export function scoreOne(transcript, digest) {
  const fidelity = compareFidelity(transcript, digest);
  const aid = AIDetector.analyzeText(digest);
  return {
    fidelity,
    aitell: { score: aid.score, label: aid.label, wordCount: aid.stats.wordCount ?? 0 },
  };
}

/**
 * Aggregates runs into the per-provider numbers the report prints.
 *
 * Rates are weighted by count rather than averaged per digest, so one short
 * digest cannot swing a result — the same reasoning the fidelity tool uses.
 *
 * @param {Array<object>} runs
 * @param {string[]} providerIds
 */
export function summarizeRuns(runs, providerIds) {
  const summary = {};
  for (const provider of providerIds) {
    const arm = runs.filter((r) => r.provider === provider && r.ok);
    if (!arm.length) continue;

    const numericInDigest = arm.reduce((n, r) => n + r.fidelity.numeric.inDigest, 0);
    const numericRetained = arm.reduce((n, r) => n + r.fidelity.numeric.retained, 0);
    const numericInTranscript = arm.reduce((n, r) => n + r.fidelity.numeric.inTranscript, 0);
    const srcChars = arm.reduce((n, r) => n + r.fidelity.transcriptChars, 0);
    const digestChars = arm.reduce((n, r) => n + r.fidelity.digestChars, 0);
    const words = arm.reduce((n, r) => n + r.aitell.wordCount, 0);
    const aiScores = arm.map((r) => r.aitell.score);

    // Only counted when a provider actually reports it. The CLI reports a
    // notional cost and DeepSeek reports none at all, so a summed "total cost"
    // across both would be a number invented from one arm's data.
    const costs = arm.map((r) => (r.usage && typeof r.usage.costUsd === 'number' ? r.usage.costUsd : null));

    summary[provider] = {
      n: arm.length,
      meanWords: Math.round(words / arm.length),
      meanAiTell: Number((aiScores.reduce((a, b) => a + b, 0) / arm.length).toFixed(1)),
      maxAiTell: Math.max(...aiScores),
      compression: srcChars ? digestChars / srcChars : 0,
      numericInDigest,
      numericRetained,
      numericFabricated: arm.reduce((n, r) => n + r.fidelity.numeric.unsupported.length, 0),
      supportedRate: numericInDigest ? numericRetained / numericInDigest : null,
      // The other half of the promise: retaining every number you kept is
      // worthless if you kept almost none of them. An arm can win "supported"
      // by saying nothing, which is why coverage sits beside it.
      coverage: numericInTranscript ? numericRetained / numericInTranscript : null,
      truncated: arm.filter((r) => r.truncated).length,
      meanMs: Math.round(arm.reduce((n, r) => n + r.ms, 0) / arm.length),
      totalTokens: arm.reduce((n, r) => n + ((r.usage && r.usage.totalTokens) || 0), 0),
      totalCostUsd: costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null,
      hasCost: costs.every((c) => c !== null),
      failures: runs.filter((r) => r.provider === provider && !r.ok).length,
    };
  }
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const pct = (n) => (n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(0)}%`);
const w = (s, n) => String(s).padEnd(n);

/**
 * The instrument must not corrupt the measurement.
 *
 * A `claude -p` subprocess spawned from inside a Claude Code session inherits
 * CLAUDECODE=1 + the CLAUDE_CODE_* variables and behaves differently from the
 * one a user's `node server.js` spawns — measured on this repo once already:
 * identical code returned English tags with them set (8/8) and Indonesian tags
 * without (4/4), and three hypotheses were wrongly cleared because the repro
 * kept "passing". Unset them here so the CLI arm measures the CLI.
 */
function stripClaudeCodeEnv() {
  for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE')) delete process.env[key];
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag, fallback = '') => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const asJson = has('--json');
  const dryRun = has('--dry-run');
  const limit = Number(valueOf('--limit', '4')) || 4;
  const format = valueOf('--format', 'digest');
  const language = valueOf('--language', 'English');
  const thinking = getReasoningLevel({ reasoning: valueOf('--thinking', 'off') });
  const timeoutMs = Number(valueOf('--timeout-ms', '0')) || 0;
  const outPath = valueOf('--out', '');
  const onlyIds = valueOf('--ids', '').split(',').map((s) => s.trim()).filter(Boolean);
  const providerIds = valueOf('--providers', 'claude-cli,deepseek')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((p) => getProviderId({ provider: p }));

  stripClaudeCodeEnv();

  if (!existsSync(DB_PATH)) {
    console.error(`No library database at ${DB_PATH}. Save a digest first, or set ECHO_DB_PATH.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare('SELECT videoId, title, segments FROM videos ORDER BY length(segments) ASC').all();
  const corpus = pickCorpus(rows, { onlyIds, limit });

  if (corpus.length === 0) {
    console.error('No transcripts to test. Pick different --ids, or save a digest first.');
    process.exit(1);
  }

  const totalChars = corpus.reduce((n, c) => n + c.chars, 0);
  const knobs = {
    format, language, thinking,
    providers: providerIds.map((id) => `${id} (${PROVIDERS[id] ? PROVIDERS[id].defaultModel : '?'})`),
  };

  console.log('Provider A/B — same transcripts, different models, same everything else\n');
  console.log(`  corpus       ${corpus.length} transcript(s), ${totalChars.toLocaleString('en-US')} chars`);
  for (const c of corpus) {
    console.log(`               · ${String(c.title).slice(0, 62)}  (${c.chars.toLocaleString('en-US')} chars)`);
  }
  console.log(`  format       ${knobs.format}`);
  console.log(`  language     ${knobs.language}`);
  console.log(`  thinking     ${knobs.thinking}   <- fixed for every arm, or the models are not the only variable`);
  if (timeoutMs > 0) {
    console.log(`  per-call cap ${Math.round(timeoutMs / 1000)}s   <- RAISED from production's ${PRODUCTION_TIMEOUT_MS / 1000}s;`);
    console.log('               runs above production are flagged in PER RUN, so this buys data points rather than hiding a limit');
  }
  console.log(`  providers    ${knobs.providers.join('  ·  ')}\n`);

  if (dryRun) {
    console.log('--dry-run: nothing was called.');
    return;
  }

  const runs = [];
  for (const provider of providerIds) {
    for (const entry of corpus) {
      process.stdout.write(`  … ${provider} · ${String(entry.title).slice(0, 40)}\r`);
      const t0 = Date.now();
      try {
        const res = await generateDigest(entry.transcript, buildDigestOpts({
          provider, format, language, title: entry.title, reasoning: thinking, timeoutMs,
        }));
        runs.push({
          provider, videoId: entry.videoId, title: entry.title, ok: true,
          digest: res.digest, usage: res.usage, strategy: res.strategy,
          truncated: res.truncated, ms: Date.now() - t0,
          ...scoreOne(entry.transcript, res.digest),
        });
      } catch (err) {
        runs.push({
          provider, videoId: entry.videoId, title: entry.title, ok: false,
          error: (err && err.echoCode ? `${err.echoCode}: ` : '') + ((err && err.message) || String(err)),
          ms: Date.now() - t0,
        });
      }
    }
  }
  process.stdout.write(' '.repeat(90) + '\r');

  const summary = summarizeRuns(runs, providerIds);
  const available = providerIds.filter((p) => summary[p]);

  console.log('─'.repeat(78));
  console.log('PER RUN');
  console.log('─'.repeat(78));
  for (const provider of providerIds) {
    const arm = runs.filter((r) => r.provider === provider);
    const failed = arm.filter((r) => !r.ok);
    if (!summary[provider]) {
      // One clear line, not a stack trace. An arm that cannot run is a fact
      // about the environment (usually a missing key), not a crash.
      console.log(`\n${provider}: UNAVAILABLE — ${failed[0] ? failed[0].error : 'no runs'}`);
      continue;
    }
    console.log(`\n${provider}`);
    for (const r of arm) {
      const title = String(r.title).slice(0, 44).padEnd(44);
      if (!r.ok) { console.log(`  ${title}  FAILED — ${r.error}`); continue; }
      const flags = [
        r.truncated ? 'TRUNCATED' : '',
        r.strategy === 'mapreduce' ? 'map-reduce' : '',
        // Say it out loud when a run only completed because the cap was raised:
        // in production this digest would have failed, and that is a fact about
        // the app worth knowing, not a detail to average away.
        r.ms > PRODUCTION_TIMEOUT_MS ? `>${PRODUCTION_TIMEOUT_MS / 1000}s (would time out in production)` : '',
      ].filter(Boolean).join(' ');
      console.log(
        `  ${title}  ${String(r.aitell.wordCount).padStart(5)}w` +
        `  ai-tell ${String(r.aitell.score).padStart(3)}` +
        `  nums ${r.fidelity.numeric.retained}/${r.fidelity.numeric.inDigest}` +
        `  ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${flags}`
      );
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log('AGGREGATE (weighted by count, so one short digest cannot swing it)');
  console.log('─'.repeat(78));

  console.log(['metric', ...available].map((h, i) => w(h, i === 0 ? 30 : 20)).join(''));
  console.log('─'.repeat(30 + 20 * available.length));

  const metric = (name, fn) => {
    console.log(w(name, 30) + available.map((p) => w(fn(summary[p]), 20)).join(''));
  };
  metric('digests', (s) => s.n);
  metric('mean words', (s) => s.meanWords);
  metric('compression (digest/source)', (s) => pct(s.compression));
  metric('numbers kept in digest', (s) => s.numericInDigest);
  metric('numbers supported', (s) => `${s.numericRetained} (${pct(s.supportedRate)})`);
  metric('numbers NOT in transcript', (s) => s.numericFabricated);
  metric('numeric coverage of source', (s) => pct(s.coverage));
  metric('ai-tell mean (lower better)', (s) => s.meanAiTell);
  metric('ai-tell worst', (s) => s.maxAiTell);
  metric('truncated', (s) => s.truncated);
  metric('failed runs', (s) => s.failures);
  metric('mean seconds', (s) => Math.round(s.meanMs / 1000));
  metric('total tokens', (s) => s.totalTokens.toLocaleString('en-US'));
  metric('total cost (if reported)', (s) => (s.hasCost ? `$${s.totalCostUsd.toFixed(4)}` : 'not reported'));

  console.log('');
  console.log('Fidelity is two numbers that pull against each other: "numbers supported" says the');
  console.log('digest did not invent specifics; "coverage" says it did not drop them. An arm can win');
  console.log('the first by saying nothing, which is why the second is printed beside it. ai-tell is');
  console.log('0-100 with higher = more generic-AI signals, so lower is better.');
  if (!available.includes('deepseek')) {
    console.log('');
    console.log('NOTE: the DeepSeek arm did not run — set ECHO_DEEPSEEK_API_KEY (or DEEPSEEK_API_KEY)');
    console.log('and re-run. Until then this measures one provider against nothing.');
  }

  if (outPath) {
    const dest = resolve(REPO_ROOT, outPath);
    writeFileSync(dest, JSON.stringify({
      knobs, db: DB_PATH, corpus: corpus.map((c) => ({ videoId: c.videoId, title: c.title, chars: c.chars })),
      summary, runs,
    }, null, 2));
    console.log(`\nWrote ${dest}`);
  }

  if (asJson) console.log(JSON.stringify({ knobs, summary }, null, 2));
}

// Guarded so importing this module (tests) cannot fire a run of real model calls.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  await main();
}
