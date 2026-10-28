import {
  REASONING_LEVELS, PROVIDERS, DEFAULT_PROVIDER_ID, normalizeReasoningLevel, getReasoningLevel, reasoningFields,
  normalizeProviderId, getProviderId, getProviderLimits, publicProviderList, truncationFields, isTruncationReason,
  deepseekModelFor, parseSseLine,
} from '../providers.ts';
import type { ProviderOpts } from '../providers.ts';
import { out } from './out.ts';

// Not in the corpus on purpose: 'constructor' and '__proto__'. The original looks them up on a
// plain object and returns Object.prototype members (see PORT.md, found in Echo itself); the port returns null.

out('REASONING_LEVELS', REASONING_LEVELS);
out('PROVIDERS', PROVIDERS);
out('DEFAULT_PROVIDER_ID', DEFAULT_PROVIDER_ID);

const names: unknown[] = [
  'api', 'anthropic', 'cli', 'claude-cli', 'claude', 'deepseek', ' DeepSeek ', 'CLI', 'openai', '', '   ', 'İ', 'ＡＰＩ',
  'off', 'on', 'enabled', 'true', 'false', 'disabled', 'none', 'low', 'medium', 'high', 'HIGH', ' Medium ', 'max', 'Ⅰ',
  null, undefined, 42, true,
];
names.forEach((n, i) => out(`normalizeProviderId#${i}`, normalizeProviderId(n)));
names.forEach((n, i) => out(`normalizeReasoningLevel#${i}`, normalizeReasoningLevel(n)));

const optsList: ProviderOpts[] = [
  {}, { provider: 'deepseek' }, { provider: 'api' }, { provider: 'nope' }, { apiKey: 'sk-ant-x' },
  { apiKey: '' }, { provider: 'cli', apiKey: 'sk' }, { provider: 'deepseek', apiKey: 'sk' }, { provider: 42, apiKey: 'sk' },
  { reasoning: 'high' }, { reasoning: 'on', provider: 'anthropic' }, { reasoning: 'low', provider: 'deepseek' },
  { reasoning: 'medium', apiKey: 'sk' }, { reasoning: 'off', provider: 'deepseek' }, { reasoning: 'bogus', provider: 'anthropic' },
  { model: ' deepseek-v4-pro ' }, { model: '   ' }, { model: 7 },
];
optsList.forEach((o, i) => {
  out(`getProviderId#${i}`, getProviderId(o));
  out(`getProviderLimits#${i}`, getProviderLimits(o).id);
  out(`getReasoningLevel#${i}`, getReasoningLevel(o));
  out(`reasoningFields#${i}`, reasoningFields(o));
  for (const id of ['claude-cli', 'anthropic', 'deepseek', 'nope']) out(`reasoningFields#${i}/${id}`, reasoningFields(o, id));
  out(`truncationFields#${i}`, truncationFields(o));
  out(`deepseekModelFor#${i}`, deepseekModelFor(o));
});
out('getProviderId()', getProviderId());
out('reasoningFields()', reasoningFields());

out('publicProviderList()', publicProviderList());
out('publicProviderList(web)', publicProviderList({ isWeb: true }));
out('publicProviderList(local)', publicProviderList({ isWeb: false }));

const reasons: unknown[] = ['max_tokens', 'length', 'end_turn', 'stop', 'MAX_TOKENS', '', null, undefined, 0];
reasons.forEach((r, i) => out(`isTruncationReason#${i}`, isTruncationReason(r)));

const sseLines = [
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  'data:{"choices":[{"delta":{"content":" world"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}',
  'data: {"choices":[{"delta":{"reasoning_content":"PRIVATE DELIBERATION"}}]}',
  'data: [DONE]', 'data:', ': keep-alive', '', '   ', 'event: token', 'data: not json', 'data: {"broken": ',
  '  data: {"choices":[{"delta":{"content":"padded"}}]}  ',
  'data: {"choices":"abc"}', 'data: {"choices":{"0":{"delta":{"content":"keyed"}}}}', 'data: {"choices":[null]}',
  'data: {"choices":[{"delta":"str","finish_reason":0}]}', 'data: {"choices":[{"delta":{"content":42}}]}',
  'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}', 'data: 5', 'data: "str"', 'data: []', 'data: true',
  'data: {"usage":0}', 'data: {"choices":[{"delta":{"content":"😀 \\ud83d"}}]}',
  'data: null',
];
sseLines.forEach((line, i) => {
  try {
    const parsed = parseSseLine(line);
    // shortcut: an absent `usage` (an optional `unknown`) serialises as null in Seshat (gap:
    // json-undefined-unknown-field), so it is printed without the field then. Print `parsed` once fixed.
    if (parsed && parsed.usage === undefined) out(`parseSseLine#${i}`, { text: parsed.text, finishReason: parsed.finishReason });
    else out(`parseSseLine#${i}`, parsed);
  } catch (e) {
    const err = e as Error;
    out(`parseSseLine#${i}`, { error: `${err.name}: ${err.message}` });
  }
});
