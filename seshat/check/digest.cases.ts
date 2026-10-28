import {
  buildClaudeArgs, buildClaudeStreamArgs, buildSpawnTarget, scaledTimeoutMs, mergeUsage, parseJsonLoose, chunkText,
} from '../digest.ts';
import type { Usage } from '../digest.ts';
import type { EchoError } from '../digest.ts';
import { out } from './out.ts';

out('buildClaudeArgs', buildClaudeArgs());
out('buildClaudeStreamArgs', buildClaudeStreamArgs());
out('buildSpawnTarget', buildSpawnTarget());
const args = buildClaudeArgs();
args.push('mutated');
out('buildClaudeArgs returns a copy', buildClaudeArgs().length);

// --- scaledTimeoutMs
const charCounts = [0, 1, 479_999, 480_000, 480_001, 960_000, 960_001, 2_400_000, -5, 1e12, NaN, Infinity, -Infinity, 0.5];
const bases: (number | undefined)[] = [undefined, 0, -1, 1000, NaN, 0.5, 600_000];
for (const c of charCounts) {
  for (const b of bases) out(`scaledTimeoutMs(${c}, ${b})`, b === undefined ? scaledTimeoutMs(c) : scaledTimeoutMs(c, b));
}
out('scaledTimeoutMs(1, null)', scaledTimeoutMs(1, null));

// --- mergeUsage
const u = (costUsd: number | null, n: number, durationMs: number | null): Usage => ({
  costUsd, inputTokens: n, outputTokens: n * 2, cacheReadTokens: n * 3, cacheCreationTokens: n * 4, totalTokens: n * 10, durationMs,
});
out('mergeUsage/empty', mergeUsage([]));
out('mergeUsage/one', mergeUsage([u(0.5, 1, 100)]));
out('mergeUsage/floats', mergeUsage([u(0.1, 1, 1.5), u(0.2, 2, null), u(0.3, 3, 0)]));
out('mergeUsage/a null cost', mergeUsage([u(0.1, 1, 10), u(null, 2, 20)]));
out('mergeUsage/big', mergeUsage([u(1e308, 1e15, 1e15), u(1e308, 1e15, 1e15)]));

// --- parseJsonLoose: tests/parse-json-loose.test.js's inputs, plus edges.
const looseInputs = [
  '{"claims":[{"claim":"foo","assessment":"supported"}]}',
  '```json\n{"chapters":[{"title":"Intro","startSec":0}]}\n```',
  '```\n{"quotes":[{"text":"hello","startSec":5}]}\n```',
  '{"claims":[{"claim":"bar","assessment":"disputed"}]}\n\nHope this helps!',
  '{"claim":"a set like {1,2,3} was mentioned","assessment":"supported"}',
  'Here you go: {"tags":["a","b"]} and a stray } here',
  'Sorry, I cannot produce that response right now.',
  '{"claims": [ this is not valid json at all }}}',
  '["just", "an", "array"]',
  '42',
  '"a string"',
  'null',
  '',
  '   ',
  '```JSON\n{"upper":true}\n```',
  '```js{"x":1}```',
  'prefix {"a":{"b":{"c":[1,2,{"d":"}"}]}}} suffix }',
  '{"emoji":"😀","escaped":"\\ud83d\\ude00","lone":"\\ud83d","nul":"\\u0000"}',
  '{"n":1e400,"m":-0,"f":0.1,"big":12345678901234567890}',
  '{"dup":1,"dup":2}',
  '{"__proto__":{"x":1},"a":1}',
  '{"2":"b","1":"a","x":"c"}',
  'Text with {braces} but {"real": "json"} later',
  `${'x'.repeat(400)} no json here`,
  '{',
  '}{',
];
looseInputs.forEach((input, i) => {
  try {
    out(`parseJsonLoose#${i}`, { value: parseJsonLoose(input) });
  } catch (e) {
    // shortcut: `e as Error & { echoCode?: string }` doesn't compile (gap: error-intersection); every error
    // parseJsonLoose throws is an EchoError, so cast to that.
    const err = e as EchoError;
    out(`parseJsonLoose#${i}`, { error: err.name, message: err.message, echoCode: err.echoCode });
  }
});

// --- chunkText
const flat = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
const lined = Array.from({ length: 12 }, (_, i) => `line ${i} ${'x'.repeat(i)}`).join('\n');
const texts = [
  '', 'one line', flat, lined, `${'y'.repeat(30)} tail`, '\n\n\n', 'a\n\nb', `${'😀'.repeat(10)} ${'é'.repeat(7)}`,
  'trailing space ', ' leading space', 'double  space  here', 'Ünïcödé text with ümlauts and more words',
];
const budgets = [1, 2, 5, 10, 17, 64, 360_000];
texts.forEach((t, i) => {
  for (const b of budgets) out(`chunkText#${i}/${b}`, chunkText(t, b));
});
out('chunkText/default budget', chunkText(lined));
for (const b of [0, -1, NaN, Infinity, 2.5]) out(`chunkText/odd budget ${b}`, chunkText(flat, b));
