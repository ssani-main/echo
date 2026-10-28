// Port of the registry part of ../providers.js: the per-provider facts, the
// provider and reasoning-level resolution, the client-facing list, truncation
// detection and the SSE line parser. The three providers' calls (the CLI, the
// Anthropic API without its SDK, DeepSeek) come with the digest route (see
// PORT.md). Checked against the original by check/providers.cases.ts.
//
// Why a REGISTRY: the providers differ in FACTS that must never be inherited
// from one another (output ceiling, context window, chars per token, whether a
// key is needed). The 16 000 output cap was once a literal in the Anthropic
// path and a second provider would have inherited it silently — a response cut
// off at a ceiling comes back as a success unless its stop reason is read.

// Pricing per 1M tokens (input/output), only for an approximate costUsd.
const PRICING = {
  sonnet: { model: 'claude-sonnet-5', input: 3, output: 15 },
  opus: { model: 'claude-opus-4-8', input: 5, output: 25 },
};

/**
 * A positive-number env var, falling back silently on anything malformed: a
 * bad concurrency or context number only makes a slower or differently-chunked
 * digest, so it must not stop the server (unlike server.js's size caps).
 */
function envNum(name: string, fallback: number, { min = 1 }: { min?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

export interface ProviderFacts {
  id: string;
  label: string;
  kind: 'cli' | 'anthropic' | 'openai';
  requiresKey: boolean;
  contextTokens: number;
  maxOutputTokens: number | null;
  charsPerToken: number;
  models: string[];
  defaultModel: string | null;
  pricing: typeof PRICING | null;
  blurb: string;
  reasoning: { dialect: string | null };
}

/** What a request says about its provider; every field comes from a client or a caller. */
export interface ProviderOpts {
  provider?: unknown;
  apiKey?: unknown;
  reasoning?: unknown;
  model?: unknown;
}

/**
 * Characters per token: both tokenizers land near 4 for English prose, and the
 * only consumer is a chunk-size estimate already padded by the context margin.
 */
const CHARS_PER_TOKEN_DEFAULT = 4;

// One reasoning vocabulary, translated per provider, so that comparing two
// providers changes one thing at a time. "off" is the default everywhere and
// means OFF, not "unspecified".
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

/** Anthropic takes a token BUDGET where the OpenAI-shaped APIs take an effort word. */
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = { low: 2_048, medium: 4_096, high: 8_000 };

/**
 * Canonicalises a reasoning level, or null when it names nothing. `on` means
 * `high`: the top of the scale, so it can't silently mean less than asked.
 */
export function normalizeReasoningLevel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (key === 'on' || key === 'enabled' || key === 'true') return 'high';
  if (key === 'off' || key === 'false' || key === 'disabled' || key === 'none') return 'off';
  return REASONING_LEVELS.includes(key) ? key : null;
}

/** An explicit per-request level, then ECHO_THINKING, then off (a typo in .env falls back). */
export function getReasoningLevel(opts: ProviderOpts = {}): string {
  const explicit = normalizeReasoningLevel(opts.reasoning);
  if (explicit) return explicit;
  return normalizeReasoningLevel(process.env.ECHO_THINKING) || 'off';
}

/** ECHO_DEEPSEEK_THINKING_FIELD=omit: say nothing rather than "disabled" (an unverified field). */
function deepseekOmitsThinkingField(): boolean {
  return String(process.env.ECHO_DEEPSEEK_THINKING_FIELD || '').trim().toLowerCase() === 'omit';
}

export interface ReasoningFields {
  thinking?: { type: string; budget_tokens?: number };
  reasoning_effort?: string;
}

/**
 * The request-body fields that express the reasoning level in this provider's
 * dialect. `providerId` is passed EXPLICITLY by each provider: DeepSeek is
 * reached with a bare `{ apiKey }`, which means "Anthropic" to getProviderId(),
 * so resolving the dialect from opts once sent DeepSeek Anthropic's dialect.
 * {} when the provider has no such concept, which keeps the CLI path unchanged.
 */
export function reasoningFields(opts: ProviderOpts = {}, providerId: string | null = null): ReasoningFields {
  // shortcut: `(providerId && PROVIDERS[providerId]) || getProviderLimits(opts)` keeps `string` in its type
  // in Seshat (gap: and-or-narrowing), and the lookup as a conditional's branch traps on a missing key (gap:
  // record-lookup-in-conditional), so the lookup ends in `?? null`. Back to the original once both are fixed.
  const named = providerId ? PROVIDERS[providerId] ?? null : null;
  const facts = named || getProviderLimits(opts);
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

  // Anthropic: budget_tokens must be >= 1024 and < max_tokens, so it is clamped
  // (an out-of-range budget is a hard 400).
  const maxOut = facts.maxOutputTokens || 16_000;
  const override = envNum('ECHO_THINKING_BUDGET_TOKENS', 0, { min: 1 });
  const wanted = override || ANTHROPIC_THINKING_BUDGETS[level] || 4_096;
  const budget = Math.max(1_024, Math.min(wanted, maxOut - 1_024));
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

export const PROVIDERS: Record<string, ProviderFacts> = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude CLI (this machine)',
    kind: 'cli',
    requiresKey: false,
    // claude-opus-5-5 reports contextWindow 1000000 in `claude -p` modelUsage.
    contextTokens: 1_000_000,
    // The CLI takes no max_tokens flag; it applies its own ceiling.
    maxOutputTokens: null,
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    // Must match CLI_MODEL in digest.ts.
    models: ['claude-opus-5-5'],
    defaultModel: 'claude-opus-5-5',
    pricing: null,
    blurb: 'Uses your local Claude Code login. No API key, no billing setup.',
    reasoning: { dialect: null },
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic API',
    kind: 'anthropic',
    requiresKey: true,
    contextTokens: 200_000,
    // Unchanged from the literal this replaced; raising it is a behaviour change.
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
    // Set by default, measured: left unset, the API's default ceiling truncated
    // an `article` digest at 6 552 words. 384 000 is the model's maximum and was
    // accepted by a live request.
    maxOutputTokens: envNum('ECHO_DEEPSEEK_MAX_OUTPUT_TOKENS', 384_000, { min: 1 }),
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    // 'deepseek-flash' IS DeepSeek-V4.1-Flash: the wire id and the product name differ.
    models: [process.env.ECHO_DEEPSEEK_MODEL || 'deepseek-flash'],
    defaultModel: process.env.ECHO_DEEPSEEK_MODEL || 'deepseek-flash',
    pricing: null,
    blurb: 'A long-context, lower-cost alternative. Needs a DeepSeek key.',
    reasoning: { dialect: 'effort' },
  },
};

export const DEFAULT_PROVIDER_ID = 'claude-cli';

/** Aliases from the environment and from clients; ECHO_PROVIDER=api keeps meaning Anthropic. */
const PROVIDER_ALIASES: Record<string, string> = {
  api: 'anthropic',
  anthropic: 'anthropic',
  cli: 'claude-cli',
  'claude-cli': 'claude-cli',
  claude: 'claude-cli',
  deepseek: 'deepseek',
};

/**
 * Canonicalises a provider name, or null when it names nothing we have: an
 * unknown name in the environment falls back, an unknown name in a REQUEST is
 * a 400, so the callers decide.
 */
export function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_ALIASES[key] || null;
}

/** An explicit request wins, then a bare apiKey means Anthropic, then ECHO_PROVIDER, then the CLI. */
export function getProviderId(opts: ProviderOpts = {}): string {
  const explicit = normalizeProviderId(opts.provider);
  if (explicit) return explicit;
  if (opts.apiKey) return 'anthropic';
  return normalizeProviderId(process.env.ECHO_PROVIDER) || DEFAULT_PROVIDER_ID;
}

/** The facts for whichever provider this request resolves to. */
export function getProviderLimits(opts: ProviderOpts = {}): ProviderFacts {
  return PROVIDERS[getProviderId(opts)] || PROVIDERS[DEFAULT_PROVIDER_ID]!;
}

export interface PublicProvider {
  id: string;
  label: string;
  requiresKey: boolean;
  contextTokens: number;
  maxOutputTokens: number | null;
  models: string[];
  defaultModel: string | null;
  blurb: string;
  reasoning: { supported: boolean; levels: string[] };
}

/**
 * The client-facing provider list: facts only, no secrets, filtered by mode.
 * Served so the browser builds its pickers from the registry, not a copy.
 */
export function publicProviderList({ isWeb = false }: { isWeb?: boolean } = {}): PublicProvider[] {
  return Object.values(PROVIDERS)
    // A hosted instance has no local `claude`: a control that cannot work is
    // worse than an absent one.
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
      reasoning: {
        supported: !!(p.reasoning && p.reasoning.dialect),
        levels: REASONING_LEVELS,
      },
    }));
}

export interface TruncationFields {
  truncated: true;
  truncationNote: string;
}

/** The truncation fields for whichever provider this request resolves to. */
export function truncationFields(opts: ProviderOpts = {}): TruncationFields {
  const facts = getProviderLimits(opts);
  return truncationResult(facts.label, facts.maxOutputTokens);
}

/**
 * Truncation is NOT a failure: the text that arrived is real (and was already
 * on screen when streamed), so the result says `truncated: true` instead.
 */
function truncationResult(providerLabel: string, maxOutputTokens: number | null): TruncationFields {
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

/** Anthropic `stop_reason: 'max_tokens'`, OpenAI-compatible `finish_reason: 'length'`. */
export function isTruncationReason(reason: unknown): boolean {
  return reason === 'max_tokens' || reason === 'length';
}

/** The model id a DeepSeek request will use. */
export function deepseekModelFor(opts: ProviderOpts = {}): string {
  if (typeof opts.model === 'string' && opts.model.trim()) return opts.model.trim();
  return PROVIDERS.deepseek!.defaultModel!;
}

export interface SseLine {
  text?: string;
  finishReason: unknown;
  usage?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `v[key]` as JavaScript reads it off a parsed JSON value (primitives and arrays have no such field). */
function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

/** `v[0]` as JavaScript reads it: an array's first element, a string's first char, a record's "0". */
function first(v: unknown): unknown {
  // shortcut: the length checks, because `v[0]` on an empty array traps in Seshat where JavaScript gives
  // undefined (gap: index-out-of-range-traps). Plain `v[0]` once it doesn't.
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined;
  if (typeof v === 'string') return v.length > 0 ? v[0] : undefined;
  return field(v, '0');
}

/**
 * Parses one SSE line into the parts Echo cares about, or null for a line that
 * carries nothing (a comment, a keep-alive, the `[DONE]` terminator, a frame
 * that isn't JSON). The original reads fields off whatever JSON.parse gives, so
 * this walks the parsed value the same way, junk included.
 */
export function parseSseLine(line: string): SseLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    // A malformed frame is not worth failing the whole stream over.
    return null;
  }

  // The original's `json.choices` throws on a `null` frame, outside its try.
  if (json === null) throw new TypeError("Cannot read properties of null (reading 'choices')");

  // shortcut: `|| []` doesn't compile where the result is `unknown` (gap: empty-array-as-unknown), and the
  // original's `|| {}` crashes when the guard in field() reads it (gap: guard-on-object-literal-crashes), so
  // the fallback is undefined, which has the same (no) fields. `|| [] ... || {}` again once both are fixed.
  const noChoices: unknown[] = [];
  const choice = first(field(json, 'choices') || noChoices) || undefined;
  const delta = field(field(choice, 'delta'), 'content') || '';
  return {
    text: typeof delta === 'string' && delta ? delta : undefined,
    finishReason: field(choice, 'finish_reason') || null,
    // Usage arrives on a frame with an empty choices array.
    usage: field(json, 'usage') || undefined,
  };
}
