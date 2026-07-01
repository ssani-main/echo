import { spawn } from 'node:child_process';

const DIGEST_TIMEOUT_MS = 180_000; // 3 minutes

const PROMPT_PREFIX =
  'You are given the raw auto-generated transcript of a YouTube video. ' +
  'It may be in any language. ' +
  'Produce a clear, well-structured digest written in ENGLISH, using Markdown, ' +
  'with exactly these sections:\n\n' +
  '## TL;DR\n' +
  'A 2-3 sentence overview.\n\n' +
  '## Key Points\n' +
  'A bulleted list of the most important takeaways.\n\n' +
  '## Detailed Summary\n' +
  'The content reorganized by topic, with short "###" subheadings and readable paragraphs. ' +
  'Be faithful to the transcript; do not invent facts that are not present. ' +
  'Do not include any preamble before the "## TL;DR" heading.\n\n' +
  'Here is the transcript:\n\n';

/**
 * Sends transcriptText to the claude CLI and resolves with { digest, usage }.
 *
 * @param {string} transcriptText - Raw joined transcript text.
 * @returns {Promise<{ digest: string, usage: object }>}
 */
export async function generateDigest(transcriptText) {
  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('No transcript text to digest.');
  }

  const prompt = PROMPT_PREFIX + transcriptText;

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn('claude', ['-p', '--model', 'sonnet', '--output-format', 'json'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    // --- timeout ---
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
      reject(new Error(`claude CLI timed out after ${DIGEST_TIMEOUT_MS / 1000}s.`));
    }, DIGEST_TIMEOUT_MS);

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
            new Error(parsed.result || parsed.subtype || 'Digest failed')
          );
        }

        const u = parsed.usage || {};
        const inputTokens = u.input_tokens || 0;
        const outputTokens = u.output_tokens || 0;
        const cacheReadTokens = u.cache_read_input_tokens || 0;
        const cacheCreationTokens = u.cache_creation_input_tokens || 0;
        const usage = {
          costUsd: (typeof parsed.total_cost_usd === 'number') ? parsed.total_cost_usd : null,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
          durationMs: (typeof parsed.duration_ms === 'number') ? parsed.duration_ms : null,
        };

        return resolve({ digest: String(parsed.result || '').trim(), usage });
      } else {
        const detail = stderr.slice(0, 500) || '(no stderr output)';
        return reject(
          new Error(
            `claude CLI exited with code ${code}. Stderr: ${detail}`
          )
        );
      }
    });
  });
}
