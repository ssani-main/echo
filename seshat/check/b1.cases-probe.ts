import {
  REASONING_LEVELS, PROVIDERS, DEFAULT_PROVIDER_ID, normalizeReasoningLevel, getReasoningLevel, reasoningFields,
  normalizeProviderId, getProviderId, getProviderLimits, publicProviderList, truncationFields, isTruncationReason,
  deepseekModelFor, parseSseLine,
} from '../providers.ts';
import type { ProviderOpts } from '../providers.ts';
import { out } from './out.ts';

out('REASONING_LEVELS', REASONING_LEVELS);
out('PROVIDERS', PROVIDERS);
out('DEFAULT_PROVIDER_ID', DEFAULT_PROVIDER_ID);

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
