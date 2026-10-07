import Anthropic from '@anthropic-ai/sdk';
import { runClaude, runClaudeStream } from './digest.js';

// ---------------------------------------------------------------------------
// Summarization provider seam.
//
// Providers implement a common { call(prompt, opts) -> { result, usage, truncated } }
// interface, plus an optional stream(prompt, opts, onToken):
//   - ClaudeCliProvider — wraps the local `claude` CLI (keyless, the default).
//   - ApiKeyProvider    — the Anthropic API via the SDK (BYOK).
//   - DeepSeekProvider  — DeepSeek's OpenAI-compatible API (BYOK).
//
// getProvider() decides which one to use. CLI stays the default unless a
// per-request provider is named, ECHO_PROVIDER selects one, or a bare per-request
// apiKey is supplied — merely having ANTHROPIC_API_KEY set in the environment
// does NOT switch providers, so local `npm start` behaviour is preserved exactly.
//
// ---------------------------------------------------------------------------
// Why there is a REGISTRY and not just three objects
// ---------------------------------------------------------------------------
// The three providers do not merely differ in transport — they differ in FACTS
// that must never be inherited from one another:
//
//   · how many output tokens they can produce (16 000 here, ~384 000 there)
//   · how large a prompt they can hold, which sets where map-reduce begins
//   · how many characters make a token, which is a tokenizer property
//   · whether a key is needed at all
//
// The 16 000 output cap used to be a literal inside ApiKeyProvider, which was
// only ever safe because Anthropic was the only API provider. A second one
// inherits it by default, and the failure is silent: a response cut off at the
// cap is returned as a SUCCESS, saved to the library, exported to Markdown,
// written into the vault and mirrored to the PDS, indistinguishable from a
// complete one. `stop_reason` was read nowhere in this codebase, so nothing
// could have noticed. Two things fix that and both live here: limits are per
// provider, and a truncated response now says so (see `truncated` below).
// ---------------------------------------------------------------------------

// Pricing per 1M tokens (input/output), used only to compute an approximate
// costUsd. Cache-read tokens are billed at ~0.1x the input rate, cache-creation
// tokens at ~1.25x the input rate.
// pricing may drift — update if Anthropic changes its published rates.
const PRICING = {
  sonnet: { model: 'claude-sonnet-5', input: 3, output: 15 },
  opus: { model: 'claude-opus-4-8', input: 5, output: 25 },
};

/**
 * Reads a positive-number env var, falling back silently on anything malformed.
 *
 * Deliberately NOT server.js's numFromEnv(), which throws at boot. That
 * strictness exists there because a NaN size cap turns `chars > NaN` into
 * `false` — a caller-controlled bypass. Nothing here is a bypass: a bad
 * concurrency or context number can only produce a slower or differently-chunked
 * digest, so a bad value falls back rather than taking the server down. This
 * matches the convention already used for ECHO_DIGEST_MAP_CONCURRENCY.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number }} [opts]
 * @returns {number}
 */
function envNum(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Every provider, with the facts that must not be shared between them.
 *
 * `maxOutputTokens: null` means "there is no knob for this" — the CLI has no
 * equivalent of max_tokens, and DeepSeek's is intentionally left unset so the
 * API applies its own ceiling rather than us asserting a number we have not
 * verified (see DeepSeekProvider). Truncation is detected from the response's
 * own stop/finish reason either way, so an unknown ceiling is still a *visible*
 * ceiling.
 *
 * @typedef {{
 *   id: string, label: string, kind: 'cli'|'anthropic'|'openai',
 *   requiresKey: boolean, contextTokens: number, maxOutputTokens: number|null,
 *   charsPerToken: number, models: string[], defaultModel: string|null,
 *   pricing: object|null, blurb: string, reasoning: { dialect: string|null },
 * }} ProviderFacts
 */

/**
 * Characters per token. Claude's tokenizer and DeepSeek's differ, but both land
 * near 4 for English prose, and the only consumer is a chunk-size ESTIMATE that
 * is already padded by the context margin. A provider that turned out denser
 * would be over-chunked, not broken — which is the safe direction.
 */
const CHARS_PER_TOKEN_DEFAULT = 4;

// ---------------------------------------------------------------------------
// Reasoning ("thinking")
// ---------------------------------------------------------------------------
// One shared vocabulary, four values, translated per provider. It exists for a
// single reason: to make a comparison between two providers mean something.
//
// Echo's Anthropic path has always sent `thinking: {type: 'disabled'}`, while the
// DeepSeek path sent nothing at all — which leaves the decision to DeepSeek's own
// default. If that default is `enabled`, then switching provider changes TWO
// things at once (the model and whether it reasons first) and a difference in the
// output cannot be attributed to either. Reasoning tokens are also billed and
// counted as COMPLETION tokens, so they push a response toward its output ceiling
// — the truncation behaviour.
//
// So "off" is the default for every provider, and it means OFF rather than
// "unspecified".
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

/**
 * Anthropic takes a token BUDGET where the OpenAI-shaped APIs take an effort
 * word. This mapping is Echo's own, written down so it is not folklore, and
 * overridable with ECHO_THINKING_BUDGET_TOKENS.
 */
const ANTHROPIC_THINKING_BUDGETS = { low: 2_048, medium: 4_096, high: 8_000 };

/**
 * Canonicalises a reasoning level, or null when it names nothing.
 *
 * `on` is accepted as an alias for `high` because the levels are a scale, not a
 * switch, and "on" is what someone will type. It maps to the top of the scale
 * rather than the middle so that it cannot silently mean "less than I asked for".
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeReasoningLevel(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (key === 'on' || key === 'enabled' || key === 'true') return 'high';
  if (key === 'off' || key === 'false' || key === 'disabled' || key === 'none') return 'off';
  return REASONING_LEVELS.includes(key) ? key : null;
}

/**
 * The reasoning level for this request.
 *
 * Order: an explicit per-request level, then ECHO_THINKING, then off. An
 * unrecognised ECHO_THINKING falls back to off rather than throwing — a typo in a
 * .env must not stop `npm start`, the same rule the provider name follows.
 *
 * @param {{ reasoning?: string }} [opts]
 * @returns {string}
 */
export function getReasoningLevel(opts = {}) {
  const explicit = normalizeReasoningLevel(opts.reasoning);
  if (explicit) return explicit;
  return normalizeReasoningLevel(process.env.ECHO_THINKING) || 'off';
}

/**
 * True when ECHO_DEEPSEEK_THINKING_FIELD=omit asks us to say nothing rather than
 * say "disabled".
 *
 * An escape hatch for an unverified parameter. DeepSeek's docs show
 * `thinking: {type: 'enabled'}`; that an object with a `type` also accepts
 * `disabled` is a strong convention rather than a documented fact, and if this
 * API rejects it the failure would be a 400 on every digest with no obvious
 * cause. Rather than guess in either direction: send `disabled` (because "off"
 * has to actually mean off), and make it one env var to stop sending it.
 */
function deepseekOmitsThinkingField() {
  return String(process.env.ECHO_DEEPSEEK_THINKING_FIELD || '').trim().toLowerCase() === 'omit';
}

/**
 * The request-body fields that express `level` in this provider's dialect.
 *
 * `providerId` is passed EXPLICITLY by each provider rather than resolved from
 * `opts`, and that is a bug fix rather than a style choice. Resolving it from
 * `opts` looks harmless because a request usually names its provider — but the
 * DeepSeek provider is reached with `{ apiKey }` and no `provider`, and a bare
 * key means "Anthropic" to `getProviderId()`. So DeepSeek was handed Anthropic's
 * dialect and sent `thinking: {type:'enabled', budget_tokens: 2048}` instead of
 * `reasoning_effort`, which its API would have rejected. Each provider knowing
 * its own dialect cannot be got wrong by the caller.
 *
 * Returns {} when the provider has no such concept, which is what keeps the CLI
 * path byte-for-byte identical to what it was before any of this existed.
 *
 * @param {{ provider?: string, apiKey?: string, reasoning?: string }} [opts]
 * @param {string|null} [providerId] - the dialect's owner; defaults to opts
 * @returns {{ thinking?: object, reasoning_effort?: string }}
 */
export function reasoningFields(opts = {}, providerId = null) {
  const facts = (providerId && PROVIDERS[providerId]) || getProviderLimits(opts);
  const dialect = facts.reasoning && facts.reasoning.dialect;
  if (!dialect) return {};

  const level = getReasoningLevel(opts);

  if (level === 'off') {
    if (dialect === 'effort' && deepseekOmitsThinkingField()) return {};
    return { thinking: { type: 'disabled' } };
  }

  if (dialect === 'effort') {
    return { thinking: { type: 'enabled' }, reasoning_effort: level };
  }

  // Anthropic. budget_tokens must be at least 1024 and strictly less than
  // max_tokens, so it is clamped rather than trusted: an out-of-range budget is a
  // hard 400 from the API, and the ceiling here is 16 000.
  const maxOut = facts.maxOutputTokens || 16_000;
  const override = envNum('ECHO_THINKING_BUDGET_TOKENS', 0, { min: 1 });
  const wanted = override || ANTHROPIC_THINKING_BUDGETS[level] || 4_096;
  const budget = Math.max(1_024, Math.min(wanted, maxOut - 1_024));
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/** @type {Record<string, ProviderFacts>} */
export const PROVIDERS = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude CLI (this machine)',
    kind: 'cli',
    requiresKey: false,
    // claude-opus-5-5 reports contextWindow 1000000 (maxOutputTokens 128000) in
    // `claude -p --output-format json` modelUsage.
    contextTokens: 1_000_000,
    // The CLI takes no max_tokens flag; it applies its own ceiling.
    maxOutputTokens: null,
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    // Must match CLI_MODEL in digest.js (the two cannot share a constant: the
    // modules import each other). tests/providers.test.js fails if they drift.
    models: ['claude-opus-5-5'],
    defaultModel: 'claude-opus-5-5',
    pricing: null,
    blurb: 'Uses your local Claude Code login. No API key, no billing setup.',
    // No dialect: the CLI's reasoning is its own business, and Echo does not pass
    // flags to it. Returning {} keeps that path exactly as it was.
    reasoning: { dialect: null },
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic API',
    kind: 'anthropic',
    requiresKey: true,
    contextTokens: 200_000,
    // Unchanged from the literal this replaced. Raising it is a behaviour
    // change, not a bug fix, so it is left exactly as it was.
    maxOutputTokens: 16_000,
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    models: ['sonnet', 'opus'],
    defaultModel: 'sonnet',
    pricing: PRICING,
    blurb: 'Your own Anthropic key. Required on a hosted instance.',
    reasoning: { dialect: 'anthropic-budget' },
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek API',
    kind: 'openai',
    requiresKey: true,
    contextTokens: envNum('ECHO_DEEPSEEK_CONTEXT_TOKENS', 1_000_000),
    // SET by default, and this is a measured decision, not a guess.
    //
    // It was left unset at first, on the reasoning that the API's own ceiling is
    // better than one we assert. The provider A/B showed what that actually
    // costs: `article` mode on a 71 627-char transcript came back
    // `finish_reason: 'length'` at 6 552 words, while an unset ceiling had looked
    // harmless in digest mode (2-3k output tokens, nowhere near any limit). The
    // API's DEFAULT output ceiling is far below the model's maximum, so leaving
    // it unset silently truncated the one mode that rewrites a whole video.
    //
    // 384 000 is the model's stated maximum, and a live request with exactly this
    // value was accepted (HTTP 200) before it was made the default. It is a
    // ceiling, not a request to generate: nothing is billed for room unused.
    maxOutputTokens: envNum('ECHO_DEEPSEEK_MAX_OUTPUT_TOKENS', 384_000, { min: 1 }),
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    // 'deepseek-flash' IS DeepSeek-V4.1-Flash — the display name and the wire id
    // differ, which is exactly how a wrong default slips in. docs.deepseek.com
    // (checked 2026-09-11) lists only two ids: `deepseek-flash` and
    // `deepseek-v4-pro`. The legacy ids `deepseek-v4-flash` and
    // `deepseek-v4-flash-vision-exp` are still accepted and are served by V4.1
    // Flash; `deepseek-v4-pro` also routes to V4.1 Flash as of 2026-09-14.
    // The retired OpenAI-era alias `deepseek-chat` is NOT in that list, and was
    // the initial default here — a name this API would have rejected at runtime.
    models: [process.env.ECHO_DEEPSEEK_MODEL || 'deepseek-flash'],
    defaultModel: process.env.ECHO_DEEPSEEK_MODEL || 'deepseek-flash',
    // No published rate is hardcoded here. A wrong number in a cost display is
    // worse than no number, and cost display was removed from the UI anyway —
    // token counts are reported, costUsd simply stays undefined.
    pricing: null,
    blurb: 'A long-context, lower-cost alternative. Needs a DeepSeek key.',
    reasoning: { dialect: 'effort' },
  },
};

export const DEFAULT_PROVIDER_ID = 'claude-cli';

/**
 * Aliases accepted from the environment and from clients, so the value people
 * already have in their .env keeps working after the registry arrived.
 * ECHO_PROVIDER=api has meant "the Anthropic key path" since before DeepSeek
 * existed, and it must not start meaning something else.
 */
const PROVIDER_ALIASES = {
  api: 'anthropic',
  anthropic: 'anthropic',
  cli: 'claude-cli',
  'claude-cli': 'claude-cli',
  claude: 'claude-cli',
  deepseek: 'deepseek',
};

/**
 * Canonicalises a provider name, or null when it names nothing we have.
 *
 * Returning null rather than falling back is what lets the two callers differ:
 * an environment variable that names an unknown provider falls back to the
 * default (a typo in a .env must not stop `npm start`), while a REQUEST that
 * names one is a client bug and gets a 400 instead of a silent substitution.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeProviderId(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_ALIASES[key] || null;
}

/**
 * Which provider should serve this request?
 *
 * Order matters. An explicit request wins, then a bare apiKey means Anthropic
 * (that is what every existing caller sending X-Echo-Api-Key means, and it
 * keeps working), then the environment, then the local default.
 *
 * @param {{ provider?: string, apiKey?: string }} [opts]
 * @returns {string}
 */
export function getProviderId(opts = {}) {
  const explicit = normalizeProviderId(opts.provider);
  if (explicit) return explicit;
  if (opts.apiKey) return 'anthropic';
  return normalizeProviderId(process.env.ECHO_PROVIDER) || DEFAULT_PROVIDER_ID;
}

/**
 * The facts for whichever provider this request resolves to — the single place
 * chunking, limits and the client's progress message read them from.
 *
 * @param {{ provider?: string, apiKey?: string }} [opts]
 * @returns {ProviderFacts}
 */
export function getProviderLimits(opts = {}) {
  return PROVIDERS[getProviderId(opts)] || PROVIDERS[DEFAULT_PROVIDER_ID];
}

/**
 * The client-facing provider list: facts only, no secrets, filtered by mode.
 *
 * Served to the browser so the Settings and Digest controls can be BUILT from
 * the registry instead of restating it. A hardcoded <option> list in the markup
 * would be a second copy of these facts, and a copied list drifts silently —
 * this codebase has that lesson recorded twice already (extractSummary, the
 * duplicated reading controls). One registry, served.
 *
 * @param {{ isWeb?: boolean }} opts
 * @returns {Array<Pick<ProviderFacts, 'id'|'label'|'requiresKey'|'contextTokens'|'maxOutputTokens'|'models'|'defaultModel'|'blurb'>>}
 */
export function publicProviderList({ isWeb = false } = {}) {
  return Object.values(PROVIDERS)
    // A hosted instance has no local `claude` binary, so offering the CLI there
    // would be a control that cannot work — the failure this codebase calls a
    // dead control being worse than an absent one.
    .filter((p) => !(isWeb && p.kind === 'cli'))
    .map((p) => ({
      id: p.id,
      label: p.label,
      requiresKey: p.requiresKey,
      contextTokens: p.contextTokens,
      maxOutputTokens: p.maxOutputTokens,
      models: p.models,
      defaultModel: p.defaultModel,
      blurb: p.blurb,
      // Served so the browser does not have to know which providers can reason,
      // or what the levels are — and so a provider without the concept gets no
      // control rather than a control that silently does nothing.
      reasoning: {
        supported: !!(p.reasoning && p.reasoning.dialect),
        levels: REASONING_LEVELS,
      },
    }));
}

/**
 * The truncation fields for whichever provider this request resolves to, for
 * callers that detect the condition themselves — the CLI path reads it out of
 * the CLI's own JSON in digest.js and needs the same wording the API paths use.
 *
 * @param {{ provider?: string, apiKey?: string }} [opts]
 * @returns {{ truncated: true, truncationNote: string }}
 */
export function truncationFields(opts = {}) {
  const facts = getProviderLimits(opts);
  return truncationResult(facts.label, facts.maxOutputTokens);
}

/**
 * Builds the error a truncated response produces.
 *
 * Truncation is NOT thrown as a failure. The text that exists is real, useful,
 * and already partly on the user's screen when streaming; discarding it would
 * turn a partial answer into no answer. Instead the result carries
 * `truncated: true` and the caller surfaces it as a visible notice next to the
 * text it applies to. What must never happen is what used to happen: silence.
 *
 * @param {string} providerLabel
 * @param {number|null} maxOutputTokens
 * @returns {{ truncated: true, truncationNote: string }}
 */
function truncationResult(providerLabel, maxOutputTokens) {
  const limit = maxOutputTokens
    ? `${maxOutputTokens.toLocaleString('en-US')} output tokens`
    : 'the model\'s output limit';
  return {
    truncated: true,
    truncationNote:
      `${providerLabel} stopped at ${limit}, so this is incomplete — it ends mid-thought. ` +
      'Try again with "Digest" instead of "Everything", or switch provider in Options.',
  };
}

// ---------------------------------------------------------------------------
// Claude CLI
// ---------------------------------------------------------------------------

/**
 * Wraps the existing Claude CLI logic (see runClaude in digest.js) behind
 * the common provider interface. Behaviour is byte-for-byte identical to
 * the pre-existing direct runClaude() calls.
 */
export const ClaudeCliProvider = {
  id: 'claude-cli',

  /**
   * @param {string} prompt
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ result: string, usage: object, truncated?: true }>}
   */
  async call(prompt, opts = {}) {
    return runClaude(prompt, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  },

  /**
   * Same call, delivering text through `onToken` as it arrives. Resolves with
   * the identical { result, usage } the buffered call produces.
   *
   * @param {string} prompt
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} opts
   * @param {(text: string) => void} onToken
   * @returns {Promise<{ result: string, usage: object, truncated?: true }>}
   */
  async stream(prompt, opts = {}, onToken) {
    return runClaudeStream(prompt, { timeoutMs: opts.timeoutMs, signal: opts.signal }, onToken);
  },
};

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

/**
 * Maps an Anthropic SDK error into the same { echoCode, message, hint }
 * shape produced by the CLI error path in digest.js, so downstream error
 * handling in server.js works unchanged regardless of provider.
 *
 * A user-cancelled request (opts.signal aborted) must NOT come out as
 * API_FAILED — that pairs with a "Try again" button in the error card, which
 * is exactly wrong for something the user asked to stop. The SDK's own abort
 * error (`Anthropic.APIUserAbortError`) is passed through unmapped, renamed
 * to the same AbortError shape digest.js's CLI path produces, so both
 * providers cancel identically from the caller's point of view.
 *
 * @param {Error & { status?: number, name?: string }} err
 * @returns {Error}
 */
function mapAnthropicError(err) {
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') {
    const e = new Error('Digest generation was cancelled.');
    e.name = 'AbortError';
    e.code = 'ABORT_ERR';
    return e;
  }

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
  e.detail = (err && (err.message || String(err))) || '';
  console.error('Anthropic API error:', err);
  return e;
}

/**
 * Maps an Anthropic response's usage block to Echo's usage shape, including the
 * approximate cost. Shared by the buffered and streaming calls so the two can
 * never drift into reporting different numbers for the same work.
 *
 * @param {{usage?: object}} response
 * @param {{input: number, output: number}} pricing
 * @param {number} durationMs
 */
function usageFromApiResponse(response, pricing, durationMs) {
  const u = (response && response.usage) || {};
  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const cacheReadTokens = u.cache_read_input_tokens || 0;
  const cacheCreationTokens = u.cache_creation_input_tokens || 0;

  // pricing may drift
  const costUsd =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.input * 0.1 +
    (cacheCreationTokens / 1_000_000) * pricing.input * 1.25;

  return {
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    durationMs,
  };
}

/**
 * Reads a provider's "I hit the ceiling" signal out of a finish reason.
 *
 * The two APIs spell the same fact differently — Anthropic `stop_reason:
 * 'max_tokens'`, OpenAI-compatible `finish_reason: 'length'` — and neither ever
 * raises an error for it. This is the one place that knows both spellings.
 *
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
export function isTruncationReason(reason) {
  return reason === 'max_tokens' || reason === 'length';
}

/**
 * The model id a DeepSeek request will use, given this request's opts.
 *
 * Exported so a test can pin it: the default is a hard dependency on a name
 * DeepSeek controls, and the failure mode of getting it wrong is a 400 at
 * digest time rather than anything visible at build time.
 *
 * @param {{ model?: string }} [opts]
 * @returns {string}
 */
export function deepseekModelFor(opts = {}) {
  if (typeof opts.model === 'string' && opts.model.trim()) return opts.model.trim();
  return PROVIDERS.deepseek.defaultModel;
}

/**
 * Calls the Anthropic API directly via @anthropic-ai/sdk. Not used by
 * default — only selected when explicitly requested (see getProvider()).
 */
export const ApiKeyProvider = {
  id: 'anthropic',

  /**
   * @param {string} prompt
   * @param {{ apiKey?: string, model?: 'sonnet'|'opus', signal?: AbortSignal }} [opts]
   * @returns {Promise<{ result: string, usage: object, truncated?: true, truncationNote?: string }>}
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
    const facts = PROVIDERS.anthropic;

    let client;
    try {
      client = new Anthropic({ apiKey });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const content = prompt;

    const start = Date.now();
    let response;
    try {
      response = await client.messages.create(
        {
          model: pricing.model,
          max_tokens: facts.maxOutputTokens,
          // Off unless asked for, and "off" is sent explicitly so the API cannot
          // choose for us — see the reasoning note above the registry. The id is
          // passed explicitly: this provider IS anthropic, whatever the request
          // happened to name.
          ...reasoningFields(opts, 'anthropic'),
          messages: [{ role: 'user', content }],
        },
        { signal: opts.signal }
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const durationMs = Date.now() - start;

    const result = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const out = { result, usage: usageFromApiResponse(response, pricing, durationMs) };
    if (isTruncationReason(response.stop_reason)) {
      Object.assign(out, truncationResult(facts.label, facts.maxOutputTokens));
    }
    return out;
  },

  /**
   * Streaming counterpart, via the SDK's messages.stream().
   *
   * The final message carries the authoritative text and usage, so the result
   * is assembled from that rather than from the concatenated deltas — the two
   * agree, but only one of them is the API's own answer, and usage is only
   * available on the final message anyway. It also carries `stop_reason`, which
   * is what makes truncation detectable on the streaming path at all.
   *
   * @param {string} prompt
   * @param {{ apiKey?: string, model?: 'sonnet'|'opus', signal?: AbortSignal }} opts
   * @param {(text: string) => void} onToken
   * @returns {Promise<{ result: string, usage: object, truncated?: true, truncationNote?: string }>}
   */
  async stream(prompt, opts = {}, onToken) {
    const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      const e = new Error('No Anthropic API key available.');
      e.echoCode = 'API_NOT_AUTHED';
      e.hint = 'Set ANTHROPIC_API_KEY in the environment or pass an apiKey.';
      throw e;
    }

    const modelKey = opts.model === 'opus' ? 'opus' : 'sonnet';
    const pricing = PRICING[modelKey];
    const facts = PROVIDERS.anthropic;

    let client;
    try {
      client = new Anthropic({ apiKey });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const start = Date.now();
    let final;
    try {
      const streamed = client.messages.stream(
        {
          model: pricing.model,
          max_tokens: facts.maxOutputTokens,
          ...reasoningFields(opts, 'anthropic'),
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: opts.signal }
      );
      streamed.on('text', (text) => {
        if (typeof onToken === 'function' && text) onToken(text);
      });
      final = await streamed.finalMessage();
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const durationMs = Date.now() - start;

    const result = (final.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const out = { result, usage: usageFromApiResponse(final, pricing, durationMs) };
    if (isTruncationReason(final.stop_reason)) {
      Object.assign(out, truncationResult(facts.label, facts.maxOutputTokens));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// DeepSeek (OpenAI-compatible)
// ---------------------------------------------------------------------------

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek's API is OpenAI-shaped, not Anthropic-shaped, so it cannot reuse
 * ApiKeyProvider — but it needs no dependency either. Node 22's global fetch
 * covers both the request and the SSE stream, which keeps this file's only
 * third-party import the Anthropic SDK it already had. (A new dependency would
 * also have to be added to the Tauri bundle's staged node_modules; `fetch` does
 * not.)
 *
 * Two deliberate choices:
 *
 *   · NO system prompt. The Anthropic API path sends the prompt as a single user
 *     message and relies on the prompt's own instructions; the isolating system
 *     prompt is a CLI-only concern. Sending DeepSeek a system message the
 *     Anthropic path does not get would make a provider comparison measure the
 *     prompt change as well as the model, which is exactly the confound this
 *     seam exists to avoid.
 *   · max_tokens IS sent, from the registry (384 000 by default). It was omitted
 *     at first so the API could choose; the A/B measured the consequence — an
 *     `article`-mode digest truncated at 6 552 words because the API's default
 *     ceiling is well below the model's maximum. See the registry entry.
 */
export const DeepSeekProvider = {
  id: 'deepseek',

  /**
   * @param {string} prompt
   * @param {{ apiKey?: string, model?: string, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ result: string, usage: object, truncated?: true, truncationNote?: string }>}
   */
  async call(prompt, opts = {}) {
    const apiKey = deepseekKey(opts);
    const facts = PROVIDERS.deepseek;
    const body = deepseekBody(prompt, opts, facts, false);

    const start = Date.now();
    const res = await deepseekFetch('/chat/completions', apiKey, body, opts.signal);
    const json = await readJson(res);
    const durationMs = Date.now() - start;

    const choice = (json.choices || [])[0] || {};
    const result = String((choice.message && choice.message.content) || '').trim();

    const out = { result, usage: usageFromOpenAiResponse(json, durationMs) };
    if (isTruncationReason(choice.finish_reason)) {
      Object.assign(out, truncationResult(facts.label, facts.maxOutputTokens));
    }
    return out;
  },

  /**
   * Streaming counterpart over server-sent events.
   *
   * Reassembles lines across chunk boundaries the same way runClaudeStream()
   * does for the CLI's NDJSON: a network chunk ends wherever it likes, and an
   * SSE frame split mid-line would otherwise be parsed as a malformed event.
   * `stream_options.include_usage` makes the final frame carry token counts,
   * which the non-streaming response gives us for free.
   *
   * @param {string} prompt
   * @param {{ apiKey?: string, model?: string, signal?: AbortSignal }} opts
   * @param {(text: string) => void} onToken
   * @returns {Promise<{ result: string, usage: object, truncated?: true, truncationNote?: string }>}
   */
  async stream(prompt, opts = {}, onToken) {
    const apiKey = deepseekKey(opts);
    const facts = PROVIDERS.deepseek;
    const body = deepseekBody(prompt, opts, facts, true);

    const start = Date.now();
    const res = await deepseekFetch('/chat/completions', apiKey, body, opts.signal);

    if (!res.body || typeof res.body.getReader !== 'function') {
      // No readable stream (an old runtime, or a proxy that buffered it). Fall
      // back to reading the whole body as one SSE payload rather than failing —
      // the caller already tolerates a buffered result everywhere else.
      const text = await res.text();
      return parseSseWhole(text, onToken, facts, start);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = '';
    let finishReason = null;
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines only; keep the remainder for the next chunk.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const ev = parseSseLine(line);
        if (!ev) continue;
        if (ev.usage) usage = ev.usage;
        if (ev.finishReason) finishReason = ev.finishReason;
        if (ev.text) {
          result += ev.text;
          if (typeof onToken === 'function') onToken(ev.text);
        }
      }
    }

    // A final line with no trailing newline (the `data: [DONE]` terminator
    // usually, but a usage frame can land there too).
    if (buffer.trim()) {
      const ev = parseSseLine(buffer.replace(/\r$/, ''));
      if (ev) {
        if (ev.usage) usage = ev.usage;
        if (ev.finishReason) finishReason = ev.finishReason;
        if (ev.text) {
          result += ev.text;
          if (typeof onToken === 'function') onToken(ev.text);
        }
      }
    }

    const durationMs = Date.now() - start;
    const out = {
      result: result.trim(),
      usage: usageFromOpenAiUsage(usage, durationMs),
    };
    if (isTruncationReason(finishReason)) {
      Object.assign(out, truncationResult(facts.label, facts.maxOutputTokens));
    }
    return out;
  },
};

/**
 * @param {{ apiKey?: string }} opts
 * @returns {string}
 */
function deepseekKey(opts) {
  const apiKey = opts.apiKey || process.env.ECHO_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    const e = new Error('No DeepSeek API key available.');
    e.echoCode = 'API_NOT_AUTHED';
    e.hint = 'Add your DeepSeek API key in Settings, or set ECHO_DEEPSEEK_API_KEY.';
    throw e;
  }
  return apiKey.trim();
}

/**
 * @param {string} prompt
 * @param {{ model?: string }} opts
 * @param {ProviderFacts} facts
 * @param {boolean} stream
 */
function deepseekBody(prompt, opts, facts, stream) {
  const body = {
    model: deepseekModelFor(opts),
    messages: [{ role: 'user', content: prompt }],
    stream: Boolean(stream),
    // Same vocabulary as the Anthropic path, translated into this API's dialect
    // (reasoning_effort rather than a token budget). Without this the request
    // would leave reasoning to the API default, which is the one thing that
    // would make a provider comparison meaningless.
    //
    // The provider id is passed explicitly. Resolving it from `opts` would look
    // right and be wrong: this provider is reached with a bare apiKey, and a bare
    // key means "anthropic" to the resolver — so it would send Anthropic's
    // budget_tokens to an API that expects reasoning_effort.
    ...reasoningFields(opts, 'deepseek'),
  };
  // Sent always now — see the registry note: the API's default ceiling truncated
  // a long article, so "let the API decide" turned out to be the lossy option.
  if (facts.maxOutputTokens) body.max_tokens = facts.maxOutputTokens;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

/**
 * One place that builds, sends and error-maps a DeepSeek request, so the
 * buffered and streaming paths cannot drift in URL, headers or error codes.
 *
 * @param {string} path
 * @param {string} apiKey
 * @param {object} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function deepseekFetch(path, apiKey, body, signal) {
  const base = (process.env.ECHO_DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw mapDeepSeekError(err);
  }

  if (!res.ok) {
    // The body carries the API's own words ("Authentication Fails", "Insufficient
    // Balance", …) and is the only place that detail exists — keep it in `detail`
    // so the error card's disclosure has something real to show.
    let detail = '';
    try { detail = (await res.text()).slice(0, 2000); } catch { /* body already gone */ }
    throw mapDeepSeekError({ status: res.status, message: detail });
  }
  return res;
}

/**
 * @param {Response} res
 */
async function readJson(res) {
  try {
    return await res.json();
  } catch (err) {
    const e = new Error('DeepSeek returned a response that was not valid JSON.');
    e.echoCode = 'API_FAILED';
    e.hint = 'Try again; if it persists, check the Echo server log.';
    e.detail = (err && err.message) || '';
    throw e;
  }
}

/**
 * Maps a DeepSeek/HTTP failure onto the same echoCode vocabulary the Anthropic
 * path uses, so server.js and the error card need no provider-specific branch.
 *
 * @param {Error & { status?: number }} err
 */
function mapDeepSeekError(err) {
  if (err?.name === 'AbortError') {
    const e = new Error('Digest generation was cancelled.');
    e.name = 'AbortError';
    e.code = 'ABORT_ERR';
    return e;
  }

  const status = err && err.status;

  if (status === 401 || status === 403) {
    const e = new Error('DeepSeek API authentication failed.');
    e.echoCode = 'API_NOT_AUTHED';
    e.hint = 'Check that your DeepSeek API key is set and valid.';
    e.detail = (err && err.message) || '';
    return e;
  }

  if (status === 429) {
    const e = new Error('DeepSeek API rate limit exceeded.');
    e.echoCode = 'API_RATE_LIMITED';
    e.hint = 'Wait a moment and try again, or check your DeepSeek balance and limits.';
    e.detail = (err && err.message) || '';
    return e;
  }

  if (status === 402) {
    // Distinct from a bad key and worth saying so: the key is fine, the account
    // is empty, and no amount of retrying changes that.
    const e = new Error('DeepSeek account has insufficient balance.');
    e.echoCode = 'API_NOT_AUTHED';
    e.hint = 'Top up your DeepSeek account, or switch provider in Options.';
    e.detail = (err && err.message) || '';
    return e;
  }

  const e = new Error('DeepSeek API call failed.');
  e.echoCode = 'API_FAILED';
  e.hint = 'Check the terminal running the Echo server for details.';
  e.detail = (err && (err.message || String(err))) || '';
  console.error('DeepSeek API error:', err);
  return e;
}

/**
 * Parses one SSE line into the parts Echo cares about, or null for a line that
 * carries nothing (a comment, an empty keep-alive, the `[DONE]` terminator).
 *
 * Exported for tests: chunk-boundary reassembly is the part of streaming that
 * breaks in production and cannot be reached by eye.
 *
 * @param {string} line
 * @returns {{ text?: string, finishReason?: string|null, usage?: object }|null}
 */
export function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    // A malformed frame is not worth failing the whole stream over — the
    // remaining frames still carry the answer.
    return null;
  }

  const choice = (json.choices || [])[0] || {};
  const delta = (choice.delta && choice.delta.content) || '';
  return {
    text: typeof delta === 'string' && delta ? delta : undefined,
    finishReason: choice.finish_reason || null,
    // Usage arrives on a frame with an empty choices array, so it must be read
    // even when no choice is present.
    usage: json.usage || undefined,
  };
}

/**
 * The buffered-body fallback for a response with no readable stream.
 *
 * @param {string} text
 * @param {(text: string) => void} onToken
 * @param {ProviderFacts} facts
 * @param {number} start
 */
function parseSseWhole(text, onToken, facts, start) {
  let result = '';
  let finishReason = null;
  let usage = null;
  for (const line of String(text).split('\n')) {
    const ev = parseSseLine(line);
    if (!ev) continue;
    if (ev.usage) usage = ev.usage;
    if (ev.finishReason) finishReason = ev.finishReason;
    if (ev.text) {
      result += ev.text;
      if (typeof onToken === 'function') onToken(ev.text);
    }
  }
  const out = { result: result.trim(), usage: usageFromOpenAiUsage(usage, Date.now() - start) };
  if (isTruncationReason(finishReason)) {
    Object.assign(out, truncationResult(facts.label, facts.maxOutputTokens));
  }
  return out;
}

/**
 * @param {object} json - an OpenAI-compatible chat completion
 * @param {number} durationMs
 */
function usageFromOpenAiResponse(json, durationMs) {
  return usageFromOpenAiUsage(json && json.usage, durationMs);
}

/**
 * Maps OpenAI-compatible usage onto Echo's usage shape. `costUsd` is
 * deliberately absent: DeepSeek's published rates are not hardcoded anywhere in
 * this file, and a wrong cost is worse than none (see the registry note).
 *
 * @param {{prompt_tokens?: number, completion_tokens?: number, prompt_cache_hit_tokens?: number}|null|undefined} u
 * @param {number} durationMs
 */
function usageFromOpenAiUsage(u, durationMs) {
  const usage = u || {};
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const cacheReadTokens = usage.prompt_cache_hit_tokens || 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    durationMs,
    // null, not undefined: mergeUsage() distinguishes "this provider reports no
    // cost" (null, summed as null) from a number, and `costUsd += undefined`
    // would poison the whole digest's total into NaN.
    costUsd: null,
  };
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * Validates a candidate API key without spending tokens, by calling a
 * metadata-only endpoint (`models.list()` for Anthropic, `GET /models` for
 * DeepSeek) rather than a completion. Used by the Settings UI so a user learns
 * immediately whether their key works, instead of on first AI call.
 *
 * @param {string} apiKey
 * @param {string} [providerId] - defaults to Anthropic, which is what every
 *   existing caller means.
 * @returns {Promise<{ valid: true }>}
 * @throws {Error} tagged with echoCode/hint on invalid/empty key or any failure.
 */
export async function validateApiKey(apiKey, providerId = 'anthropic') {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    const e = new Error('No API key provided.');
    e.echoCode = 'API_NOT_AUTHED';
    e.hint = 'Enter your API key.';
    throw e;
  }

  if (normalizeProviderId(providerId) === 'deepseek') {
    const base = (process.env.ECHO_DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
    } catch (err) {
      throw mapDeepSeekError(err);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 2000); } catch { /* nothing to read */ }
      throw mapDeepSeekError({ status: res.status, message: detail });
    }
    return { valid: true };
  }

  let client;
  try {
    client = new Anthropic({ apiKey: apiKey.trim() });
  } catch (err) {
    throw mapAnthropicError(err);
  }

  try {
    await client.models.list({ limit: 1 });
  } catch (err) {
    throw mapAnthropicError(err);
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The implementation for this provider id.
 *
 * @param {string} id
 * @returns {typeof ClaudeCliProvider|typeof ApiKeyProvider|typeof DeepSeekProvider}
 */
function implementationFor(id) {
  if (id === 'anthropic') return ApiKeyProvider;
  if (id === 'deepseek') return DeepSeekProvider;
  return ClaudeCliProvider;
}

/**
 * Selects the summarization provider to use.
 *
 * Resolution order lives in getProviderId(); this only maps the result to an
 * implementation. Defaults to ClaudeCliProvider, which preserves current
 * local-dev behaviour exactly.
 *
 * @param {{ apiKey?: string, provider?: string }} [opts]
 * @returns {{ call: Function, stream?: Function, id: string }}
 */
export function getProvider(opts = {}) {
  return implementationFor(getProviderId(opts));
}
