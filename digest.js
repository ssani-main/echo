import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const CLAUDE_ARGS = ['-p', '--model', 'sonnet', '--output-format', 'json'];

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
      reject(
        new Error(
          `Could not run the \`claude\` CLI. Is Claude Code installed and on PATH? (${err.message})`
        )
      );
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
        return reject(
          new Error(`claude CLI exited with code ${code}. Stderr: ${detail}`)
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Generate a digest / summary of the transcript.
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
 * @param {Array<{ text: string, offset: number }>} segments  offset in seconds
 * @returns {Promise<{ chapters: Array<{ title: string, startSec: number }>, usage: object }>}
 */
export async function extractChapters(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('segments must be a non-empty array of { text, offset }.');
  }

  // Build compact timecoded transcript
  const timecoded = segments
    .map((s) => `[${Math.round(s.offset)}] ${s.text}`)
    .join('\n');

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
 * @param {string} transcriptText
 * @returns {Promise<{ claims: Array<{ claim: string, assessment: string, confidence: string, explanation: string }>, caveat: string, usage: object }>}
 */
export async function factCheck(transcriptText) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text provided.');
  }

  const caveat =
    'These assessments are based solely on the model\'s training knowledge ' +
    'and do NOT reflect live web research or real-time fact verification. ' +
    'Treat all verdicts as approximate and verify independently for anything consequential.';

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
