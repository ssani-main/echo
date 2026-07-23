import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { getProvider } from './providers.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes

// System prompt that pins the CLI subprocess to a pure text-transformation
// role. Without this, the spawned `claude -p` runs as an interactive Claude
// Code session and, combined with inherited project context, can reply with
// conversational meta-commentary ("this looks like the wrong session…")
// instead of a digest. Kept free of cmd.exe metacharacters (& | < > ^ % ")
// so it survives the Windows `cmd.exe /c claude …` spawn path unescaped.
const ISOLATED_SYSTEM_PROMPT =
  'You are a precise summarization and digest engine for video transcripts. ' +
  'Follow the instructions in the user message exactly and return only the requested output as Markdown. ' +
  'Do not add meta-commentary, do not ask questions, and never mention sessions, memory, files, tools, or any workspace or project.';

const CLAUDE_ARGS = [
  '-p', '--model', 'sonnet', '--output-format', 'json',
  '--system-prompt', ISOLATED_SYSTEM_PROMPT,
];

/**
 * Builds the CLI args array for a `claude -p` invocation.
 *
 * @returns {string[]}
 */
function buildClaudeArgs() {
  return CLAUDE_ARGS;
}

// ---------------------------------------------------------------------------
// Map-reduce chunking constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

// Enter the long (map-reduce) path when estimated transcript chars exceed
// this. Below this threshold behaviour is IDENTICAL to today — single call.
const LONG_PATH_THRESHOLD_CHARS = 480_000; // ~120 k tokens

// Maximum chars of transcript content to feed a single map-phase Claude call.
// This leaves ~30 k tokens of headroom for the prompt wrapper and model
// output within a 200 k-token context window.
const CHUNK_CONTENT_CHARS = 360_000; // ~90 k tokens per chunk

// On Windows `claude` is installed as a .cmd shim, which cannot be spawned
// directly without shell:true. Instead, we invoke cmd.exe explicitly so we
// keep shell:false on the spawn call itself (no deprecation warning) while
// still being able to find the .cmd shim on PATH.
export function buildSpawnTarget() {
  const args = buildClaudeArgs();
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { exe: comspec, args: ['/c', 'claude', ...args] };
  }
  return { exe: 'claude', args };
}

// ---------------------------------------------------------------------------
// Usage mapping (shared)
// ---------------------------------------------------------------------------

function mapUsage(parsed) {
  const u = parsed.usage || {};
  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const cacheReadTokens = u.cache_read_input_tokens || 0;
  const cacheCreationTokens = u.cache_creation_input_tokens || 0;
  return {
    costUsd: (typeof parsed.total_cost_usd === 'number') ? parsed.total_cost_usd : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    durationMs: (typeof parsed.duration_ms === 'number') ? parsed.duration_ms : null,
  };
}

/**
 * Accumulate usage stats across multiple Claude calls (map + reduce phases).
 * Produces a single usage object with the same shape as mapUsage().
 *
 * @param {object[]} usages
 * @returns {object}
 */
export function mergeUsage(usages) {
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

// ---------------------------------------------------------------------------
// Defensive JSON extraction
// ---------------------------------------------------------------------------

/**
 * Strips markdown code fences / surrounding prose, then extracts the first
 * complete JSON object from `str`. Throws if nothing parseable is found.
 *
 * @param {string} str
 * @returns {unknown}
 */
export function parseJsonLoose(str) {
  // Strip ```json ... ``` or ``` ... ``` fences
  const s = str.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

  // (a) try a direct parse of the fence-stripped/trimmed text first.
  try {
    return JSON.parse(s);
  } catch (_) {
    // fall through
  }

  const start = s.indexOf('{');
  if (start === -1) {
    const e = new Error(`No JSON object found in Claude output. Snippet: ${str.slice(0, 300)}`);
    e.echoCode = 'MODEL_BAD_JSON';
    throw e;
  }

  // (b) brace-slice: first '{' to last '}'.
  const lastEnd = s.lastIndexOf('}');
  if (lastEnd > start) {
    try {
      return JSON.parse(s.slice(start, lastEnd + 1));
    } catch (_) {
      // fall through to repair attempts
    }
  }

  // (c) light repair: try progressively shorter slices from the first '{' to
  // each subsequent '}', working backwards from the end, returning the first
  // that parses. This recovers from trailing prose after the JSON, or a
  // stray unmatched '}' further out than the real closing brace.
  const closeIndices = [];
  for (let i = s.indexOf('}', start); i !== -1; i = s.indexOf('}', i + 1)) {
    closeIndices.push(i);
  }
  for (let i = closeIndices.length - 1; i >= 0; i--) {
    const end = closeIndices[i];
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {
      // try the next shorter candidate
    }
  }

  // (d) all attempts failed — throw a clearly tagged error.
  const e = new Error(`Could not parse JSON from Claude output. Snippet: ${str.slice(0, 300)}`);
  e.echoCode = 'MODEL_BAD_JSON';
  throw e;
}

// ---------------------------------------------------------------------------
// Core helper — all public functions go through this
// ---------------------------------------------------------------------------

/**
 * Runs the Claude CLI with the given prompt and returns the raw result text
 * plus a mapped usage object.
 *
 * @param {string} prompt
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ result: string, usage: object }>}
 */
export async function runClaude(prompt, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { exe, args } = buildSpawnTarget();
  const isWin = process.platform === 'win32';

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn(exe, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Run from the OS temp dir, not the project dir, so the CLI does not
      // auto-load this project's Claude Code memory or a project CLAUDE.md
      // (which would leak workspace context into the digest output).
      cwd: tmpdir(),
      // On non-Windows, run in its own process group so we can kill the
      // whole tree (child + any grandchildren) on timeout via a negative pid.
      ...(isWin ? {} : { detached: true }),
    });

    // Kills the entire process tree rooted at `child`. On Windows, `child`
    // is `cmd.exe /c claude`, and cmd.kill() only kills cmd.exe itself,
    // orphaning the grandchild `claude` process — so we use `taskkill /T`
    // to kill the whole tree instead. On POSIX, killing the negative pid
    // (the process group) reaches the detached child and its descendants.
    function killTree() {
      if (typeof child.pid !== 'number') return;
      if (isWin) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            stdio: 'ignore',
          }).on('error', () => { /* ignore — process may already be gone */ });
        } catch (_) { /* ignore */ }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (_) { /* ignore — process may already be gone */ }
      }
    }

    // --- timeout ---
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    // --- spawn error (e.g. ENOENT) ---
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (err.code === 'ENOENT') {
        const e = new Error('Claude Code CLI not found on PATH. Is it installed?');
        e.echoCode = 'CLAUDE_NOT_INSTALLED';
        e.hint = 'Install Claude Code from https://claude.ai/code and make sure the `claude` command is on your PATH.';
        return reject(e);
      }

      const e = new Error(`Could not start the \`claude\` process: ${err.message}`);
      e.echoCode = 'INTERNAL';
      return reject(e);
    });

    // --- collect output ---
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    // --- write prompt and close stdin ---
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    // --- handle exit ---
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (_) {
          return reject(
            new Error(
              `claude CLI returned non-JSON output. Snippet: ${stdout.slice(0, 300)}`
            )
          );
        }

        if (parsed.is_error === true || parsed.subtype !== 'success') {
          return reject(
            new Error(parsed.result || parsed.subtype || 'Claude CLI call failed')
          );
        }

        return resolve({
          result: String(parsed.result || '').trim(),
          usage: mapUsage(parsed),
        });
      } else {
        const detail = stderr.slice(0, 500) || '(no stderr output)';
        const lower  = detail.toLowerCase();

        // Detect authentication / login failures from stderr substrings
        if (
          lower.includes('not logged in') ||
          lower.includes('invalid api key') ||
          lower.includes('api key') ||
          lower.includes('please login') ||
          lower.includes('please log in') ||
          lower.includes('authentication required') ||
          lower.includes('unauthorized') ||
          (code === 1 && lower.includes('login'))
        ) {
          const e = new Error('Claude Code is not authenticated. Please log in.');
          e.echoCode = 'CLAUDE_NOT_AUTHED';
          e.hint = 'Run `claude` in a terminal and complete the login flow, then restart the Echo server.';
          return reject(e);
        }

        const e = new Error(`Claude Code exited with an error (code ${code}).`);
        e.echoCode = 'CLAUDE_FAILED';
        e.hint = 'Claude Code hit an error while generating. Check the terminal running the Echo server for the full output.';
        e.detail = detail || `claude CLI exited with code ${code}`;
        return reject(e);
      }
    });
  });
}

/**
 * Routes a prompt through the configured summarization provider (see
 * providers.js). Defaults to the Claude CLI unless opts explicitly select
 * the API provider (opts.apiKey, or ECHO_PROVIDER=api) — see getProvider().
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<{ result: string, usage: object }>}
 */
async function callProvider(prompt, opts = {}) {
  return getProvider(opts).call(prompt, opts);
}

// ---------------------------------------------------------------------------
// Chunking helpers
// ---------------------------------------------------------------------------

/**
 * Cheap O(1) token estimator: ~4 chars per token (GPT/Claude rule of thumb).
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split a segments array into ordered chunks, each whose timecoded text fits
 * within budgetChars. Segment offsets are preserved exactly — they are global
 * seconds-from-start, so timecoded tools stay accurate across chunk boundaries.
 *
 * @param {Array<{ text: string, offset: number }>} segments
 * @param {number} [budgetChars]
 * @returns {Array<Array<{ text: string, offset: number }>>}
 */
export function chunkSegments(segments, budgetChars = CHUNK_CONTENT_CHARS) {
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const seg of segments) {
    // Mirror how a timecoded "[seconds] text" prompt line would be formatted.
    const lineLen = `[${Math.round(seg.offset)}] ${seg.text}\n`.length;
    if (currentChars + lineLen > budgetChars && current.length > 0) {
      chunks.push(current);
      current = [seg];
      currentChars = lineLen;
    } else {
      current.push(seg);
      currentChars += lineLen;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Split plain transcript text into ordered chunks at newline boundaries,
 * each fitting within budgetChars. Used for text-only tools (digest).
 *
 * @param {string} text
 * @param {number} [budgetChars]
 * @returns {string[]}
 */
export function chunkText(text, budgetChars = CHUNK_CONTENT_CHARS) {
  const lines = text.split('\n');
  const chunks = [];
  let current = [];
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

/**
 * Score a text chunk's relevance to a question using simple token-overlap.
 * Returns a number in [0, 1]. Used by the ASK retrieval-lite approach.
 *
 * @param {string} chunkContent
 * @param {string} question
 * @returns {number}
 */
/**
 * Builds an "answer in <language>" instruction. Defaults to English when
 * `language` is absent, blank, or already "english" (case-insensitive) —
 * this preserves existing hardcoded-English behaviour exactly.
 *
 * @param {string|undefined} language
 * @returns {string}
 */
function languageDirective(language) {
  const trimmed = (language || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'english') {
    return 'Answer in English using concise Markdown.';
  }
  return `Answer in ${trimmed} using concise Markdown.`;
}

// ---------------------------------------------------------------------------
// Map-reduce implementations (long-path only)
// ---------------------------------------------------------------------------

// Prompt-input sanitisers: strip newlines + cap length so crafted request-body
// values can't inject extra instructions into prompt strings.
function sanitizeLang(s) {
  const r = String(s).split(/[\r\n]/)[0].trim().slice(0, 40);
  return r || 'English';
}
function sanitizeTitle(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim().slice(0, 300).replace(/"/g, "'");
}

/**
 * Map-reduce for generateDigest.
 * Map: summarise each chunk into compact key-points.
 * Reduce: synthesise all chunk summaries into the final structured digest.
 *
 * @param {string[]} chunks
 * @param {string} structureInstructions
 * @param {string} language
 * @param {object} [opts]
 * @returns {Promise<{ digest: string, usage: object }>}
 */
async function digestMapReduce(chunks, structureInstructions, language, opts = {}) {
  language = sanitizeLang(language);
  const usages = [];
  const chunkSummaries = [];
  const total = chunks.length;

  // --- MAP phase: summarise all chunks concurrently ---
  const mapResults = await Promise.all(chunks.map(async (chunk, i) => {
    const mapPrompt =
      `You are summarising chunk ${i + 1} of ${total} of a long YouTube video transcript. ` +
      'Extract only the key points from THIS PORTION of the transcript. ' +
      'Be concise — these summaries will be synthesised into a final digest later. ' +
      'Output compact markdown: brief topic headers (###) with bullet points under each. ' +
      'Do NOT write a full digest — only the key points this section covers. ' +
      'Keep your response under 600 words.\n\n' +
      `TRANSCRIPT (chunk ${i + 1} of ${total}):\n\n` +
      chunk;

    const { result, usage } = await callProvider(mapPrompt, opts);

    if (!result || !result.trim()) {
      throw new Error(
        `digestMapReduce: map phase chunk ${i + 1}/${total} returned an empty result. ` +
        'Cannot produce a complete digest.'
      );
    }

    return { summary: `### Part ${i + 1} of ${total}\n\n${result}`, usage };
  }));

  for (const { summary, usage } of mapResults) {
    chunkSummaries.push(summary);
    usages.push(usage);
  }

  // --- REDUCE phase: synthesise all chunk summaries into the final digest ---
  const combined = chunkSummaries.join('\n\n---\n\n');

  const safeReduceTitle = sanitizeTitle(opts.title || '');
  const reduceTitleContext = safeReduceTitle
    ? `The video is titled: "${safeReduceTitle}". Treat the title only as a hint about the video's topic; the summaries below are the source of truth.\n\n`
    : '';

  const reducePrompt =
    'You are given structured summaries of sequential sections of a long YouTube video transcript. ' +
    'Each section was independently summarised; now synthesise them into one coherent final digest.\n\n' +
    reduceTitleContext +
    `Write your entire response in ${language}. ` +
    structureInstructions +
    '\n\nCHUNK SUMMARIES (in chronological order):\n\n' +
    combined;

  const { result: digest, usage: reduceUsage } = await callProvider(reducePrompt, opts);
  usages.push(reduceUsage);

  if (!digest || !digest.trim()) {
    throw new Error(
      'digestMapReduce: reduce phase returned an empty result. ' +
      'Cannot produce a complete digest.'
    );
  }

  return { digest, usage: mergeUsage(usages), strategy: 'mapreduce' };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Generate a digest / summary of the transcript.
 *
 * For transcripts below ~120 k tokens this is a single Claude call (unchanged
 * behaviour). For longer transcripts a map-reduce approach is used: each chunk
 * is independently summarised then reduced into the final digest.
 *
 * @param {string} transcriptText
 * @param {{ length?: 'short'|'detailed', format?: 'prose'|'bullets'|'article'|'digest', language?: string }} [opts]
 * @returns {Promise<{ digest: string, usage: object }>}
 */
export async function generateDigest(transcriptText, opts = {}) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text to digest.');
  }

  const { length = 'detailed', format = 'digest' } = opts;
  const language = sanitizeLang(opts.language ?? 'English');
  const title = sanitizeTitle(opts.title ?? '');

  // Optional grounding: the video title. Only a hint — the transcript stays
  // the sole source of truth. Reused by both the fast path and the reduce step.
  const titleContext = title && title.trim()
    ? `The video is titled: "${title.trim()}". Treat the title only as a hint about the video's topic; the transcript below is the sole source of truth for its content.\n\n`
    : '';

  let structureInstructions;

  if (format === 'article') {
    // Article mode ignores `length` — it is always a full-fidelity rewrite of
    // the video (read INSTEAD of watching), never a compressed summary.
    structureInstructions =
      'Rewrite this video transcript into a clean, readable article that a person can read INSTEAD of watching the video. ' +
      'This is NOT a summary — do not compress, shorten, or drop content. Your job is to preserve everything the speaker ' +
      'actually said and make it pleasant to read.\n\n' +
      'Rules:\n' +
      '- Keep ALL substantive points, examples, anecdotes, numbers, names, and details. Nothing important should be lost. ' +
      'The reader should get the full experience of the video, not the gist.\n' +
      '- Remove only the noise of speech: filler words (um, uh, like, you know), false starts, verbatim repetition, ' +
      'off-topic tangents, and channel padding like "smash subscribe" or "link in the description".\n' +
      '- Turn rambling spoken sentences into clear, flowing written prose. Preserve the speaker\'s first-person voice, ' +
      'personality, and point of view — this is their account, not a neutral report.\n' +
      '- Organize the piece with short, descriptive "##" section headings that follow the natural flow of the video, ' +
      'so it is easy to navigate.\n' +
      '- Be faithful: do not invent facts, opinions, or details that are not in the transcript.\n' +
      '- Do not add a preamble, title, meta-commentary, or a concluding "in summary" section. Start directly with the ' +
      'article body.\n' +
      `- Write the article in ${language}.\n` +
      '- Preserve the full richness and depth of the content — this should read like a well-edited long-form essay of ' +
      'comparable depth to the video, NOT a short recap.';
  } else if (format === 'digest') {
    // Digest mode ignores `length` — it is a self-contained, synthesized
    // digest of the video's real substance, not a compressed summary.
    structureInstructions =
      'You are writing a digest of a YouTube video for a smart, busy reader who wants the real value of the video ' +
      'without watching it — and who is trusting you to give them something CLEARER and BETTER ORGANIZED than the ' +
      'creator managed. Most videos bury a few genuinely good ideas inside rambling, repetition, weak structure, and ' +
      'poor delivery. Your job is to extract the real substance and present it better than the speaker did.\n\n' +
      'Before you write, silently identify what KIND of video this is — a how-to/tutorial, an interview or conversation, ' +
      'a talk or lecture, a product review, news or analysis, a personal story/vlog, and so on — and shape the digest to ' +
      'fit it. A tutorial must preserve the actual steps and the how-to detail; an interview must capture the key claims, ' +
      'points of disagreement, and memorable exchanges, and make clear who said what; a talk must carry the central ' +
      'argument and the evidence behind it; a review must land the verdict and the reasons for it.\n\n' +
      'This is NOT a generic summary and NOT a flat list of bullet points. Write it like a sharp, knowledgeable person ' +
      'explaining the video\'s ideas to an intelligent friend who asked "so what was actually good about it?"\n\n' +
      'How to write it:\n' +
      '- Open with a single short paragraph (2-3 sentences) that states the real bottom line — the core claim, the ' +
      'actual answer, or the single most valuable thing the video delivers. Do NOT open with "This video discusses..." ' +
      'or "The creator talks about...". State the point itself, and make it land.\n' +
      '- Then present the substance as clear, flowing prose, organized by IDEA and by IMPORTANCE — not in the order ' +
      'the speaker happened to say things. Group related points together. Lead with what matters most. Use short, ' +
      'descriptive "##" headings only where they genuinely help the reader navigate distinct themes.\n\n' +
      'Rules for quality:\n' +
      '- Synthesize, do not transcribe. Untangle rambling into a clear line of reasoning. If the speaker made a good ' +
      'point badly, make it well.\n' +
      '- KEEP every concrete specific the transcript contains — the exact names, companies, places, titles, numbers, ' +
      'prices, dates, and vivid examples. These are what make a digest substantive instead of vague. Carry each ' +
      'specific through exactly, and NEVER downgrade a named thing into a generic one. Never flatten "a kebab went ' +
      'from 3.5 to 9 euros" into "prices have risen"; if the speaker said "Diablo II," do not write "an RPG"; if they ' +
      'said "Yale," do not write "a US university." If the transcript or the title names the speaker, a guest, or a ' +
      'person, use that name — do not reduce them to "the speaker," "the creator," or "the guest."\n' +
      '- But NEVER manufacture a specific the transcript does not contain, and never complete or upgrade a vague ' +
      'reference using your own outside knowledge. If the transcript says "an economist," keep "an economist" — do not ' +
      'turn it into "The Economist"; if it says "Felix," do not add a surname; if it names an institution but not the ' +
      'person, do not supply the person\'s name; if it says "about 5 percent," do not write "5.03 percent"; do not name ' +
      'any author, study, book, documentary, or source that the transcript itself does not name. When you are unsure ' +
      'whether a detail was actually stated, describe it generally — a faithful general description always beats a ' +
      'confident invented specific. And never "correct" the transcript against your own knowledge: if a name, date, ' +
      'or number in the transcript looks garbled, misspelled, or even factually wrong, keep it as stated or describe ' +
      'it generally — do not replace it with an outside fact (for example, do not swap a stated birth year for the ' +
      'one you believe is correct).\n' +
      '- If two or more people speak — an interview, a panel, a conversation — keep them distinct. Attribute claims ' +
      'and memorable lines to the right person, make clear who said what, and capture where they agree, disagree, or ' +
      'build on each other. Never collapse a multi-voice conversation into a single voice.\n' +
      '- Be strictly faithful. Never invent facts, opinions, examples, or conclusions that are not in the transcript. ' +
      'Improving the delivery must NEVER mean changing or adding to the substance.\n' +
      '- Preserve the speaker\'s actual stance and nuance. If their real answer was "it depends" or they were ' +
      'uncertain, keep that honesty — do not flatten it into false confidence.\n' +
      '- Cut ruthlessly: filler, throat-clearing, self-promotion, sponsor reads, repetition, and anything that does ' +
      'not earn its place.\n' +
      '- Write plainly. Avoid filler intensifiers ("genuinely," "truly," "really," "actually") and corporate/AI ' +
      'jargon ("robust," "leverage," "actionable," "vibrant," "delve," "landscape," "tapestry"). Prefer plain verbs ' +
      'and concrete nouns over inflated phrasing.\n' +
      '- Be as long as the substance genuinely requires and no longer — dense with value, never padded to seem ' +
      'thorough. A great short digest beats a bloated one.\n' +
      '- Do not add a preamble, a title, meta-commentary, or an "in conclusion" wrap-up. Output only the digest ' +
      'itself — never a note about the transcript, the task, or your own process. Start with the bottom line ' +
      'and stop when the substance is done.\n' +
      `- Write the entire digest in ${language}.\n\n` +
      'The bar for your output: the reader should finish it and feel they got MORE out of it than they would have ' +
      'from watching — clearer, faster, sharper, and better organized than the original creator managed.';
  } else if (length === 'short') {
    if (format === 'prose') {
      structureInstructions =
        'Produce a short TL;DR: 2-3 sentences summarising the video, followed by a brief prose paragraph ' +
        'highlighting the key points. Keep the total response under 200 words.';
    } else {
      // bullets (default)
      structureInstructions =
        'Produce a short TL;DR: 2-3 sentences summarising the video, then a tight bulleted list ' +
        'of the most important takeaways (5 bullets maximum). Keep the total response under 200 words.';
    }
  } else {
    // detailed (default)
    if (format === 'prose') {
      structureInstructions =
        'Produce a clear, well-structured digest using Markdown with exactly these sections:\n\n' +
        '## TL;DR\n' +
        'A 2-3 sentence overview.\n\n' +
        '## Key Points\n' +
        'A concise prose paragraph summarising the most important takeaways.\n\n' +
        '## Detailed Summary\n' +
        'The content reorganized by topic, with short "###" subheadings and readable paragraphs. ' +
        'Be faithful to the transcript; do not invent facts that are not present. ' +
        'Do not include any preamble before the "## TL;DR" heading.';
    } else {
      // bullets (default)
      structureInstructions =
        'Produce a clear, well-structured digest using Markdown with exactly these sections:\n\n' +
        '## TL;DR\n' +
        'A 2-3 sentence overview.\n\n' +
        '## Key Points\n' +
        'A bulleted list of the most important takeaways.\n\n' +
        '## Detailed Summary\n' +
        'The content reorganized by topic, with short "###" subheadings and readable paragraphs. ' +
        'Be faithful to the transcript; do not invent facts that are not present. ' +
        'Do not include any preamble before the "## TL;DR" heading.';
    }
  }

  // --- Long-path guard ---
  if (transcriptText.length > LONG_PATH_THRESHOLD_CHARS) {
    const chunks = chunkText(transcriptText);
    // Single chunk means budget math already handles it — fall through to fast path.
    if (chunks.length > 1) {
      return digestMapReduce(chunks, structureInstructions, language, opts);
    }
  }

  // --- Fast path ---
  // Article and digest modes use their own self-contained instructions
  // (already include the language directive) instead of the generic
  // summary-oriented prefix below.
  const prompt =
    format === 'article' || format === 'digest'
      ? `Write your entire response in ${language}, regardless of what language the transcript is in.\n\n${titleContext}${structureInstructions}\n\nHere is the transcript:\n\n${transcriptText}`
      : 'You are given the raw auto-generated transcript of a YouTube video. ' +
        'It may be in any language. ' +
        `Write your entire response in ${language}. ` +
        titleContext +
        structureInstructions +
        '\n\nHere is the transcript:\n\n' +
        transcriptText;

  const { result, usage } = await callProvider(prompt, opts);
  return { digest: result, usage, strategy: 'single' };
}

/**
 * Enrich a user's highlighted selection from a transcript with an
 * explanation or background context.
 *
 * Both modes are pure model calls over the transcript context + the model's
 * general knowledge — no web search, no citations. 'sources' is always
 * returned empty; it is kept in the return shape for caller compatibility.
 *
 * @param {string} selection - the exact highlighted text
 * @param {{ context?: string, mode?: 'explain'|'background', language?: string }} [opts]
 *   Any additional providerOpts (e.g. apiKey) are forwarded to callProvider unchanged.
 * @returns {Promise<{ mode: string, text: string, sources: Array<{title:string,url:string}>, usage: object }>}
 */
export async function enrich(selection, opts = {}) {
  if (!selection || !selection.trim()) {
    throw new Error('No selection text provided.');
  }

  const { context = '', mode = 'explain', language = 'English', ...providerOpts } = opts;
  const trimmedSelection = selection.trim();
  const trimmedContext = (context || '').trim();
  const contextBlock = trimmedContext
    ? `TRANSCRIPT CONTEXT (surrounding the selection):\n\n${trimmedContext}\n\n`
    : '';

  if (mode === 'explain') {
    const prompt =
      'A user is reading a YouTube video transcript and highlighted a piece of text. ' +
      'Briefly explain or define the highlighted text so they understand it in context. ' +
      'Use the surrounding transcript context (if provided) plus your general knowledge. ' +
      'Keep the explanation to 1-3 sentences — no preamble, no headings, just the explanation. ' +
      languageDirective(language) + '\n\n' +
      contextBlock +
      `HIGHLIGHTED TEXT: "${trimmedSelection}"`;

    const { result, usage } = await callProvider(prompt, providerOpts);
    return { mode: 'explain', text: result.trim(), sources: [], usage, results: null };
  }

  if (mode === 'background') {
    const prompt =
      'A user is reading a YouTube video transcript and highlighted a piece of text they want more ' +
      'background/context on. Use the surrounding transcript context (if provided) plus your general ' +
      'knowledge. If you are not confident in a fact, say so plainly instead of guessing. ' +
      languageDirective(language) + '\n\n' +
      contextBlock +
      `HIGHLIGHTED TEXT: "${trimmedSelection}"\n\n` +
      'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
      '{"text":"2-4 sentence background/context"}';

    const { result, usage } = await callProvider(prompt, providerOpts);

    let parsed;
    try {
      parsed = parseJsonLoose(result);
    } catch (err) {
      throw new Error(`enrich: background mode returned invalid JSON. ${err.message}`);
    }

    const text = typeof parsed?.text === 'string' ? parsed.text : '';

    return { mode: 'background', text, sources: [], usage, results: null };
  }

  throw new Error(`enrich: unknown mode "${mode}". Expected 'explain' or 'background'.`);
}

// Maximum chars of material (digest or transcript excerpt) to feed the
// suggestTags prompt. Keeps this a cheap, fast call even for long transcripts.
const MAX_TAG_MATERIAL_CHARS = 6000;

// Cap on the length of any single normalized tag string.
const MAX_TAG_CHARS = 40;

/**
 * Suggest 3-5 short topical tags for a video's digest or transcript excerpt.
 *
 * @param {string} material - a digest or transcript excerpt to read.
 * @param {{ apiKey?: string, language?: string }} [opts]
 * @returns {Promise<{ tags: string[], usage: object }>}
 */
export async function suggestTags(material, opts = {}) {
  if (!material || !material.trim()) {
    throw new Error('No material provided.');
  }

  const { language } = opts;
  const trimmed = material.trim();
  const truncated = trimmed.length > MAX_TAG_MATERIAL_CHARS;
  const excerpt =
    trimmed.slice(0, MAX_TAG_MATERIAL_CHARS) +
    (truncated ? ' … [excerpt truncated]' : '');

  // Not languageDirective(): that asks for Markdown prose, which contradicts the
  // STRICT JSON instruction below and gets dropped — leaving tags in the
  // material's own language. Tags need translating, not answering.
  const tagLanguage = (language || '').trim() || 'English';

  const prompt =
    'Read the following video digest or transcript excerpt and suggest 3-5 short topical tags ' +
    '(single words or short phrases) that a reader could use to categorise or search for this video. ' +
    `Write every tag in ${tagLanguage}. The material may be in a different language; ` +
    `translate the concepts into ${tagLanguage} rather than copying the material's wording. ` +
    `Proper nouns keep their usual ${tagLanguage} form (for example a country name is written as ${tagLanguage} spells it).\n\n` +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"tags": ["tag1", "tag2", "tag3"]}\n\n' +
    'MATERIAL:\n\n' +
    excerpt;

  const { result, usage } = await callProvider(prompt, opts);

  let parsed;
  try {
    parsed = parseJsonLoose(result);
  } catch (_) {
    return { tags: [], usage: mergeUsage([usage]) };
  }

  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const seen = new Set();
  const tags = [];
  for (const t of rawTags) {
    if (tags.length >= 5) break;
    const s = String(t ?? '').trim().toLowerCase();
    if (!s || s.length > MAX_TAG_CHARS) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    tags.push(s);
  }

  return { tags, usage: mergeUsage([usage]) };
}

