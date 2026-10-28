// Port of the pure parts of ../digest.js: the CLI argument lists, the timeout
// scaling, usage merging, the defensive JSON extraction and the transcript
// chunker. The CLI spawning, the provider calls and the prompts come with the
// digest route (see PORT.md). Checked against the original by
// check/digest.cases.ts.

// The original tags errors by setting `e.echoCode` on a plain Error, which
// TypeScript does not allow; a subclass carries the same field. Its `name`
// stays "Error", as the original's does.
export class EchoError extends Error {
  echoCode: string;
  constructor(message: string, echoCode: string) {
    super(message);
    this.echoCode = echoCode;
  }
}

// Wall-clock guard for one CLI call. Bare Number(...) || fallback: a malformed
// value cannot be abused into anything, it just falls back.
// shortcut: `?? ''` because Seshat's Number() takes only a string (gap: number-of-non-string); Number('')
// and Number(undefined) both fall back here. Drop it when Number() takes anything, as in TypeScript.
const DEFAULT_TIMEOUT_MS = Number(process.env.ECHO_DIGEST_TIMEOUT_MS ?? '') || 180_000;

// System prompt that pins the CLI subprocess to a pure text-transformation
// role. Without it the spawned `claude -p` runs as an interactive Claude Code
// session and can reply with meta-commentary instead of a digest. Kept free of
// cmd.exe metacharacters (& | < > ^ % ") so it survives the Windows
// `cmd.exe /c claude …` spawn path unescaped.
const ISOLATED_SYSTEM_PROMPT =
  'You are a precise summarization and digest engine for video transcripts. ' +
  'Follow the instructions in the user message exactly and return only the requested output as Markdown. ' +
  'Do not add meta-commentary, do not ask questions, and never mention sessions, memory, files, tools, or any workspace or project.';

const CLI_MODEL = 'claude-opus-5-5';

const CLAUDE_ARGS = [
  '-p', '--model', CLI_MODEL, '--output-format', 'json',
  '--system-prompt', ISOLATED_SYSTEM_PROMPT,
];

/** The CLI args for a `claude -p` invocation. */
export function buildClaudeArgs(): string[] {
  return [...CLAUDE_ARGS];
}

// `--include-partial-messages` turns on the per-token `content_block_delta`
// events; it requires `--output-format stream-json`, which requires `--verbose`.
const CLAUDE_STREAM_ARGS = [
  '-p', '--model', CLI_MODEL, '--output-format', 'stream-json',
  '--include-partial-messages', '--verbose',
  '--system-prompt', ISOLATED_SYSTEM_PROMPT,
];

/** The CLI args for a streaming `claude -p` invocation. */
export function buildClaudeStreamArgs(): string[] {
  return [...CLAUDE_STREAM_ARGS];
}

// Claude's map-reduce geometry, kept as the literal defaults: the runtime
// values are derived per provider (thresholdCharsFor/chunkBudgetCharsFor,
// ported with the provider registry).
const LONG_PATH_THRESHOLD_CHARS = 480_000; // ~120 k tokens
const CHUNK_CONTENT_CHARS = 360_000; // ~90 k tokens per chunk

/**
 * Per-call time allowance for a single-call digest of `chars` transcript
 * chars: base x ceil(chars / 480k), never below base.
 */
// shortcut: the original coerces anything with Number() (scaledTimeoutMs('960000') works there); Seshat's
// Number() takes only a string (gap: number-of-non-string), so the parameters are numbers, which is what
// every caller passes. Take `unknown` again when Number() does.
export function scaledTimeoutMs(chars: number, baseMs: number | null = DEFAULT_TIMEOUT_MS): number {
  const base = Number(baseMs ?? NaN) > 0 ? Number(baseMs ?? NaN) : DEFAULT_TIMEOUT_MS;
  const n = Number(chars) || 0;
  const ratio = n / LONG_PATH_THRESHOLD_CHARS;
  // shortcut: Seshat's Math.ceil returns an int and traps on Infinity (gap: math-ceil-infinity), where
  // JavaScript gives Infinity; an infinite ratio is passed through as it is. Plain Math.ceil once fixed.
  return base * Math.max(1, Number.isFinite(ratio) ? Math.ceil(ratio) : ratio);
}

// On Windows `claude` is a .cmd shim, which cannot be spawned without
// shell:true, so cmd.exe is invoked explicitly and spawn keeps shell:false.
export function buildSpawnTarget(): { exe: string; args: string[] } {
  const args = buildClaudeArgs();
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { exe: comspec, args: ['/c', 'claude', ...args] };
  }
  return { exe: 'claude', args };
}

/** Usage of one provider call, as mapUsage() builds it. */
export interface Usage {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  durationMs: number | null;
}

/** Accumulate usage across several calls (map + reduce phases). */
export function mergeUsage(usages: Usage[]): Usage {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalTokens = 0;
  let durationMs = 0;
  let anyNullCost = false;

  for (const u of usages) {
    if (u.costUsd === null) anyNullCost = true;
    else costUsd += u.costUsd;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cacheReadTokens += u.cacheReadTokens;
    cacheCreationTokens += u.cacheCreationTokens;
    totalTokens += u.totalTokens;
    durationMs += (u.durationMs || 0);
  }

  return {
    costUsd: anyNullCost ? null : costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    durationMs,
  };
}

/**
 * Strips markdown code fences / surrounding prose, then extracts the first
 * complete JSON object from `str`. Throws an EchoError (MODEL_BAD_JSON) if
 * nothing parseable is found.
 */
export function parseJsonLoose(str: string): unknown {
  // Strip ```json ... ``` or ``` ... ``` fences
  const s = str.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

  // (a) a direct parse of the fence-stripped/trimmed text first.
  try {
    const direct: unknown = JSON.parse(s);
    return direct;
  } catch (_) {
    // fall through
  }

  const start = s.indexOf('{');
  if (start === -1) {
    throw new EchoError(`No JSON object found in Claude output. Snippet: ${str.slice(0, 300)}`, 'MODEL_BAD_JSON');
  }

  // (b) brace-slice: first '{' to last '}'.
  const lastEnd = s.lastIndexOf('}');
  if (lastEnd > start) {
    try {
      const sliced: unknown = JSON.parse(s.slice(start, lastEnd + 1));
      return sliced;
    } catch (_) {
      // fall through to repair attempts
    }
  }

  // (c) light repair: progressively shorter slices from the first '{' to each
  // later '}', from the end backwards; the first that parses wins. Recovers
  // from trailing prose or a stray '}' further out than the real close.
  const closeIndices: number[] = [];
  for (let i = s.indexOf('}', start); i !== -1; i = s.indexOf('}', i + 1)) {
    closeIndices.push(i);
  }
  for (let i = closeIndices.length - 1; i >= 0; i--) {
    const end = closeIndices[i]!;
    try {
      const repaired: unknown = JSON.parse(s.slice(start, end + 1));
      return repaired;
    } catch (_) {
      // try the next shorter candidate
    }
  }

  // (d) all attempts failed.
  throw new EchoError(`Could not parse JSON from Claude output. Snippet: ${str.slice(0, 300)}`, 'MODEL_BAD_JSON');
}

/**
 * Break any single line longer than the budget into word-boundary pieces.
 * Every real client flattens a transcript into ONE line, so without this the
 * newline-based chunker returned one chunk and map-reduce was unreachable. A
 * run without spaces longer than the budget is hard-cut.
 */
function splitOversizedLines(lines: string[], budgetChars: number): string[] {
  // Every cut must consume at least one character, or the loop spins forever
  // (a budget of 0 once did: slice(0, 0) fed an empty string back in).
  const budget = Number.isFinite(budgetChars) && budgetChars >= 1
    ? Math.floor(budgetChars)
    : CHUNK_CONTENT_CHARS;

  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= budget) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > budget) {
      // Prefer the last space inside the budget, so words stay intact.
      let cut = rest.lastIndexOf(' ', budget);
      if (cut <= 0) cut = budget; // no boundary available — hard-cut
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Split plain transcript text into ordered chunks at newline boundaries,
 * each fitting within budgetChars.
 */
export function chunkText(text: string, budgetChars: number = CHUNK_CONTENT_CHARS): string[] {
  const lines = splitOversizedLines(text.split('\n'), budgetChars);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the rejoined newline
    if (currentChars + lineLen > budgetChars && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [line];
      currentChars = lineLen;
    } else {
      current.push(line);
      currentChars += lineLen;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
