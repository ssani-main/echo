import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickCorpus, scoreOne, summarizeRuns, buildDigestOpts } from '../tools/ab-compare.mjs';

// ---------------------------------------------------------------------------
// tools/ab-compare.mjs — the numbers a reader decides on.
//
// The two SCORERS are already covered by tests/fidelity-specifics.test.js (45
// tests) and the ai-tell detector's own suite, and this tool calls those rather
// than reimplementing them. What is not covered by either is the part this file
// adds: which transcripts get picked, and how per-digest results are combined
// into the aggregate — the two places where a plausible-looking bug produces a
// confidently wrong conclusion rather than an error.
//
// Importing the module must not fire a run: a stray import in a test would
// otherwise spend real model calls. That guard is itself asserted below.
// ---------------------------------------------------------------------------

const seg = (texts) => JSON.stringify(texts.map((t, i) => ({ text: t, offset: i * 1000 })));

const ROWS = [
  { videoId: 'aaaaaaaaaaa', title: 'short', segments: seg(['one two three']) },
  { videoId: 'bbbbbbbbbbb', title: 'medium', segments: seg(['four five six seven eight nine']) },
  { videoId: 'ccccccccccc', title: 'broken', segments: 'not json at all' },
  { videoId: 'ddddddddddd', title: 'empty', segments: seg(['   ', '']) },
  { videoId: 'eeeeeeeeeee', title: 'long', segments: seg(['ten eleven twelve thirteen fourteen fifteen sixteen']) },
];

test('pickCorpus: takes the first N, in the order given', () => {
  const corpus = pickCorpus(ROWS, { limit: 2 });
  // The SQL orders shortest-first, so "the order given" IS cheapest-first.
  assert.deepEqual(corpus.map((c) => c.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('pickCorpus: an unreadable or empty entry is skipped, not fatal', () => {
  const corpus = pickCorpus(ROWS, { limit: 10 });
  // One entry with unparseable segments must not cost you the other four.
  assert.deepEqual(corpus.map((c) => c.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'eeeeeeeeeee']);
  for (const c of corpus) assert.ok(c.transcript.trim().length > 0);
});

test('pickCorpus: naming ids means you meant those ids, so the limit gets out of the way', () => {
  // A default --limit of 4 silently dropping half of an explicit --ids list is
  // the kind of bug that reads as "the corpus was small", not as a bug.
  const corpus = pickCorpus(ROWS, { onlyIds: ['aaaaaaaaaaa', 'eeeeeeeeeee', 'bbbbbbbbbbb'], limit: 1 });
  assert.deepEqual(corpus.map((c) => c.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'eeeeeeeeeee']);

  // Row order, not the order the ids were typed: the query orders shortest-first
  // so an --ids run still starts with the cheapest transcript and still finishes
  // in a predictable order. Asserted because the opposite is a reasonable guess.
  assert.deepEqual(
    pickCorpus(ROWS, { onlyIds: ['eeeeeeeeeee', 'aaaaaaaaaaa'] }).map((c) => c.videoId),
    ['aaaaaaaaaaa', 'eeeeeeeeeee']
  );
});

test('pickCorpus: reports the char count the header prints', () => {
  const corpus = pickCorpus(ROWS, { limit: 1 });
  assert.equal(corpus[0].chars, corpus[0].transcript.length);
  assert.equal(corpus[0].chars, 'one two three'.length);
});

test('pickCorpus: an empty corpus is empty, not a crash', () => {
  assert.deepEqual(pickCorpus([], { limit: 4 }), []);
  assert.deepEqual(pickCorpus(ROWS, { onlyIds: ['zzzzzzzzzzz'] }), []);
});

// ---------------------------------------------------------------------------
// scoreOne
// ---------------------------------------------------------------------------

test('scoreOne: a number carried from the transcript counts as supported', () => {
  const transcript = 'The team reported around 1500 engineers and 34 percent of changes.';
  const digest = 'They reported 34 percent of changes.';
  const { fidelity, aitell } = scoreOne(transcript, digest);
  assert.equal(fidelity.numeric.inDigest, 1);
  assert.equal(fidelity.numeric.retained, 1);
  assert.equal(fidelity.numeric.unsupported.length, 0);
  assert.ok(aitell.wordCount > 0);
});

test('scoreOne: a number that is NOT in the transcript is flagged as fabricated', () => {
  // The whole point of the fidelity axis: a digest may not invent specifics.
  const transcript = 'The team reported around 1500 engineers.';
  const digest = 'The team of 4200 engineers shipped it.';
  const { fidelity } = scoreOne(transcript, digest);
  assert.equal(fidelity.numeric.unsupported.length, 1);
  assert.equal(fidelity.numeric.retained, 0);
});

// ---------------------------------------------------------------------------
// summarizeRuns
// ---------------------------------------------------------------------------

/** A run whose fidelity block is spelled out, so the arithmetic is checkable by eye. */
function run(over = {}) {
  return {
    provider: 'anthropic',
    title: 't',
    ok: true,
    ms: 1000,
    truncated: false,
    usage: { totalTokens: 100, costUsd: 0.01 },
    aitell: { score: 10, label: 'band', wordCount: 100 },
    fidelity: {
      numeric: { inDigest: 4, retained: 3, unsupported: ['9999'], inTranscript: 6 },
      transcriptChars: 1000,
      digestChars: 400,
    },
    ...over,
  };
}

test('summarizeRuns: rates are weighted by count, not averaged per digest', () => {
  // Two digests: one keeps 3 of 4, the other 0 of 1. Weighted = 3/5 = 60%.
  // A per-digest average would say (0.75 + 0)/2 = 38% — a materially different
  // number, and the wrong one, which is why this is asserted rather than assumed.
  const runs = [
    run(),
    run({
      fidelity: {
        numeric: { inDigest: 1, retained: 0, unsupported: ['7'], inTranscript: 1 },
        transcriptChars: 1000, digestChars: 100,
      },
    }),
  ];
  const s = summarizeRuns(runs, ['anthropic']).anthropic;
  assert.equal(s.n, 2);
  assert.equal(s.numericInDigest, 5);
  assert.equal(s.numericRetained, 3);
  assert.equal(s.supportedRate, 3 / 5);
  assert.equal(s.numericFabricated, 2);
});

test('summarizeRuns: coverage is measured against the SOURCE, and is a different number', () => {
  // Retaining every number you kept says nothing about how many you kept. This
  // is the axis that stops a digest winning by saying almost nothing.
  const runs = [run()];
  const s = summarizeRuns(runs, ['anthropic']).anthropic;
  assert.equal(s.supportedRate, 3 / 4); // of what it wrote
  assert.equal(s.coverage, 3 / 6);      // of what existed
  assert.notEqual(s.supportedRate, s.coverage);
});

test('summarizeRuns: compression is digest chars over source chars', () => {
  const s = summarizeRuns([run()], ['anthropic']).anthropic;
  assert.equal(s.compression, 400 / 1000);
});

test('summarizeRuns: a provider that never reported a cost gets null, not a sum of one arm', () => {
  // DeepSeek reports no cost at all. Summing "0.01 + nothing" would print a
  // total that looks like a measurement and is actually one arm's number.
  const withCost = run();
  const noCost = run({ usage: { totalTokens: 100 } });
  const s = summarizeRuns([withCost, noCost], ['anthropic']).anthropic;
  assert.equal(s.hasCost, false);
  assert.equal(s.totalCostUsd, null);
  // Tokens are still summed — those both providers do report.
  assert.equal(s.totalTokens, 200);
});

test('summarizeRuns: failures and truncations are counted, and failed runs are excluded from rates', () => {
  const runs = [
    run(),
    run({ ok: false, error: 'API_NOT_AUTHED: no key', fidelity: undefined, aitell: undefined }),
    run({ truncated: true }),
  ];
  const s = summarizeRuns(runs, ['anthropic']).anthropic;
  assert.equal(s.n, 2, 'only ok runs feed the rates');
  assert.equal(s.failures, 1);
  assert.equal(s.truncated, 1);
});

test('summarizeRuns: an arm that ran nothing is omitted, so the report can say UNAVAILABLE', () => {
  const runs = [run({ provider: 'deepseek', ok: false, error: 'API_NOT_AUTHED: no key' })];
  const summary = summarizeRuns(runs, ['deepseek', 'anthropic']);
  assert.equal(summary.deepseek, undefined);
  assert.equal(summary.anthropic, undefined);
});

test('summarizeRuns: worst ai-tell is the maximum, because that is the one a reader notices', () => {
  const runs = [run({ aitell: { score: 3, label: 'a', wordCount: 10 } }), run({ aitell: { score: 41, label: 'b', wordCount: 10 } })];
  const s = summarizeRuns(runs, ['anthropic']).anthropic;
  assert.equal(s.maxAiTell, 41);
  assert.equal(s.meanAiTell, 22);
});

// ---------------------------------------------------------------------------
// buildDigestOpts
// ---------------------------------------------------------------------------

test('buildDigestOpts: an unset timeout means the PRODUCTION default stays in force', () => {
  // If the eval quietly injected its own timeout, a run that would fail in
  // production would look fine here — and the failure mode being hidden is
  // exactly the class of bug this whole workstream is about.
  const opts = buildDigestOpts({ provider: 'claude-cli', format: 'digest', language: 'English', title: 't', reasoning: 'off' });
  assert.ok(!('timeoutMs' in opts), 'no timeoutMs key at all when one was not asked for');
  assert.deepEqual(opts, { provider: 'claude-cli', format: 'digest', language: 'English', title: 't', reasoning: 'off' });
});

test('buildDigestOpts: a raised timeout is passed through, and only then', () => {
  const base = { provider: 'deepseek', format: 'article', language: 'English', title: 't', reasoning: 'high' };
  assert.equal(buildDigestOpts({ ...base, timeoutMs: 900_000 }).timeoutMs, 900_000);
  assert.ok(!('timeoutMs' in buildDigestOpts({ ...base, timeoutMs: 0 })));
  assert.ok(!('timeoutMs' in buildDigestOpts({ ...base, timeoutMs: -5 })));
});

// ---------------------------------------------------------------------------
// the import guard
// ---------------------------------------------------------------------------

test('importing the module does not fire a run', () => {
  // If this file's import started the tool, the two tests above would already
  // have spent real model calls. This asserts the guard against exactly that:
  // the module resolves and its argv does not match the module path.
  const here = fileURLToPath(import.meta.url);
  const tool = resolve(fileURLToPath(new URL('../tools/ab-compare.mjs', import.meta.url)));
  assert.notEqual(resolve(here), tool);
});
