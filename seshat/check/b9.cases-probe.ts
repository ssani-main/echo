import {
  REASONING_LEVELS, PROVIDERS, DEFAULT_PROVIDER_ID, normalizeReasoningLevel, getReasoningLevel, reasoningFields,
  normalizeProviderId, getProviderId, getProviderLimits, publicProviderList, truncationFields, isTruncationReason,
  deepseekModelFor, parseSseLine,
} from '../providers.ts';
import type { ProviderOpts } from '../providers.ts';
import { out } from './out.ts';

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
    out(`parseSseLine#${i}`, parseSseLine(line));
  } catch (e) {
    const err = e as Error;
    out(`parseSseLine#${i}`, { error: `${err.name}: ${err.message}` });
  }
});
