import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, chunkText, chunkSegments, mergeUsage, buildSpawnTarget } from '../digest.js';

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens: returns 0 for an empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: returns a positive integer proportional to length', () => {
  const short = estimateTokens('abcd'); // 4 chars -> 1 token
  const long = estimateTokens('abcd'.repeat(1000)); // 4000 chars -> 1000 tokens
  assert.ok(Number.isInteger(short));
  assert.ok(short > 0);
  assert.ok(Number.isInteger(long));
  assert.ok(long > short);
  // Roughly proportional: longer text ~1000x the tokens of the short text
  assert.ok(long >= short * 900);
});

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

test('chunkText: short text produces a single chunk', () => {
  const text = 'line one\nline two\nline three';
  const chunks = chunkText(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test('chunkText: very long multi-line text splits into multiple chunks, each within budget, preserving content', () => {
  // Build a large multi-line string so the line-based splitter actually splits it.
  const budget = 1000;
  const line = 'a'.repeat(50); // 50 chars per line
  const lineCount = 400; // ~400 * 51 = 20,400 chars total, well beyond the budget
  const original = Array.from({ length: lineCount }, () => line).join('\n');

  const chunks = chunkText(original, budget);

  assert.ok(chunks.length > 1, 'expected multiple chunks for long input');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= budget + line.length, `chunk length ${chunk.length} should roughly respect budget ${budget}`);
  }

  // Concatenation (rejoined by newline) preserves all original lines/content.
  const rejoined = chunks.join('\n');
  assert.equal(rejoined, original);
});

// ---------------------------------------------------------------------------
// chunkSegments
// ---------------------------------------------------------------------------

test('chunkSegments: splits a large segments array into multiple ordered chunks under budget', () => {
  const budget = 500;
  const segments = Array.from({ length: 200 }, (_, i) => ({
    text: `segment number ${i} with some filler text to bulk it up`,
    offset: i * 5,
  }));

  const chunks = chunkSegments(segments, budget);

  assert.ok(Array.isArray(chunks));
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(Array.isArray(chunk));
    const chars = chunk.reduce((sum, seg) => sum + `[${Math.round(seg.offset)}] ${seg.text}\n`.length, 0);
    assert.ok(chars <= budget || chunk.length === 1, `chunk exceeds budget unexpectedly: ${chars}`);
  }

  // Order preserved: flatten chunks and compare to the original sequence.
  const flat = chunks.flat();
  assert.equal(flat.length, segments.length);
  for (let i = 0; i < segments.length; i++) {
    assert.equal(flat[i].text, segments[i].text);
    assert.equal(flat[i].offset, segments[i].offset);
  }
});

test('chunkSegments: small array fits in a single chunk', () => {
  const segments = [{ text: 'hello', offset: 0 }, { text: 'world', offset: 1 }];
  const chunks = chunkSegments(segments);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], segments);
});

// ---------------------------------------------------------------------------
// mergeUsage
// ---------------------------------------------------------------------------

test('mergeUsage: sums numeric fields across multiple usage objects', () => {
  const usages = [
    { costUsd: 0.01, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, totalTokens: 165, durationMs: 1000 },
    { costUsd: 0.02, inputTokens: 200, outputTokens: 75, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 275, durationMs: 2000 },
  ];

  const merged = mergeUsage(usages);

  assert.ok(Math.abs(merged.costUsd - 0.03) < 1e-9);
  assert.equal(merged.inputTokens, 300);
  assert.equal(merged.outputTokens, 125);
  assert.equal(merged.cacheReadTokens, 10);
  assert.equal(merged.cacheCreationTokens, 5);
  assert.equal(merged.totalTokens, 440);
  assert.equal(merged.durationMs, 3000);
});

test('mergeUsage: handles an empty array gracefully', () => {
  const merged = mergeUsage([]);
  assert.equal(merged.costUsd, 0);
  assert.equal(merged.inputTokens, 0);
  assert.equal(merged.outputTokens, 0);
  assert.equal(merged.totalTokens, 0);
  assert.equal(merged.durationMs, 0);
});

test('mergeUsage: a null costUsd in any entry makes the merged costUsd null', () => {
  const usages = [
    { costUsd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15, durationMs: 100 },
    { costUsd: null, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 30, durationMs: 200 },
  ];
  const merged = mergeUsage(usages);
  assert.equal(merged.costUsd, null);
  assert.equal(merged.inputTokens, 30);
  assert.equal(merged.totalTokens, 45);
});

// ---------------------------------------------------------------------------
// buildSpawnTarget — CLI context isolation (regression guard)
// ---------------------------------------------------------------------------

// Regression test for the project-context-leak bug: the spawned `claude` CLI
// used to inherit this project's Claude Code memory / CLAUDE.md, causing it
// to reply with conversational meta-commentary ("this looks like the wrong
// session…") instead of a digest. The fix pins the subprocess to an isolated
// system prompt via `--system-prompt` (and runs it from tmpdir(), see
// runClaude()). This test guards against `--system-prompt` being dropped or
// re-broken, and against the isolated prompt containing cmd.exe
// metacharacters that would corrupt the Windows `cmd.exe /c claude …` spawn
// path.
test('buildSpawnTarget: wires an isolated --system-prompt that is cmd.exe-safe, without regressing the base invocation', () => {
  const { args } = buildSpawnTarget();

  const flagIndex = args.indexOf('--system-prompt');
  assert.ok(flagIndex !== -1, 'expected --system-prompt to be present in the spawn args');

  const systemPrompt = args[flagIndex + 1];
  assert.equal(typeof systemPrompt, 'string');
  assert.ok(systemPrompt.trim().length > 0, 'system prompt must not be empty');

  // Must survive the Windows `cmd.exe /c claude ...` spawn path unescaped.
  const cmdMetacharacters = /[&|<>^%"]/;
  assert.ok(
    !cmdMetacharacters.test(systemPrompt),
    `system prompt must not contain cmd.exe metacharacters, got: ${systemPrompt}`
  );

  // Base invocation must be unchanged.
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('json'));
});
