import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTags } from '../digest.js';
import { ApiKeyProvider } from '../providers.js';

// ---------------------------------------------------------------------------
// suggestTags
//
// suggestTags() routes through callProvider() -> getProvider(opts).call(),
// and getProvider() returns ApiKeyProvider whenever opts.apiKey is supplied
// (see providers.js). So supplying a dummy apiKey lets us intercept the
// provider call by mocking ApiKeyProvider.call directly — the same technique
// used in tests/provider-error-mapping.test.js — without spawning the real
// `claude` CLI or hitting the network. t.mock.method auto-restores the
// original implementation once each test completes.
// ---------------------------------------------------------------------------

function fakeUsage() {
  return {
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 120,
    durationMs: 5,
  };
}

test('suggestTags: well-formed model JSON is normalized (trimmed, lowercased, deduped, capped to 5)', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: JSON.stringify({
      tags: [' Machine Learning ', 'AI', 'ai', 'Neural Networks', 'Deep Learning', 'Extra Tag', 'One More'],
    }),
    usage: fakeUsage(),
  }));

  const { tags, usage } = await suggestTags('a digest about machine learning', { apiKey: 'sk-test' });

  assert.deepEqual(tags, ['machine learning', 'ai', 'neural networks', 'deep learning', 'extra tag']);
  assert.equal(tags.length, 5);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
});

test('suggestTags: drops empty/overlong tags during normalization', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: JSON.stringify({
      tags: ['', '   ', 'valid tag', 'x'.repeat(41), 'y'.repeat(40)],
    }),
    usage: fakeUsage(),
  }));

  const { tags } = await suggestTags('some material', { apiKey: 'sk-test' });

  assert.deepEqual(tags, ['valid tag', 'y'.repeat(40)]);
});

test('suggestTags: malformed model output (non-JSON) returns {tags: []} without throwing', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: 'Sorry, here are some thoughts but not JSON at all.',
    usage: fakeUsage(),
  }));

  const { tags, usage } = await suggestTags('some material', { apiKey: 'sk-test' });

  assert.deepEqual(tags, []);
  assert.equal(usage.inputTokens, 100);
});

test('suggestTags: JSON without a tags array returns {tags: []} without throwing', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => ({
    result: JSON.stringify({ notTags: ['a', 'b'] }),
    usage: fakeUsage(),
  }));

  const { tags } = await suggestTags('some material', { apiKey: 'sk-test' });

  assert.deepEqual(tags, []);
});

test('suggestTags: throws for empty/whitespace-only material (genuine input error, not a provider failure)', async () => {
  await assert.rejects(() => suggestTags('', { apiKey: 'sk-test' }));
  await assert.rejects(() => suggestTags('   ', { apiKey: 'sk-test' }));
});

test('suggestTags: propagates a genuine provider/auth error rather than swallowing it', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async () => {
    const e = new Error('Anthropic API authentication failed.');
    e.echoCode = 'API_NOT_AUTHED';
    throw e;
  });

  await assert.rejects(
    () => suggestTags('some material', { apiKey: 'sk-test' }),
    (err) => {
      assert.equal(err.echoCode, 'API_NOT_AUTHED');
      return true;
    }
  );
});

test('suggestTags: very long material is truncated before prompting and does not crash', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['long content'] }), usage: fakeUsage() };
  });

  // Far longer than the internal 6000-char cap.
  const longMaterial = 'word '.repeat(50_000);
  const { tags } = await suggestTags(longMaterial, { apiKey: 'sk-test' });

  assert.deepEqual(tags, ['long content']);
  // The prompt sent to the provider should not contain the full 250k-char
  // material — it must have been truncated well below the original length.
  assert.ok(capturedPrompt.length < longMaterial.length);
});
