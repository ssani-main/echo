import Anthropic from '@anthropic-ai/sdk';
import { runClaude } from './digest.js';

// ---------------------------------------------------------------------------
// Summarization provider seam.
//
// Two providers implement a common { call(prompt, opts) -> { result, usage } }
// interface:
//   - ClaudeCliProvider — wraps the existing local `claude` CLI logic
//     (unchanged behaviour, this remains the default for local dev).
//   - ApiKeyProvider    — talks directly to the Anthropic API via the SDK,
//     for future web/BYOK usage.
//
// getProvider() decides which one to use. CLI is always the default unless
// ECHO_PROVIDER=api is set or a per-request apiKey is supplied — merely
// having ANTHROPIC_API_KEY set in the environment does NOT switch providers,
// so local `npm start` behaviour is preserved exactly.
// ---------------------------------------------------------------------------

// Pricing per 1M tokens (input/output), used only by ApiKeyProvider to
// compute an approximate costUsd. Cache-read tokens are billed at ~0.1x the
// input rate, cache-creation tokens at ~1.25x the input rate.
// pricing may drift — update if Anthropic changes its published rates.
const PRICING = {
  sonnet: { model: 'claude-sonnet-5', input: 3, output: 15 },
  opus: { model: 'claude-opus-4-8', input: 5, output: 25 },
};

/**
 * Wraps the existing Claude CLI logic (see runClaude in digest.js) behind
 * the common provider interface. Behaviour is byte-for-byte identical to
 * the pre-existing direct runClaude() calls.
 */
export const ClaudeCliProvider = {
  /**
   * @param {string} prompt
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ result: string, usage: object }>}
   */
  async call(prompt, opts = {}) {
    return runClaude(prompt, opts);
  },
};

/**
 * Maps an Anthropic SDK error into the same { echoCode, message, hint }
 * shape produced by the CLI error path in digest.js, so downstream error
 * handling in server.js works unchanged regardless of provider.
 *
 * @param {Error & { status?: number, name?: string }} err
 * @returns {Error}
 */
function mapAnthropicError(err) {
  const status = err && err.status;

  if (status === 401 || err.name === 'AuthenticationError') {
    const e = new Error('Anthropic API authentication failed.');
    e.echoCode = 'API_NOT_AUTHED';
    e.hint = 'Check that your Anthropic API key is set and valid.';
    return e;
  }

  if (status === 429 || err.name === 'RateLimitError') {
    const e = new Error('Anthropic API rate limit exceeded.');
    e.echoCode = 'API_RATE_LIMITED';
    e.hint = 'Wait a moment and try again, or check your API usage limits.';
    return e;
  }

  const e = new Error('Anthropic API call failed.');
  e.echoCode = 'API_FAILED';
  e.hint = 'Check the terminal running the Echo server for details.';
  console.error('Anthropic API error:', err);
  return e;
}

/**
 * Calls the Anthropic API directly via @anthropic-ai/sdk. Not used by
 * default — only selected when explicitly requested (see getProvider()).
 */
export const ApiKeyProvider = {
  /**
   * @param {string} prompt
   * @param {{ apiKey?: string, model?: 'sonnet'|'opus' }} [opts]
   * @returns {Promise<{ result: string, usage: object }>}
   */
  async call(prompt, opts = {}) {
    const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      const e = new Error('No Anthropic API key available.');
      e.echoCode = 'API_NOT_AUTHED';
      e.hint = 'Set ANTHROPIC_API_KEY in the environment or pass an apiKey.';
      throw e;
    }

    const modelKey = opts.model === 'opus' ? 'opus' : 'sonnet';
    const pricing = PRICING[modelKey];

    let client;
    try {
      client = new Anthropic({ apiKey });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const start = Date.now();
    let response;
    try {
      response = await client.messages.create({
        model: pricing.model,
        max_tokens: 16000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const durationMs = Date.now() - start;

    const result = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const u = response.usage || {};
    const inputTokens = u.input_tokens || 0;
    const outputTokens = u.output_tokens || 0;
    const cacheReadTokens = u.cache_read_input_tokens || 0;
    const cacheCreationTokens = u.cache_creation_input_tokens || 0;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

    // pricing may drift
    const costUsd =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output +
      (cacheReadTokens / 1_000_000) * pricing.input * 0.1 +
      (cacheCreationTokens / 1_000_000) * pricing.input * 1.25;

    return {
      result,
      usage: {
        costUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
        durationMs,
      },
    };
  },
};

/**
 * Selects the summarization provider to use.
 *
 * Defaults to ClaudeCliProvider (preserves current local-dev behaviour
 * exactly). ApiKeyProvider is only used when explicitly selected:
 *   - a per-request opts.apiKey is supplied, OR
 *   - process.env.ECHO_PROVIDER === 'api'
 *
 * Merely having ANTHROPIC_API_KEY set in the environment does NOT switch
 * providers — this avoids surprising local dev setups.
 *
 * @param {{ apiKey?: string, provider?: string }} [opts]
 * @returns {{ call: (prompt: string, opts?: object) => Promise<{ result: string, usage: object }> }}
 */
export function getProvider(opts = {}) {
  if (opts.apiKey) return ApiKeyProvider;
  if (process.env.ECHO_PROVIDER === 'api') return ApiKeyProvider;
  return ClaudeCliProvider;
}
