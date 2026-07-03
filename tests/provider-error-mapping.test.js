import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { ApiKeyProvider } from '../providers.js';

// ---------------------------------------------------------------------------
// ApiKeyProvider / mapAnthropicError coverage.
//
// mapAnthropicError() itself is not exported from providers.js, so it is
// exercised indirectly through ApiKeyProvider.call(), which is the only
// reachable surface. To reach the SDK error-mapping branches (401/429/other)
// WITHOUT making a real network call, we monkey-patch the shared
// `Messages.prototype.create` method (the Anthropic SDK builds
// `client.messages` as an instance of a shared `Messages` class, so patching
// its prototype intercepts every `messages.create()` call regardless of
// which client instance made it). `t.mock.method` auto-restores the original
// implementation once each test completes, so no manual cleanup is needed
// and no other test file is affected.
//
// The one branch that IS reachable without any mocking at all is the
// "no API key supplied" case: ApiKeyProvider.call() throws API_NOT_AUTHED
// before it ever touches the network or constructs a client.
// ---------------------------------------------------------------------------

// Grab a reference to the shared Messages prototype so it can be patched.
// Constructing a throwaway client with a dummy key performs no network I/O
// (the SDK constructor just validates config).
const throwawayClient = new Anthropic({ apiKey: 'dummy-key-for-prototype-access' });
const messagesProto = Object.getPrototypeOf(throwawayClient.messages);

function fakeAnthropicResponse({
  text = 'summarized output',
  inputTokens = 100,
  outputTokens = 50,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// No API key -> API_NOT_AUTHED (reachable with zero mocking, zero network)
// ---------------------------------------------------------------------------

test('ApiKeyProvider.call: no apiKey (env or opts) throws API_NOT_AUTHED without contacting the network', async () => {
  const originalEnvKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => ApiKeyProvider.call('a prompt', {}),
      (err) => {
        assert.equal(err.echoCode, 'API_NOT_AUTHED');
        assert.equal(typeof err.message, 'string');
        assert.equal(typeof err.hint, 'string');
        return true;
      }
    );
  } finally {
    if (originalEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnvKey;
  }
});

test('ApiKeyProvider.call: whitespace-only apiKey is treated as missing -> API_NOT_AUTHED', async () => {
  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: '   ' }),
    (err) => {
      assert.equal(err.echoCode, 'API_NOT_AUTHED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// SDK error mapping — status 401 -> API_NOT_AUTHED
// ---------------------------------------------------------------------------

test('ApiKeyProvider.call: SDK error with status 401 maps to API_NOT_AUTHED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  });

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_NOT_AUTHED');
      assert.match(err.message, /authentication/i);
      assert.equal(typeof err.hint, 'string');
      assert.ok(err.hint.length > 0);
      return true;
    }
  );
});

test('ApiKeyProvider.call: SDK error named AuthenticationError (no status) maps to API_NOT_AUTHED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    const e = new Error('bad creds');
    e.name = 'AuthenticationError';
    throw e;
  });

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_NOT_AUTHED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// SDK error mapping — status 429 -> API_RATE_LIMITED
// ---------------------------------------------------------------------------

test('ApiKeyProvider.call: SDK error with status 429 maps to API_RATE_LIMITED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    throw Object.assign(new Error('too many requests'), { status: 429 });
  });

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_RATE_LIMITED');
      assert.match(err.message, /rate limit/i);
      assert.equal(typeof err.hint, 'string');
      assert.ok(err.hint.length > 0);
      return true;
    }
  );
});

test('ApiKeyProvider.call: SDK error named RateLimitError (no status) maps to API_RATE_LIMITED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    const e = new Error('slow down');
    e.name = 'RateLimitError';
    throw e;
  });

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_RATE_LIMITED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// SDK error mapping — anything else -> generic API_FAILED
// ---------------------------------------------------------------------------

test('ApiKeyProvider.call: unrecognized SDK error (e.g. 500) maps to generic API_FAILED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    throw Object.assign(new Error('internal server error'), { status: 500 });
  });
  // mapAnthropicError() logs unrecognized errors via console.error — silence
  // that expected log line so the test's own output stays readable.
  t.mock.method(console, 'error', () => {});

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_FAILED');
      assert.equal(typeof err.hint, 'string');
      assert.ok(err.hint.length > 0);
      return true;
    }
  );
});

test('ApiKeyProvider.call: SDK error with no status/name at all maps to generic API_FAILED', async (t) => {
  t.mock.method(messagesProto, 'create', async () => {
    throw new Error('mystery failure');
  });
  t.mock.method(console, 'error', () => {});

  await assert.rejects(
    () => ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' }),
    (err) => {
      assert.equal(err.echoCode, 'API_FAILED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Success path — usage/cost normalization (sonnet default pricing)
// ---------------------------------------------------------------------------

test('ApiKeyProvider.call: success response normalizes token usage and computes costUsd (sonnet default)', async (t) => {
  t.mock.method(messagesProto, 'create', async () =>
    fakeAnthropicResponse({ text: 'the digest', inputTokens: 1000, outputTokens: 500 })
  );

  const { result, usage } = await ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' });

  assert.equal(result, 'the digest');
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.outputTokens, 500);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.cacheCreationTokens, 0);
  assert.equal(usage.totalTokens, 1500);
  assert.equal(typeof usage.durationMs, 'number');
  assert.ok(usage.durationMs >= 0);

  // sonnet pricing: input $3/1M, output $15/1M
  const expectedCost = (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15;
  assert.ok(Math.abs(usage.costUsd - expectedCost) < 1e-9);
});

test('ApiKeyProvider.call: success response applies opus pricing when opts.model === "opus"', async (t) => {
  t.mock.method(messagesProto, 'create', async () =>
    fakeAnthropicResponse({ text: 'opus output', inputTokens: 1000, outputTokens: 500 })
  );

  const { usage } = await ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key', model: 'opus' });

  // opus pricing: input $5/1M, output $25/1M
  const expectedCost = (1000 / 1_000_000) * 5 + (500 / 1_000_000) * 25;
  assert.ok(Math.abs(usage.costUsd - expectedCost) < 1e-9);
});

test('ApiKeyProvider.call: cache-read tokens are billed at 0.1x input rate and cache-creation at 1.25x input rate', async (t) => {
  t.mock.method(messagesProto, 'create', async () =>
    fakeAnthropicResponse({
      text: 'cached run',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    })
  );

  const { usage } = await ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' });

  assert.equal(usage.totalTokens, 2_000_000);
  // sonnet input rate = $3/1M -> cache-read = 0.1 * 3 = $0.3, cache-creation = 1.25 * 3 = $3.75
  const expectedCost = 3 * 0.1 + 3 * 1.25;
  assert.ok(Math.abs(usage.costUsd - expectedCost) < 1e-9);
});

test('ApiKeyProvider.call: only text content blocks are concatenated into result, other block types are dropped', async (t) => {
  t.mock.method(messagesProto, 'create', async () => ({
    content: [
      { type: 'text', text: 'first ' },
      { type: 'tool_use', input: { ignored: true } },
      { type: 'text', text: 'second' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));

  const { result } = await ApiKeyProvider.call('a prompt', { apiKey: 'sk-test-key' });
  assert.equal(result, 'first second');
});
