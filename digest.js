import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const CLAUDE_ARGS = ['-p', '--model', 'sonnet', '--output-format', 'json'];

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
function buildSpawnTarget() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { exe: comspec, args: ['/c', 'claude', ...CLAUDE_ARGS] };
  }
  return { exe: 'claude', args: CLAUDE_ARGS };
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
function mergeUsage(usages) {
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
function parseJsonLoose(str) {
  // Strip ```json ... ``` or ``` ... ``` fences
  let s = str.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');

  // Find the outermost { ... }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in Claude output. Snippet: ${str.slice(0, 300)}`);
  }
  return JSON.parse(s.slice(start, end + 1));
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
async function runClaude(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { exe, args } = buildSpawnTarget();

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn(exe, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    // --- timeout ---
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
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

        const e = new Error(`claude CLI exited with code ${code}. ${detail}`);
        e.echoCode = 'CLAUDE_FAILED';
        e.hint = 'Check the terminal running the Echo server for details.';
        return reject(e);
      }
    });
  });
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
    // Mirror how the prompt formats each line (see extractChapters / extractQuotes).
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
 * each fitting within budgetChars. Used for text-only tools (digest,
 * factcheck, ask).
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
function scoreChunkRelevance(chunkContent, question) {
  const words = (s) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3)
    );

  const qWords = words(question);
  // No meaningful question words — keep all chunks equally.
  if (qWords.size === 0) return 1;

  const cWords = words(chunkContent);
  let hits = 0;
  for (const w of qWords) {
    if (cWords.has(w)) hits++;
  }
  return hits / qWords.size;
}

// ---------------------------------------------------------------------------
// Map-reduce implementations (long-path only)
// ---------------------------------------------------------------------------

/**
 * Map-reduce for generateDigest.
 * Map: summarise each chunk into compact key-points.
 * Reduce: synthesise all chunk summaries into the final structured digest.
 *
 * @param {string[]} chunks
 * @param {string} structureInstructions
 * @param {string} language
 * @returns {Promise<{ digest: string, usage: object }>}
 */
async function digestMapReduce(chunks, structureInstructions, language) {
  const usages = [];
  const chunkSummaries = [];
  const total = chunks.length;

  // --- MAP phase: summarise each chunk independently ---
  for (let i = 0; i < total; i++) {
    const mapPrompt =
      `You are summarising chunk ${i + 1} of ${total} of a long YouTube video transcript. ` +
      'Extract only the key points from THIS PORTION of the transcript. ' +
      'Be concise — these summaries will be synthesised into a final digest later. ' +
      'Output compact markdown: brief topic headers (###) with bullet points under each. ' +
      'Do NOT write a full digest — only the key points this section covers. ' +
      'Keep your response under 600 words.\n\n' +
      `TRANSCRIPT (chunk ${i + 1} of ${total}):\n\n` +
      chunks[i];

    const { result, usage } = await runClaude(mapPrompt);
    usages.push(usage);

    if (!result || !result.trim()) {
      throw new Error(
        `digestMapReduce: map phase chunk ${i + 1}/${total} returned an empty result. ` +
        'Cannot produce a complete digest.'
      );
    }

    chunkSummaries.push(`### Part ${i + 1} of ${total}\n\n${result}`);
  }

  // --- REDUCE phase: synthesise all chunk summaries into the final digest ---
  const combined = chunkSummaries.join('\n\n---\n\n');

  const reducePrompt =
    'You are given structured summaries of sequential sections of a long YouTube video transcript. ' +
    'Each section was independently summarised; now synthesise them into one coherent final digest.\n\n' +
    `Write your entire response in ${language}. ` +
    structureInstructions +
    '\n\nCHUNK SUMMARIES (in chronological order):\n\n' +
    combined;

  const { result: digest, usage: reduceUsage } = await runClaude(reducePrompt);
  usages.push(reduceUsage);

  if (!digest || !digest.trim()) {
    throw new Error(
      'digestMapReduce: reduce phase returned an empty result. ' +
      'Cannot produce a complete digest.'
    );
  }

  return { digest, usage: mergeUsage(usages) };
}

/**
 * Map-reduce for extractChapters.
 * Map: extract candidate chapter boundaries per chunk (using real global offsets).
 * Reduce: done in code — merge all candidates, sort by startSec, deduplicate
 *         chapters that start within 60 s of each other, then trim to 4–12.
 *
 * @param {Array<Array<{ text: string, offset: number }>>} segmentChunks
 * @returns {Promise<{ chapters: Array<{ title: string, startSec: number }>, usage: object }>}
 */
async function chaptersMapReduce(segmentChunks) {
  const usages = [];
  const allCandidates = [];
  const total = segmentChunks.length;

  // --- MAP phase ---
  for (let i = 0; i < total; i++) {
    const timecoded = segmentChunks[i]
      .map((s) => `[${Math.round(s.offset)}] ${s.text}`)
      .join('\n');

    const mapPrompt =
      `You are given portion ${i + 1} of ${total} of a timecoded transcript ` +
      'in the format "[seconds] text". ' +
      'Identify the natural topic transitions in THIS PORTION ONLY (1 to 5 transitions). ' +
      'The startSec values MUST be taken directly from the segment offsets shown — do not guess.\n\n' +
      'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
      '{"chapters":[{"title":"...","startSec":123}, ...]}\n\n' +
      `TIMECODED TRANSCRIPT (portion ${i + 1} of ${total}):\n\n` +
      timecoded;

    const { result, usage } = await runClaude(mapPrompt);
    usages.push(usage);

    let parsed;
    try {
      parsed = parseJsonLoose(result);
    } catch (err) {
      throw new Error(
        `chaptersMapReduce: map chunk ${i + 1}/${total} returned invalid JSON. ${err.message}`
      );
    }

    if (!parsed || !Array.isArray(parsed.chapters)) {
      throw new Error(
        `chaptersMapReduce: map chunk ${i + 1}/${total} is missing the "chapters" array.`
      );
    }

    for (const c of parsed.chapters) {
      if (typeof c.title === 'string' && typeof c.startSec === 'number') {
        allCandidates.push({ title: c.title, startSec: c.startSec });
      }
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      'chaptersMapReduce: map phase produced zero chapter candidates across all chunks.'
    );
  }

  // --- REDUCE phase (code) ---
  // Sort by startSec, then deduplicate chapters that start within 60 s of each
  // other (keep the first one encountered), then trim to at most 12.
  allCandidates.sort((a, b) => a.startSec - b.startSec);

  const deduped = [];
  for (const c of allCandidates) {
    const last = deduped[deduped.length - 1];
    if (!last || c.startSec - last.startSec > 60) {
      deduped.push(c);
    }
  }

  const chapters = deduped.slice(0, 12);
  return { chapters, usage: mergeUsage(usages) };
}

/**
 * Map-reduce for extractQuotes.
 * Map: extract candidate notable quotes per chunk (using real global offsets).
 * Reduce: Claude call to select the top 5–10 across all candidates.
 *
 * @param {Array<Array<{ text: string, offset: number }>>} segmentChunks
 * @returns {Promise<{ quotes: Array<{ text: string, startSec: number }>, usage: object }>}
 */
async function quotesMapReduce(segmentChunks) {
  const usages = [];
  const allCandidates = [];
  const total = segmentChunks.length;

  // --- MAP phase ---
  for (let i = 0; i < total; i++) {
    const timecoded = segmentChunks[i]
      .map((s) => `[${Math.round(s.offset)}] ${s.text}`)
      .join('\n');

    const mapPrompt =
      `You are given portion ${i + 1} of ${total} of a timecoded transcript ` +
      'in the format "[seconds] text". ' +
      'Select 1 to 5 of the most notable or quotable lines from THIS PORTION ONLY. ' +
      'The startSec values MUST be taken directly from the segment offsets shown.\n\n' +
      'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
      '{"quotes":[{"text":"...","startSec":123}, ...]}\n\n' +
      `TIMECODED TRANSCRIPT (portion ${i + 1} of ${total}):\n\n` +
      timecoded;

    const { result, usage } = await runClaude(mapPrompt);
    usages.push(usage);

    let parsed;
    try {
      parsed = parseJsonLoose(result);
    } catch (err) {
      throw new Error(
        `quotesMapReduce: map chunk ${i + 1}/${total} returned invalid JSON. ${err.message}`
      );
    }

    if (!parsed || !Array.isArray(parsed.quotes)) {
      throw new Error(
        `quotesMapReduce: map chunk ${i + 1}/${total} is missing the "quotes" array.`
      );
    }

    for (const q of parsed.quotes) {
      if (typeof q.text === 'string' && typeof q.startSec === 'number') {
        allCandidates.push({ text: q.text, startSec: q.startSec });
      }
    }
  }

  if (allCandidates.length === 0) {
    throw new Error(
      'quotesMapReduce: map phase produced zero quote candidates across all chunks.'
    );
  }

  // --- REDUCE phase: Claude selects the top 5–10 from all candidates ---
  const candidateJson = JSON.stringify({ quotes: allCandidates }, null, 2);

  const reducePrompt =
    'You are given a list of candidate notable quotes extracted from different portions ' +
    'of a YouTube video transcript. Each quote has a "text" and "startSec" (seconds from start).\n\n' +
    'Select the 5 to 10 most notable, insightful, or representative quotes across the whole video. ' +
    'Preserve the exact "text" and "startSec" values — do not modify them.\n\n' +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"quotes":[{"text":"...","startSec":123}, ...]}\n\n' +
    'CANDIDATE QUOTES:\n\n' +
    candidateJson;

  const { result: reduceResult, usage: reduceUsage } = await runClaude(reducePrompt);
  usages.push(reduceUsage);

  let parsed;
  try {
    parsed = parseJsonLoose(reduceResult);
  } catch (err) {
    throw new Error(
      `quotesMapReduce: reduce phase returned invalid JSON. ${err.message}`
    );
  }

  if (!parsed || !Array.isArray(parsed.quotes)) {
    throw new Error('quotesMapReduce: reduce phase is missing the "quotes" array.');
  }

  const quotes = parsed.quotes.map((q, i) => {
    if (typeof q.text !== 'string' || typeof q.startSec !== 'number') {
      throw new Error(
        `quotesMapReduce: reduced quote[${i}] has invalid shape.`
      );
    }
    return { text: q.text, startSec: q.startSec };
  });

  return { quotes, usage: mergeUsage(usages) };
}

/**
 * Map-reduce for factCheck.
 * Map: extract claims per chunk.
 * Reduce: Claude call to merge and deduplicate claims across all chunks.
 *
 * @param {string[]} textChunks
 * @returns {Promise<{ claims: Array<{ claim: string, assessment: string, confidence: string, explanation: string }>, usage: object }>}
 */
async function factCheckMapReduce(textChunks) {
  const usages = [];
  const allClaims = [];
  const total = textChunks.length;

  const validAssessments = new Set(['supported', 'disputed', 'unverifiable']);
  const validConfidences = new Set(['low', 'medium', 'high']);

  // --- MAP phase ---
  for (let i = 0; i < total; i++) {
    const mapPrompt =
      'You are given a portion of a YouTube video transcript. ' +
      'Extract the main factual or checkable claims from THIS PORTION ONLY ' +
      'and assess each one based ONLY on your training knowledge. ' +
      'You do NOT have access to the internet or live data.\n\n' +
      'For each claim provide:\n' +
      '  - "claim": a short summary of the factual assertion\n' +
      '  - "assessment": one of "supported", "disputed", or "unverifiable"\n' +
      '  - "confidence": one of "low", "medium", or "high"\n' +
      '  - "explanation": a concise explanation, noting this is training knowledge only\n\n' +
      'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
      '{"claims":[{"claim":"...","assessment":"supported|disputed|unverifiable","confidence":"low|medium|high","explanation":"..."}, ...]}\n\n' +
      `TRANSCRIPT (portion ${i + 1} of ${total}):\n\n` +
      textChunks[i];

    const { result, usage } = await runClaude(mapPrompt);
    usages.push(usage);

    let parsed;
    try {
      parsed = parseJsonLoose(result);
    } catch (err) {
      throw new Error(
        `factCheckMapReduce: map chunk ${i + 1}/${total} returned invalid JSON. ${err.message}`
      );
    }

    if (!parsed || !Array.isArray(parsed.claims)) {
      throw new Error(
        `factCheckMapReduce: map chunk ${i + 1}/${total} is missing the "claims" array.`
      );
    }

    for (const c of parsed.claims) {
      if (
        typeof c.claim === 'string' &&
        validAssessments.has(c.assessment) &&
        validConfidences.has(c.confidence) &&
        typeof c.explanation === 'string'
      ) {
        allClaims.push({
          claim: c.claim,
          assessment: c.assessment,
          confidence: c.confidence,
          explanation: c.explanation,
        });
      }
    }
  }

  if (allClaims.length === 0) {
    throw new Error(
      'factCheckMapReduce: map phase produced zero claims across all chunks. ' +
      'The transcript may not contain checkable factual claims.'
    );
  }

  // --- REDUCE phase: Claude deduplicates and consolidates claims ---
  const candidateJson = JSON.stringify({ claims: allClaims }, null, 2);

  const reducePrompt =
    'You are given a set of factual claims extracted from different portions of a YouTube transcript. ' +
    'Some claims may be duplicated or closely related across portions. ' +
    'Merge any duplicate or near-duplicate claims, keeping the best-quality entry. ' +
    'Preserve the exact assessment/confidence/explanation format.\n\n' +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"claims":[{"claim":"...","assessment":"supported|disputed|unverifiable","confidence":"low|medium|high","explanation":"..."}, ...]}\n\n' +
    'CANDIDATE CLAIMS:\n\n' +
    candidateJson;

  const { result: reduceResult, usage: reduceUsage } = await runClaude(reducePrompt);
  usages.push(reduceUsage);

  let parsed;
  try {
    parsed = parseJsonLoose(reduceResult);
  } catch (err) {
    throw new Error(
      `factCheckMapReduce: reduce phase returned invalid JSON. ${err.message}`
    );
  }

  if (!parsed || !Array.isArray(parsed.claims)) {
    throw new Error('factCheckMapReduce: reduce phase is missing the "claims" array.');
  }

  const claims = parsed.claims.map((c, i) => {
    if (
      typeof c.claim !== 'string' ||
      !validAssessments.has(c.assessment) ||
      !validConfidences.has(c.confidence) ||
      typeof c.explanation !== 'string'
    ) {
      throw new Error(
        `factCheckMapReduce: reduced claim[${i}] has invalid shape or out-of-range enum values.`
      );
    }
    return {
      claim: c.claim,
      assessment: c.assessment,
      confidence: c.confidence,
      explanation: c.explanation,
    };
  });

  return { claims, usage: mergeUsage(usages) };
}

/**
 * Retrieval-lite for askVideoQuestion.
 * Score each chunk by keyword overlap, select chunks that fit within budget,
 * then run a single Claude call on the combined selected text.
 *
 * @param {string[]} textChunks
 * @param {string} question
 * @returns {Promise<{ answer: string, usage: object }>}
 */
async function askRetrievalLite(textChunks, question) {
  // Score each chunk and sort descending by relevance.
  const scored = textChunks.map((chunk, idx) => ({
    idx,
    chunk,
    score: scoreChunkRelevance(chunk, question),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Greedily accumulate chunks up to the content budget.
  const selected = [];
  let totalChars = 0;
  for (const item of scored) {
    if (totalChars + item.chunk.length > CHUNK_CONTENT_CHARS) break;
    selected.push(item);
    totalChars += item.chunk.length;
  }

  if (selected.length === 0) {
    // Even a single chunk exceeds the budget — take just the top-scored one
    // truncated. This is a last resort for pathologically large single lines.
    selected.push(scored[0]);
  }

  // Restore chronological order so Claude sees a coherent sequence.
  selected.sort((a, b) => a.idx - b.idx);

  const isPartial = selected.length < textChunks.length;
  const partialNote = isPartial
    ? `\n\n(NOTE: This transcript is very long. You are seeing ${selected.length} of ${textChunks.length} ` +
      'sections, selected by relevance to the question. Answer ONLY from what is shown below — ' +
      'do NOT infer or invent content from parts of the transcript you cannot see.)'
    : '';

  const combinedText = selected.map((s) => s.chunk).join('\n\n---\n\n');

  const prompt =
    'You are given the transcript of a YouTube video (or a relevant portion of it) ' +
    'and a user question. ' +
    'Answer the question using ONLY the information present in the transcript text below. ' +
    'If the transcript does not contain enough information to answer the question, say so plainly — ' +
    'do NOT invent or infer facts that are not in the transcript. ' +
    'Answer in English using concise Markdown.' +
    partialNote +
    `\n\nQUESTION: ${question.trim()}\n\n` +
    'TRANSCRIPT:\n\n' +
    combinedText;

  const { result: answer, usage } = await runClaude(prompt);
  return { answer, usage };
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
 * @param {{ length?: 'short'|'detailed', format?: 'prose'|'bullets', language?: string }} [opts]
 * @returns {Promise<{ digest: string, usage: object }>}
 */
export async function generateDigest(transcriptText, opts = {}) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text to digest.');
  }

  const {
    length = 'detailed',
    format = 'bullets',
    language = 'English',
  } = opts;

  let structureInstructions;

  if (length === 'short') {
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
      return digestMapReduce(chunks, structureInstructions, language);
    }
  }

  // --- Fast path (unchanged) ---
  const prompt =
    'You are given the raw auto-generated transcript of a YouTube video. ' +
    'It may be in any language. ' +
    `Write your entire response in ${language}. ` +
    structureInstructions +
    '\n\nHere is the transcript:\n\n' +
    transcriptText;

  const { result, usage } = await runClaude(prompt);
  return { digest: result, usage };
}

/**
 * Answer a user question using the transcript as the sole ground truth.
 *
 * For long transcripts a retrieval-lite approach is used: chunks are scored by
 * keyword overlap with the question and the most relevant subset (fitting the
 * context budget) is passed to Claude. The "answer only from transcript"
 * guarantee is preserved — Claude is instructed not to invent content from
 * portions it cannot see.
 *
 * @param {string} transcriptText
 * @param {string} question
 * @returns {Promise<{ answer: string, usage: object }>}
 */
export async function askVideoQuestion(transcriptText, question) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text provided.');
  }
  if (!question || !question.trim()) {
    throw new Error('No question provided.');
  }

  // --- Long-path guard ---
  if (transcriptText.length > LONG_PATH_THRESHOLD_CHARS) {
    const chunks = chunkText(transcriptText);
    if (chunks.length > 1) {
      return askRetrievalLite(chunks, question);
    }
  }

  // --- Fast path (unchanged) ---
  const prompt =
    'You are given the raw transcript of a YouTube video and a user question. ' +
    'Answer the question using ONLY the information present in the transcript. ' +
    'If the transcript does not contain enough information to answer the question, say so plainly — ' +
    'do NOT invent or infer facts that are not in the transcript. ' +
    'Answer in English using concise Markdown.\n\n' +
    `QUESTION: ${question.trim()}\n\n` +
    'TRANSCRIPT:\n\n' +
    transcriptText;

  const { result, usage } = await runClaude(prompt);
  return { answer: result, usage };
}

/**
 * Divide a timecoded transcript into 4–12 chapters.
 *
 * For long transcripts a map-reduce approach is used: candidate chapters are
 * extracted per chunk (using real global offsets), then merged, deduplicated,
 * and trimmed in code.
 *
 * @param {Array<{ text: string, offset: number }>} segments  offset in seconds
 * @returns {Promise<{ chapters: Array<{ title: string, startSec: number }>, usage: object }>}
 */
export async function extractChapters(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('segments must be a non-empty array of { text, offset }.');
  }

  // Build compact timecoded transcript to measure size.
  const timecoded = segments
    .map((s) => `[${Math.round(s.offset)}] ${s.text}`)
    .join('\n');

  // --- Long-path guard ---
  if (timecoded.length > LONG_PATH_THRESHOLD_CHARS) {
    const segChunks = chunkSegments(segments);
    if (segChunks.length > 1) {
      return chaptersMapReduce(segChunks);
    }
  }

  // --- Fast path (unchanged) ---
  const prompt =
    'You are given a timecoded transcript of a YouTube video in the format "[seconds] text". ' +
    'Divide the video into 4 to 12 sequential chapters. For each chapter provide:\n' +
    '  - a short descriptive title (under 60 characters)\n' +
    '  - the start time in seconds taken from the nearest segment offset in the transcript\n\n' +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"chapters":[{"title":"...","startSec":123}, ...]}\n\n' +
    'TIMECODED TRANSCRIPT:\n\n' +
    timecoded;

  const { result, usage } = await runClaude(prompt);

  let parsed;
  try {
    parsed = parseJsonLoose(result);
  } catch (err) {
    throw new Error(`extractChapters: failed to parse Claude response as JSON. ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.chapters)) {
    throw new Error('extractChapters: Claude response missing "chapters" array.');
  }

  const chapters = parsed.chapters.map((c, i) => {
    if (typeof c.title !== 'string' || typeof c.startSec !== 'number') {
      throw new Error(
        `extractChapters: chapter[${i}] has invalid shape (expected {title:string, startSec:number}).`
      );
    }
    return { title: c.title, startSec: c.startSec };
  });

  return { chapters, usage };
}

/**
 * Extract the 5–10 most notable quotable lines with approximate timecodes.
 *
 * For long transcripts a map-reduce approach is used: candidate quotes are
 * extracted per chunk, then a Claude reduce call selects the top 5–10 across
 * the whole video.
 *
 * @param {Array<{ text: string, offset: number }>} segments  offset in seconds
 * @returns {Promise<{ quotes: Array<{ text: string, startSec: number }>, usage: object }>}
 */
export async function extractQuotes(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('segments must be a non-empty array of { text, offset }.');
  }

  const timecoded = segments
    .map((s) => `[${Math.round(s.offset)}] ${s.text}`)
    .join('\n');

  // --- Long-path guard ---
  if (timecoded.length > LONG_PATH_THRESHOLD_CHARS) {
    const segChunks = chunkSegments(segments);
    if (segChunks.length > 1) {
      return quotesMapReduce(segChunks);
    }
  }

  // --- Fast path (unchanged) ---
  const prompt =
    'You are given a timecoded transcript of a YouTube video in the format "[seconds] text". ' +
    'Select the 5 to 10 most notable or quotable lines from the transcript. ' +
    'For each quote, include the approximate timecode in seconds taken from the nearest segment offset.\n\n' +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"quotes":[{"text":"...","startSec":123}, ...]}\n\n' +
    'TIMECODED TRANSCRIPT:\n\n' +
    timecoded;

  const { result, usage } = await runClaude(prompt);

  let parsed;
  try {
    parsed = parseJsonLoose(result);
  } catch (err) {
    throw new Error(`extractQuotes: failed to parse Claude response as JSON. ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.quotes)) {
    throw new Error('extractQuotes: Claude response missing "quotes" array.');
  }

  const quotes = parsed.quotes.map((q, i) => {
    if (typeof q.text !== 'string' || typeof q.startSec !== 'number') {
      throw new Error(
        `extractQuotes: quote[${i}] has invalid shape (expected {text:string, startSec:number}).`
      );
    }
    return { text: q.text, startSec: q.startSec };
  });

  return { quotes, usage };
}

/**
 * Fact-check the main claims in the transcript using the model's own knowledge.
 *
 * IMPORTANT: The Claude CLI has NO live web access. Verdicts are based solely on
 * the model's training knowledge and must be treated accordingly.
 *
 * For long transcripts a map-reduce approach is used: claims are extracted per
 * chunk, then a Claude reduce call deduplicates and consolidates them.
 *
 * @param {string} transcriptText
 * @returns {Promise<{ claims: Array<{ claim: string, assessment: string, confidence: string, explanation: string }>, caveat: string, usage: object }>}
 */
/**
 * Generate a single comparative synthesis across multiple saved video entries.
 *
 * Source material preference (controls Claude call cost):
 *   1. Entry's saved digest, if present — reuses existing work with no extra Claude call.
 *   2. Compact raw-transcript excerpt (~3000 chars) for entries without a saved digest.
 *
 * A single Claude call produces the final markdown output with four sections:
 * Overview / Common Themes / Key Differences–Contradictions / Per-Video Notes.
 *
 * @param {Array<{ videoId: string, title?: string, digest?: string|null, segments?: Array<{text:string}> }>} entries
 *   Full entry objects as returned by store.getEntry().
 * @param {{ language?: string }} [options]
 * @returns {Promise<{ digest: string, usage: object }>}
 */
export async function generateCrossDigest(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error('generateCrossDigest requires at least 2 entries.');
  }

  const { language = 'English' } = options;

  // Maximum chars to include from a raw transcript when no digest exists.
  // Keeps the prompt size manageable without an extra round-trip Claude call.
  const MAX_EXCERPT_CHARS = 3000;

  const videoSections = entries.map((entry) => {
    const title = entry.title || entry.videoId;
    let material;

    if (entry.digest && entry.digest.trim()) {
      // Preferred path: reuse the already-generated per-video digest.
      material = entry.digest.trim();
    } else {
      // Fallback: compact raw-transcript excerpt (no extra Claude call needed).
      const transcriptText = Array.isArray(entry.segments)
        ? entry.segments
            .map((s) => (s.text || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' ')
        : '';

      if (!transcriptText) {
        material = '(No transcript or digest available for this video.)';
      } else {
        const truncated = transcriptText.length > MAX_EXCERPT_CHARS;
        material =
          transcriptText.slice(0, MAX_EXCERPT_CHARS) +
          (truncated ? ' … [transcript excerpt only — full digest not available]' : '');
      }
    }

    return `### ${title}\n\n${material}`;
  });

  const combined = videoSections.join('\n\n---\n\n');

  const prompt =
    `You are given summaries or excerpts from ${entries.length} YouTube videos. ` +
    'Synthesise them into a single comparative cross-video analysis. ' +
    `Write your entire response in ${language}. ` +
    'Use EXACTLY these Markdown sections in this order — no preamble before the first heading:\n\n' +
    '## Overview\n' +
    `A 2–4 sentence introduction covering what all ${entries.length} videos broadly address.\n\n` +
    '## Common Themes\n' +
    'Topics, ideas, or conclusions that appear across multiple videos. Use sub-bullets per theme.\n\n' +
    '## Key Differences / Contradictions\n' +
    'Points where the videos disagree, take different angles, or emphasise different things. ' +
    'If they are strongly aligned, note differences in depth, framing, or scope.\n\n' +
    '## Per-Video Notes\n' +
    'A bulleted list — one bullet per video, introduced with the video title in bold — ' +
    'highlighting its unique angle or contribution relative to the other videos.\n\n' +
    'Be faithful to the material provided; do not invent facts not present in the summaries.\n\n' +
    'VIDEO MATERIAL (one section per video):\n\n' +
    combined;

  const { result, usage } = await runClaude(prompt);

  if (!result || !result.trim()) {
    throw new Error('generateCrossDigest: Claude returned an empty result.');
  }

  // mergeUsage normalises the shape even for a single usage object.
  return { digest: result, usage: mergeUsage([usage]) };
}

export async function factCheck(transcriptText) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text provided.');
  }

  const caveat =
    'These assessments are based solely on the model\'s training knowledge ' +
    'and do NOT reflect live web research or real-time fact verification. ' +
    'Treat all verdicts as approximate and verify independently for anything consequential.';

  // --- Long-path guard ---
  if (transcriptText.length > LONG_PATH_THRESHOLD_CHARS) {
    const chunks = chunkText(transcriptText);
    if (chunks.length > 1) {
      const { claims, usage } = await factCheckMapReduce(chunks);
      return { claims, caveat, usage };
    }
  }

  // --- Fast path (unchanged) ---
  const prompt =
    'You are given the transcript of a YouTube video. ' +
    'Extract the main factual or checkable claims made in the video and assess each one ' +
    'based ONLY on your training knowledge. ' +
    'You do NOT have access to the internet or live data — be explicit about this limitation in your explanations.\n\n' +
    'For each claim provide:\n' +
    '  - "claim": a short summary of the factual assertion\n' +
    '  - "assessment": one of "supported", "disputed", or "unverifiable"\n' +
    '  - "confidence": one of "low", "medium", or "high"\n' +
    '  - "explanation": a concise explanation of your assessment, explicitly noting this is ' +
    'based on training knowledge only and NOT live-web verification\n\n' +
    'Return STRICT JSON and nothing else — no prose before or after, no code fences:\n' +
    '{"claims":[{"claim":"...","assessment":"supported|disputed|unverifiable","confidence":"low|medium|high","explanation":"..."}, ...]}\n\n' +
    'TRANSCRIPT:\n\n' +
    transcriptText;

  const { result, usage } = await runClaude(prompt);

  let parsed;
  try {
    parsed = parseJsonLoose(result);
  } catch (err) {
    throw new Error(`factCheck: failed to parse Claude response as JSON. ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.claims)) {
    throw new Error('factCheck: Claude response missing "claims" array.');
  }

  const validAssessments = new Set(['supported', 'disputed', 'unverifiable']);
  const validConfidences = new Set(['low', 'medium', 'high']);

  const claims = parsed.claims.map((c, i) => {
    if (
      typeof c.claim !== 'string' ||
      !validAssessments.has(c.assessment) ||
      !validConfidences.has(c.confidence) ||
      typeof c.explanation !== 'string'
    ) {
      throw new Error(
        `factCheck: claim[${i}] has invalid shape or out-of-range enum values.`
      );
    }
    return {
      claim: c.claim,
      assessment: c.assessment,
      confidence: c.confidence,
      explanation: c.explanation,
    };
  });

  return { claims, caveat, usage };
}
