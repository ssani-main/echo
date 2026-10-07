import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, mergeUsage, buildSpawnTarget, scaledTimeoutMs, generateDigest } from '../digest.js';
import { ClaudeCliProvider, ApiKeyProvider } from '../providers.js';

test('scaledTimeoutMs: at or under 480k chars the base is returned unchanged', () => {
  assert.equal(scaledTimeoutMs(0, 180_000), 180_000);
  assert.equal(scaledTimeoutMs(480_000, 180_000), 180_000);
  assert.equal(scaledTimeoutMs(undefined, 180_000), 180_000);
});

test('scaledTimeoutMs: scales by ceil(chars / 480k)', () => {
  assert.equal(scaledTimeoutMs(480_001, 180_000), 360_000);
  assert.equal(scaledTimeoutMs(2_400_000, 180_000), 900_000);
  assert.equal(scaledTimeoutMs(2_400_001, 180_000), 1_080_000);
});

test('scaledTimeoutMs: an explicit base is respected; a bad base falls back to the default', () => {
  assert.equal(scaledTimeoutMs(960_000, 600_000), 1_200_000);
  assert.ok(scaledTimeoutMs(100, 0) > 0);
  assert.ok(scaledTimeoutMs(100, NaN) > 0);
});

// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Single-line transcripts (the shape every real client actually sends)
// ---------------------------------------------------------------------------

test('chunkText: a long SINGLE-LINE transcript still splits — the real client sends no newlines', () => {
  // buildPlainTranscript() in src/client/main.js strips newlines out of every
  // segment and joins with a space, and the Obsidian plugin joins with a space
  // too. So the text reaching generateDigest() is one enormous line. While
  // chunkText only split on '\n', that returned a single chunk at any length,
  // `chunks.length > 1` was false, and the map-reduce long path could never be
  // entered — a ~10-hour video went down the fast path with its whole
  // transcript in one prompt. Guard the shape that actually ships.
  const budget = 1000;
  const oneLine = 'word '.repeat(2000).trim(); // ~10k chars, zero newlines
  const chunks = chunkText(oneLine, budget);

  assert.ok(chunks.length > 1, 'a single long line must still produce multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= budget, `chunk length ${chunk.length} exceeds budget ${budget}`);
  }
  // Splitting happens on spaces, so rejoining with a space restores the text.
  assert.equal(chunks.join(' '), oneLine, 'no content was lost or duplicated');
});

test('chunkText: a single unbroken run longer than the budget is hard-cut rather than emitted oversized', () => {
  // No space to split on. Emitting one over-budget piece would defeat the
  // budget, so the splitter cuts mid-run on purpose.
  const budget = 100;
  const chunks = chunkText('x'.repeat(350), budget);
  assert.ok(chunks.length > 1, 'an unbreakable run still gets divided');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= budget, `chunk length ${chunk.length} exceeds budget ${budget}`);
  }
  assert.equal(chunks.join(''), 'x'.repeat(350), 'no content was lost');
});

test('chunkText: a degenerate budget terminates instead of spinning', () => {
  // splitOversizedLines() cuts at `lastIndexOf(' ', budget)` and hard-cuts at
  // `budget` when there is no space. With a budget of 0 that made every cut
  // zero-width, so `rest` never shrank and the loop appended empty strings
  // until the array hit V8's length limit ("Invalid array length"). No caller
  // passes such a budget — chunkText defaults to CHUNK_CONTENT_CHARS — but it
  // is exported, so the floor is guarded rather than assumed.
  for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const chunks = chunkText('a bb ccc dddd eeeee', budget);
    assert.ok(Array.isArray(chunks), `budget ${budget} returned an array`);
    assert.ok(chunks.length >= 1 && chunks.length < 100,
      `budget ${budget} produced ${chunks.length} chunks — the split made no progress`);
  }
});

// ---------------------------------------------------------------------------
// Wiring: the timeout each provider call actually RECEIVES. The providers are
// plain objects, so their `call` can be stubbed without spawning the CLI.
// ---------------------------------------------------------------------------

const STUB_OK = { result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };

function unit(chars) {
  const u = 'the quick brown fox jumps over the lazy dog and keeps talking ';
  return u.repeat(Math.ceil(chars / u.length)).slice(0, chars);
}

test('single call: a transcript over 480k gets a scaled timeout, one at or under gets opts untouched', async (t) => {
  const seen = [];
  t.mock.method(ClaudeCliProvider, 'call', async (_prompt, o) => { seen.push(o); return STUB_OK; });

  // 1M chars: under the CLI's 2.4M map-reduce threshold, so one call; ceil(1M/480k) = 3.
  await generateDigest(unit(1_000_000), { timeoutMs: 100_000 });
  assert.equal(seen[0].timeoutMs, 300_000);

  const opts = { timeoutMs: 100_000 };
  await generateDigest(unit(480_000), opts);
  assert.equal(seen[1], opts, 'at the threshold the original opts object is passed through');
  assert.equal(seen[1].timeoutMs, 100_000);
});

test('map phase: each chunk is scaled by ITS OWN length; chunks at or under 480k are untouched', async (t) => {
  // CLI chunks are 1.8M chars: 5M -> 1.8M, 1.8M, 1.4M => x4, x4, x3.
  const cli = [];
  t.mock.method(ClaudeCliProvider, 'call', async (prompt, o) => {
    if (!prompt.includes('CHUNK SUMMARIES')) cli.push(o.timeoutMs);
    return STUB_OK;
  });
  await generateDigest(unit(5_000_000), { timeoutMs: 100_000 });
  assert.deepEqual(cli, [400_000, 400_000, 300_000]);

  // anthropic chunks are 360k chars: never over 480k, so opts must pass through as-is.
  const api = [];
  t.mock.method(ApiKeyProvider, 'call', async (prompt, o) => {
    if (!prompt.includes('CHUNK SUMMARIES')) api.push(o);
    return STUB_OK;
  });
  const opts = { provider: 'anthropic', apiKey: 'k', timeoutMs: 100_000 };
  await generateDigest(unit(1_000_000), opts);
  assert.ok(api.length >= 2, 'it fanned out');
  for (const o of api) assert.equal(o, opts, 'the original opts object, not a copy');
});
