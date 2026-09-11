import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  normalizeProviderId,
  getProviderId,
  getProviderLimits,
  getProvider,
  publicProviderList,
  isTruncationReason,
  truncationFields,
  parseSseLine,
  validateApiKey,
  deepseekModelFor,
  REASONING_LEVELS,
  normalizeReasoningLevel,
  getReasoningLevel,
  reasoningFields,
  DeepSeekProvider,
  ApiKeyProvider,
  ClaudeCliProvider,
} from '../providers.js';
import { generateDigest, thresholdCharsFor, chunkBudgetCharsFor } from '../digest.js';

// ---------------------------------------------------------------------------
// The provider seam: a registry, a second API provider, and truncation.
//
// Three things are being proved here, in order of how badly they would hurt if
// they were wrong:
//
//   1. LIMITS DO NOT LEAK BETWEEN PROVIDERS. A max-output cap that was literal
//      in one provider is inherited by the next one silently, and a response cut
//      off at that cap used to be returned as a plain success.
//   2. TRUNCATION IS NOW VISIBLE. Every finish reason the two APIs use is read,
//      on both the buffered and the streaming path, and it survives all the way
//      out of generateDigest() — including when it happens inside the map phase
//      of a long transcript, where the lost content is not even at the end.
//   3. THE DEEPSEEK REQUEST IS CORRECT WITHOUT A NETWORK. Its whole HTTP surface
//      is exercised against a stubbed global fetch, including an SSE frame split
//      across a chunk boundary, which is the part of streaming that breaks in
//      production and cannot be caught by eye.
//
// No test here makes a real API call, and none of them needs a key.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry + resolution
// ---------------------------------------------------------------------------

test('every provider declares the facts the seam depends on', () => {
  const required = ['id', 'label', 'kind', 'requiresKey', 'contextTokens', 'charsPerToken', 'blurb'];
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, key, `${key}: id must match its registry key`);
    for (const field of required) {
      assert.ok(p[field] !== undefined && p[field] !== null, `${key}: missing ${field}`);
    }
    assert.equal(typeof p.requiresKey, 'boolean', `${key}: requiresKey must be a boolean`);
    assert.ok(p.contextTokens > 0, `${key}: contextTokens must be positive`);
    // null is meaningful (no knob / not asserted), undefined is a typo.
    assert.ok(p.maxOutputTokens === null || p.maxOutputTokens > 0, `${key}: maxOutputTokens`);
  }
});

test('limits are per provider, not inherited', () => {
  // The literal this replaced. It must stay exactly as it was for Anthropic,
  // because raising it is a behaviour change, not a bug fix.
  assert.equal(PROVIDERS.anthropic.maxOutputTokens, 16_000);

  // And the next provider down must NOT have silently picked it up — that
  // inheritance is the bug this registry exists to prevent.
  assert.notEqual(PROVIDERS.deepseek.maxOutputTokens, 16_000);
  assert.notEqual(PROVIDERS['claude-cli'].maxOutputTokens, 16_000);

  // A larger window must produce a larger chunk budget, or the whole
  // provider-aware geometry is decorative.
  assert.ok(PROVIDERS.deepseek.contextTokens > PROVIDERS.anthropic.contextTokens);
});

test('normalizeProviderId accepts the names already in the wild, and rejects the rest', () => {
  // ECHO_PROVIDER=api predates DeepSeek and must keep meaning Anthropic.
  assert.equal(normalizeProviderId('api'), 'anthropic');
  assert.equal(normalizeProviderId('API'), 'anthropic');
  assert.equal(normalizeProviderId('  cli '), 'claude-cli');
  assert.equal(normalizeProviderId('anthropic'), 'anthropic');
  assert.equal(normalizeProviderId('deepseek'), 'deepseek');
  assert.equal(normalizeProviderId(''), null);
  assert.equal(normalizeProviderId('   '), null);
  assert.equal(normalizeProviderId('gpt-5'), null);
  assert.equal(normalizeProviderId(undefined), null);
  assert.equal(normalizeProviderId(42), null);
});

test('getProviderId: explicit request wins, a bare key still means Anthropic, env comes third', () => {
  const saved = process.env.ECHO_PROVIDER;
  try {
    delete process.env.ECHO_PROVIDER;

    // The untouched local default.
    assert.equal(getProviderId({}), DEFAULT_PROVIDER_ID);
    assert.equal(DEFAULT_PROVIDER_ID, 'claude-cli');

    // Back-compat: every pre-existing caller sends a key and nothing else.
    assert.equal(getProviderId({ apiKey: 'sk-ant-xyz' }), 'anthropic');

    // An explicit name beats both the key heuristic and the environment.
    assert.equal(getProviderId({ provider: 'deepseek', apiKey: 'sk-ant-xyz' }), 'deepseek');
    assert.equal(getProviderId({ provider: 'cli', apiKey: 'sk-ant-xyz' }), 'claude-cli');

    // A typo in the environment falls back rather than changing the provider.
    process.env.ECHO_PROVIDER = 'deepseek';
    assert.equal(getProviderId({}), 'deepseek');
    assert.equal(getProviderId({ provider: 'anthropic' }), 'anthropic');
    process.env.ECHO_PROVIDER = 'not-a-provider';
    assert.equal(getProviderId({}), DEFAULT_PROVIDER_ID);
  } finally {
    if (saved === undefined) delete process.env.ECHO_PROVIDER;
    else process.env.ECHO_PROVIDER = saved;
  }
});

test('getProvider returns the implementation for the resolved id, with a call method', () => {
  assert.equal(getProvider({}), ClaudeCliProvider);
  assert.equal(getProvider({ provider: 'anthropic' }), ApiKeyProvider);
  assert.equal(getProvider({ provider: 'deepseek' }), DeepSeekProvider);
  for (const p of [ClaudeCliProvider, ApiKeyProvider, DeepSeekProvider]) {
    assert.equal(typeof p.call, 'function');
    assert.equal(typeof p.stream, 'function');
  }
});

test('getProviderLimits always answers, for any input', () => {
  assert.equal(getProviderLimits({ provider: 'deepseek' }).id, 'deepseek');
  assert.equal(getProviderLimits({}).id, DEFAULT_PROVIDER_ID);
  // Never throws, never undefined — chunking depends on this.
  assert.ok(getProviderLimits({ provider: 'nonsense' }).contextTokens > 0);
});

test('publicProviderList withholds the CLI from a hosted instance and offers it locally', () => {
  const local = publicProviderList({ isWeb: false });
  const web = publicProviderList({ isWeb: true });
  const localIds = local.map((p) => p.id);
  const webIds = web.map((p) => p.id);

  assert.ok(localIds.includes('claude-cli'), 'local mode must offer the keyless CLI');
  assert.ok(localIds.includes('deepseek'));
  assert.ok(webIds.includes('anthropic'));

  // A hosted box has no `claude` binary — offering it would be a control that
  // cannot work, which this codebase treats as worse than an absent one.
  assert.ok(!webIds.includes('claude-cli'), 'web mode must not offer a CLI it cannot run');

  // Facts only — nothing that could carry a secret. Checked by field NAME, not
  // by grepping for the word "key", which matches `requiresKey` and would make
  // this assertion useless.
  for (const p of [...local, ...web]) {
    for (const forbidden of ['apiKey', 'key', 'secret', 'authorization', 'token']) {
      assert.ok(!(forbidden in p), `${p.id}: must not expose a ${forbidden} field`);
    }
  }
});

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

test('isTruncationReason knows both APIs\' spelling of "I hit the ceiling"', () => {
  assert.equal(isTruncationReason('max_tokens'), true); // Anthropic
  assert.equal(isTruncationReason('length'), true);     // OpenAI-compatible
  assert.equal(isTruncationReason('end_turn'), false);
  assert.equal(isTruncationReason('stop'), false);
  assert.equal(isTruncationReason(null), false);
  assert.equal(isTruncationReason(undefined), false);
});

test('truncationFields names the provider and its actual limit', () => {
  const anthropic = truncationFields({ provider: 'anthropic' });
  assert.equal(anthropic.truncated, true);
  assert.match(anthropic.truncationNote, /Anthropic API/);
  assert.match(anthropic.truncationNote, /16,000/);

  // And it must describe the OTHER provider's limit when that is what ran,
  // not Anthropic's — the note is the only thing telling the user what to do.
  const deepseek = truncationFields({ provider: 'deepseek' });
  assert.match(deepseek.truncationNote, /DeepSeek API/);
});

// Shared with the pattern tests/provider-error-mapping.test.js established: the
// SDK builds `client.messages` from a shared class, so patching its prototype
// intercepts every client instance, and t.mock restores it afterwards.
const throwawayClient = new Anthropic({ apiKey: 'dummy-key-for-prototype-access' });
const messagesProto = Object.getPrototypeOf(throwawayClient.messages);

function fakeAnthropicResponse({ text = 'digest text', stopReason = 'end_turn' } = {}) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test('ApiKeyProvider.call: stop_reason max_tokens comes back as truncated, not as success', async (t) => {
  t.mock.method(messagesProto, 'create', async () => fakeAnthropicResponse({ stopReason: 'max_tokens' }));

  const res = await ApiKeyProvider.call('prompt', { apiKey: 'sk-test' });
  assert.equal(res.truncated, true);
  assert.match(res.truncationNote, /incomplete/);
  // The partial text is still returned. Discarding real work because it is
  // incomplete is the failure mode this whole change exists to avoid.
  assert.equal(res.result, 'digest text');
});

test('ApiKeyProvider.call: a normal stop_reason carries no truncation fields', async (t) => {
  t.mock.method(messagesProto, 'create', async () => fakeAnthropicResponse({ stopReason: 'end_turn' }));

  const res = await ApiKeyProvider.call('prompt', { apiKey: 'sk-test' });
  assert.equal(res.truncated, undefined);
  assert.equal(res.truncationNote, undefined);
});

test('ApiKeyProvider.send max_tokens is the registry\'s number, not a literal in the call site', async (t) => {
  let sent = null;
  t.mock.method(messagesProto, 'create', async (body) => {
    sent = body;
    return fakeAnthropicResponse();
  });

  await ApiKeyProvider.call('prompt', { apiKey: 'sk-test' });
  assert.equal(sent.max_tokens, PROVIDERS.anthropic.maxOutputTokens);
  assert.equal(sent.max_tokens, 16_000);
});

// ---------------------------------------------------------------------------
// DeepSeek over a stubbed fetch
// ---------------------------------------------------------------------------

/**
 * Replaces global fetch for one test. The provider calls a bare `fetch`, so a
 * global patch is enough and needs no injection seam in production code.
 */
function stubFetch(t, handler) {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => handler(String(url), init));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEEPSEEK_OK = {
  choices: [{ message: { content: 'a deepseek digest' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 40 },
};

test('the DeepSeek model id is the DOCUMENTED one, because a wrong name is a 400 at digest time', () => {
  // Not a tautology: the first version of this file defaulted to 'deepseek-chat',
  // the retired OpenAI-compatible alias, which docs.deepseek.com does not list.
  // Nothing at build time or in any other test would have caught that — only a
  // real request would, as a rejection.
  //
  // Pinned on purpose. If DeepSeek renames again, this failing IS the feature:
  // it points at the one line to change, instead of surfacing as an
  // unexplained error in the digest card.
  const documented = ['deepseek-flash', 'deepseek-v4-pro'];
  const configured = (process.env.ECHO_DEEPSEEK_MODEL || '').trim();

  // The registry reads the env at module load, so a developer who configured a
  // model must not see this fail for a reason that is not a code change.
  if (configured) {
    assert.equal(deepseekModelFor({}), configured, 'ECHO_DEEPSEEK_MODEL must win');
  } else {
    assert.ok(
      documented.includes(deepseekModelFor({})),
      `default DeepSeek model ${deepseekModelFor({})} is not one of the documented ids (${documented.join(', ')})`
    );
    assert.equal(deepseekModelFor({}), 'deepseek-flash');
    // ...and `deepseek-flash` IS V4.1 Flash. That is the whole subtlety: the wire
    // id and the product name are different strings, so "which model am I using?"
    // cannot be answered by looking at the UI label alone.
    assert.equal(PROVIDERS.deepseek.defaultModel, 'deepseek-flash');
  }

  // An explicit model still wins.
  assert.equal(deepseekModelFor({ model: 'deepseek-v4-pro' }), 'deepseek-v4-pro');
  assert.equal(deepseekModelFor({ model: '  ' }), 'deepseek-flash');
});

test('the DeepSeek request sends the resolved model id, not a literal', async (t) => {
  let sent = null;
  stubFetch(t, (_url, init) => {
    sent = JSON.parse(init.body);
    return jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  await DeepSeekProvider.call('p', { apiKey: 'k' });
  assert.equal(sent.model, 'deepseek-flash');
});

test('the DeepSeek output ceiling is a measured number, not the API default', () => {
  // Regression guard for a data-loss bug found by the A/B rather than by a test:
  // with max_tokens omitted, a long article truncated at 6 552 words.
  assert.equal(PROVIDERS.deepseek.maxOutputTokens, 384_000);
  assert.notEqual(PROVIDERS.deepseek.maxOutputTokens, null);
  // And it must be well clear of Anthropic's 16 000 — inheriting that is the
  // original bug class this registry exists to prevent.
  assert.ok(PROVIDERS.deepseek.maxOutputTokens > PROVIDERS.anthropic.maxOutputTokens * 10);
});

test('DeepSeekProvider.call: no key is API_NOT_AUTHED without touching the network', async (t) => {
  const saved = [process.env.ECHO_DEEPSEEK_API_KEY, process.env.DEEPSEEK_API_KEY];
  delete process.env.ECHO_DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let called = false;
  stubFetch(t, () => { called = true; return jsonResponse(DEEPSEEK_OK); });
  try {
    await assert.rejects(
      () => DeepSeekProvider.call('a prompt', {}),
      (err) => {
        assert.equal(err.echoCode, 'API_NOT_AUTHED');
        assert.match(err.hint, /DeepSeek API key/);
        return true;
      }
    );
    assert.equal(called, false, 'a missing key must fail before any request is made');
  } finally {
    if (saved[0] !== undefined) process.env.ECHO_DEEPSEEK_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.DEEPSEEK_API_KEY = saved[1];
  }
});

test('DeepSeekProvider.call: builds an OpenAI-shaped request — bearer auth, and the measured max_tokens', async (t) => {
  let seenUrl = '';
  let seenInit = null;
  stubFetch(t, (url, init) => { seenUrl = url; seenInit = init; return jsonResponse(DEEPSEEK_OK); });

  const res = await DeepSeekProvider.call('summarise this', { apiKey: 'ds-key-123' });

  assert.match(seenUrl, /\/chat\/completions$/, 'must hit the chat completions path');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers.Authorization, 'Bearer ds-key-123');

  const body = JSON.parse(seenInit.body);
  assert.equal(body.model, PROVIDERS.deepseek.defaultModel);
  assert.equal(body.stream, false);
  // The prompt goes in as a single user message, matching the Anthropic API
  // path — a system message here would make a provider comparison measure the
  // prompt change as well as the model.
  assert.deepEqual(body.messages, [{ role: 'user', content: 'summarise this' }]);

  // INVERTED from the first version of this test, which asserted max_tokens was
  // absent ("must not be invented"). That was wrong, and the provider A/B found
  // out how: omitting it hands the decision to the API's DEFAULT ceiling, which
  // is far below the model's maximum — an `article`-mode digest of a
  // 71 627-char transcript came back `finish_reason: 'length'` at 6 552 words.
  // Now it is always sent, from the registry, and the number is one the live API
  // accepted rather than one invented here.
  assert.equal(body.max_tokens, PROVIDERS.deepseek.maxOutputTokens);
  assert.equal(body.max_tokens, 384_000);

  assert.equal(res.result, 'a deepseek digest');
  assert.equal(res.usage.inputTokens, 120);
  assert.equal(res.usage.outputTokens, 40);
  assert.equal(res.usage.totalTokens, 160);
  // No published rate is hardcoded, so cost is null rather than a guess.
  // null specifically: mergeUsage() sums with +=, so undefined would poison a
  // multi-chunk digest's total into NaN.
  assert.equal(res.usage.costUsd, null);
});

test('DeepSeekProvider.call: an explicit model overrides the default', async (t) => {
  let body = null;
  stubFetch(t, (_url, init) => { body = JSON.parse(init.body); return jsonResponse(DEEPSEEK_OK); });

  await DeepSeekProvider.call('p', { apiKey: 'k', model: 'deepseek-reasoner' });
  assert.equal(body.model, 'deepseek-reasoner');
});

test('DeepSeekProvider.call: finish_reason length is truncation', async (t) => {
  stubFetch(t, () => jsonResponse({
    choices: [{ message: { content: 'cut off mid' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 9 },
  }));

  const res = await DeepSeekProvider.call('p', { apiKey: 'k' });
  assert.equal(res.truncated, true);
  assert.match(res.truncationNote, /DeepSeek API/);
  assert.equal(res.result, 'cut off mid');
});

test('DeepSeekProvider.call: HTTP failures map onto the shared error vocabulary', async (t) => {
  const cases = [
    [401, 'API_NOT_AUTHED', /authentication/i],
    [403, 'API_NOT_AUTHED', /authentication/i],
    [429, 'API_RATE_LIMITED', /rate limit/i],
    // 402 is a different thing from a bad key: the key is fine, the balance is
    // empty, and retrying never fixes it. It says so.
    [402, 'API_NOT_AUTHED', /balance/i],
    [500, 'API_FAILED', /check the terminal/i],
  ];

  for (const [status, code, pattern] of cases) {
    await t.test(`status ${status} -> ${code}`, async (t2) => {
      stubFetch(t2, () => new Response('{"error":"nope"}', { status }));
      await assert.rejects(
        () => DeepSeekProvider.call('p', { apiKey: 'k' }),
        (err) => {
          assert.equal(err.echoCode, code);
          // Both fields together: the short diagnosis lives in `message` and the
          // remedy in `hint`, so testing only one of them tests half the user's
          // experience.
          assert.match(`${err.message} ${err.hint || ''}`, pattern);
          // The API's own words must survive into `detail`, or the error card's
          // disclosure has nothing real to show.
          assert.ok(err.detail, 'expected the response body in detail');
          return true;
        }
      );
    });
  }
});

test('DeepSeekProvider.call: a non-JSON body is API_FAILED, not a crash', async (t) => {
  stubFetch(t, () => new Response('<html>proxy error</html>', { status: 200 }));
  await assert.rejects(
    () => DeepSeekProvider.call('p', { apiKey: 'k' }),
    (err) => {
      assert.equal(err.echoCode, 'API_FAILED');
      return true;
    }
  );
});

test('parseSseLine reads deltas, finish reasons and usage, and ignores everything else', () => {
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}'), {
    text: 'hi', finishReason: null, usage: undefined,
  });
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}'), {
    text: undefined, finishReason: 'length', usage: undefined,
  });
  // Usage arrives on a frame whose choices array is EMPTY, so it cannot be
  // reached through choices[0] — reading it only from the choice loses it.
  const withUsage = parseSseLine('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}');
  assert.equal(withUsage.usage.prompt_tokens, 7);
  assert.equal(withUsage.finishReason, null);

  // Not ours to understand — none of these may throw.
  assert.equal(parseSseLine('data: [DONE]'), null);
  assert.equal(parseSseLine(': keep-alive'), null);
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine('event: message'), null);
  assert.equal(parseSseLine('data: {not json'), null);
});

/**
 * A Response whose body arrives in the exact chunks given — the point being
 * that an SSE frame CAN and does get split mid-line by the network.
 */
function sseResponse(chunks, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

test('DeepSeekProvider.stream: deltas stream out, and a frame split across chunks is reassembled', async (t) => {
  // These are byte-exact, deliberately awkward cuts: one mid-JSON, one between
  // the "\n" and its "\r", one finishing a frame in the next chunk.
  stubFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\ndata: {"choices":[{"delta":{"content":" wor',
    'ld"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n',
    'data: [DONE]\n',
  ]));

  const tokens = [];
  const res = await DeepSeekProvider.stream('p', { apiKey: 'k' }, (t2) => tokens.push(t2));

  assert.deepEqual(tokens, ['Hello', ' world'], 'each delta must be handed over as it arrives');
  assert.equal(res.result, 'Hello world', 'the assembled text must equal the sum of the deltas');
  assert.equal(res.usage.inputTokens, 11);
  assert.equal(res.usage.outputTokens, 4);
  assert.equal(res.truncated, undefined);
});

test('DeepSeekProvider.stream: a truncated stream is flagged even though text already streamed', async (t) => {
  stubFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
    'data: [DONE]\n',
  ]));

  const res = await DeepSeekProvider.stream('p', { apiKey: 'k' }, () => {});
  assert.equal(res.truncated, true);
  // The text the user already watched appear must survive the warning.
  assert.equal(res.result, 'partial answer');
});

test('DeepSeekProvider.stream: a final frame with no trailing newline is not dropped', async (t) => {
  // Cut off before the terminator's newline — a real socket close can do this.
  stubFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"tail"}}]}\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}',
  ]));

  const res = await DeepSeekProvider.stream('p', { apiKey: 'k' }, () => {});
  assert.equal(res.result, 'tail');
  assert.equal(res.truncated, true, 'the finish reason in that last frame must still be read');
});

test('DeepSeekProvider.stream: a response with no readable stream still resolves', async (t) => {
  // Some proxies buffer a stream into a single body. Degrading to the buffered
  // parse is correct; failing would be a regression against a working request.
  stubFetch(t, () => new Response(
    'data: {"choices":[{"delta":{"content":"buffered"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  ));

  const res = await DeepSeekProvider.stream('p', { apiKey: 'k' }, () => {});
  assert.equal(res.result, 'buffered');
});

test('validateApiKey: routes to the right vendor for each provider', async (t) => {
  const calls = [];
  stubFetch(t, (url) => {
    calls.push(url);
    if (url.includes('deepseek')) return Response.json({ object: 'list', data: [] });
    return Response.json({ data: [] });
  });

  await validateApiKey('ds-key', 'deepseek');
  assert.ok(calls[0].includes('/models'), `expected DeepSeek /models, got ${calls[0]}`);
  assert.ok(calls[0].includes('api.deepseek.com'));
});

test('validateApiKey: a DeepSeek 401 is reported as an auth failure', async (t) => {
  stubFetch(t, () => new Response('{"error":"Authentication Fails"}', { status: 401 }));
  await assert.rejects(
    () => validateApiKey('bad-key', 'deepseek'),
    (err) => {
      assert.equal(err.echoCode, 'API_NOT_AUTHED');
      return true;
    }
  );
});

test('validateApiKey: an empty key is refused before any request', async (t) => {
  let called = false;
  stubFetch(t, () => { called = true; return Response.json({}); });
  await assert.rejects(() => validateApiKey('   ', 'deepseek'), (err) => {
    assert.equal(err.echoCode, 'API_NOT_AUTHED');
    return true;
  });
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Reasoning: one vocabulary, two dialects, and no leaking into the digest
// ---------------------------------------------------------------------------

test('normalizeReasoningLevel accepts a level, treats "on" as the top of the scale, and rejects nonsense', () => {
  assert.equal(normalizeReasoningLevel('off'), 'off');
  assert.equal(normalizeReasoningLevel('LOW'), 'low');
  assert.equal(normalizeReasoningLevel(' high '), 'high');
  // "on" is what someone will actually type. It maps to the TOP of the scale, so
  // it cannot quietly mean less than asked for.
  assert.equal(normalizeReasoningLevel('on'), 'high');
  assert.equal(normalizeReasoningLevel('enabled'), 'high');
  assert.equal(normalizeReasoningLevel('none'), 'off');
  assert.equal(normalizeReasoningLevel('disabled'), 'off');
  assert.equal(normalizeReasoningLevel('medium-ish'), null);
  assert.equal(normalizeReasoningLevel(''), null);
  assert.equal(normalizeReasoningLevel(undefined), null);
  assert.deepEqual(REASONING_LEVELS, ['off', 'low', 'medium', 'high']);
});

test('getReasoningLevel: explicit wins, then the environment, then off — and a typo does not throw', () => {
  const saved = process.env.ECHO_THINKING;
  try {
    delete process.env.ECHO_THINKING;
    assert.equal(getReasoningLevel({}), 'off', 'off must be the default for every provider');
    assert.equal(getReasoningLevel({ reasoning: 'low' }), 'low');

    process.env.ECHO_THINKING = 'medium';
    assert.equal(getReasoningLevel({}), 'medium');
    assert.equal(getReasoningLevel({ reasoning: 'off' }), 'off', 'an explicit request may turn it OFF again');

    // A typo in a .env must not stop `npm start`, same rule as the provider name.
    process.env.ECHO_THINKING = 'very-much';
    assert.equal(getReasoningLevel({}), 'off');
  } finally {
    if (saved === undefined) delete process.env.ECHO_THINKING;
    else process.env.ECHO_THINKING = saved;
  }
});

test('reasoningFields: the local CLI gets nothing, so that path is byte-identical', () => {
  // The CLI takes no such flags from Echo. Returning anything here would change
  // behaviour in the one mode the project says must never change.
  for (const level of REASONING_LEVELS) {
    assert.deepEqual(reasoningFields({ provider: 'claude-cli', reasoning: level }), {});
  }
});

test('reasoningFields: "off" means off, and is SENT rather than omitted', () => {
  // Omitting the field would leave the decision to the API's own default. If that
  // default is "on", switching provider would change the model AND the reasoning
  // mode at once, and a difference in output could not be attributed to either —
  // which is the whole reason this control exists.
  assert.deepEqual(
    reasoningFields({ provider: 'anthropic', reasoning: 'off' }),
    { thinking: { type: 'disabled' } }
  );
  assert.deepEqual(
    reasoningFields({ provider: 'deepseek', reasoning: 'off' }),
    { thinking: { type: 'disabled' } }
  );
  // Default (nothing named anywhere) is off, for both.
  assert.equal(reasoningFields({ provider: 'anthropic' }).thinking.type, 'disabled');
});

test('reasoningFields: the dialect is the CALLING provider\'s, even when opts imply another one', () => {
  // The bug this pins, found by the request-body test below: the DeepSeek
  // provider is reached with a bare `{ apiKey }` and no provider field, and a
  // bare key resolves to "anthropic". Inferring the dialect from opts therefore
  // sent Anthropic's token budget to an API that wants an effort word, and its
  // API would have rejected every digest. Explicit beats inferred.
  const deepseek = reasoningFields({ apiKey: 'k', reasoning: 'high' }, 'deepseek');
  assert.equal(deepseek.reasoning_effort, 'high');
  assert.equal(deepseek.thinking.type, 'enabled');
  assert.equal(deepseek.thinking.budget_tokens, undefined, 'must not leak the Anthropic dialect');

  const anthropic = reasoningFields({ apiKey: 'k', reasoning: 'high' }, 'anthropic');
  assert.equal(anthropic.thinking.budget_tokens, 8_000);
  assert.equal(anthropic.reasoning_effort, undefined, 'must not leak the effort dialect');
});

test('reasoningFields: Anthropic gets a token budget, DeepSeek gets an effort word', () => {
  // Anthropic has no notion of an effort level, so the mapping is Echo's own.
  assert.deepEqual(
    reasoningFields({ reasoning: 'low' }, 'anthropic'),
    { thinking: { type: 'enabled', budget_tokens: 2_048 } }
  );
  assert.deepEqual(
    reasoningFields({ reasoning: 'high' }, 'anthropic'),
    { thinking: { type: 'enabled', budget_tokens: 8_000 } }
  );

  assert.deepEqual(
    reasoningFields({ reasoning: 'high' }, 'deepseek'),
    { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
  );
});

test('reasoningFields: the Anthropic budget is clamped, because an out-of-range one is a hard 400', () => {
  const saved = process.env.ECHO_THINKING_BUDGET_TOKENS;
  try {
    // budget_tokens must be >= 1024 and strictly below max_tokens (16 000 here).
    process.env.ECHO_THINKING_BUDGET_TOKENS = '999999';
    const big = reasoningFields({ provider: 'anthropic', reasoning: 'high' }).thinking.budget_tokens;
    assert.ok(big < PROVIDERS.anthropic.maxOutputTokens, `budget ${big} must stay under max_tokens`);
    assert.equal(big, PROVIDERS.anthropic.maxOutputTokens - 1_024);

    process.env.ECHO_THINKING_BUDGET_TOKENS = '1';
    assert.equal(
      reasoningFields({ provider: 'anthropic', reasoning: 'low' }).thinking.budget_tokens,
      1_024,
      'the floor is the API minimum'
    );
  } finally {
    if (saved === undefined) delete process.env.ECHO_THINKING_BUDGET_TOKENS;
    else process.env.ECHO_THINKING_BUDGET_TOKENS = saved;
  }
});

test('reasoning reaches the Anthropic request body', async (t) => {
  let sent = null;
  t.mock.method(messagesProto, 'create', async (body) => {
    sent = body;
    return fakeAnthropicResponse();
  });

  await ApiKeyProvider.call('prompt', { apiKey: 'sk-test', reasoning: 'medium' });
  assert.deepEqual(sent.thinking, { type: 'enabled', budget_tokens: 4_096 });
});

test('reasoning reaches the DeepSeek request body', async (t) => {
  let sent = null;
  stubFetch(t, (_url, init) => {
    sent = JSON.parse(init.body);
    return jsonResponse(DEEPSEEK_OK);
  });

  await DeepSeekProvider.call('p', { apiKey: 'k', reasoning: 'low' });
  assert.deepEqual(sent.thinking, { type: 'enabled' });
  assert.equal(sent.reasoning_effort, 'low');
});

// --- the leak guard ---------------------------------------------------------
// Reasoning output is NOT part of the answer. Anthropic returns it as separate
// `thinking` blocks and DeepSeek as `reasoning_content`, and in both cases the
// digest must contain only the text — otherwise a model's private deliberation
// ends up in the user's library, exported to Markdown and mirrored to the PDS.

test('Anthropic: a thinking block never reaches the digest', async (t) => {
  t.mock.method(messagesProto, 'create', async () => ({
    content: [
      { type: 'thinking', thinking: 'PRIVATE DELIBERATION that must not ship' },
      { type: 'text', text: 'the actual digest' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));

  const res = await ApiKeyProvider.call('prompt', { apiKey: 'sk-test', reasoning: 'high' });
  assert.equal(res.result, 'the actual digest');
  assert.ok(!res.result.includes('PRIVATE DELIBERATION'), 'reasoning text must not be in the result');
});

test('DeepSeek: reasoning_content never reaches the digest', async (t) => {
  stubFetch(t, () => jsonResponse({
    choices: [{
      message: { content: 'the actual digest', reasoning_content: 'PRIVATE DELIBERATION that must not ship' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));

  const res = await DeepSeekProvider.call('p', { apiKey: 'k', reasoning: 'high' });
  assert.equal(res.result, 'the actual digest');
  assert.ok(!res.result.includes('PRIVATE DELIBERATION'));
});

test('DeepSeek streaming: reasoning deltas are neither streamed nor concatenated', async (t) => {
  stubFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"PRIVATE DELIBERATION"}}]}\n',
    'data: {"choices":[{"delta":{"content":"the actual"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":" more private"}}]}\n',
    'data: {"choices":[{"delta":{"content":" digest"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ]));

  const tokens = [];
  const res = await DeepSeekProvider.stream('p', { apiKey: 'k', reasoning: 'high' }, (x) => tokens.push(x));

  assert.deepEqual(tokens, ['the actual', ' digest'], 'only answer deltas may be streamed');
  assert.equal(res.result, 'the actual digest');
  assert.ok(!tokens.join('').includes('PRIVATE'));
});

// ---------------------------------------------------------------------------
// Provider-aware chunk geometry
// ---------------------------------------------------------------------------

test('chunk geometry reproduces the old hardcoded Claude numbers exactly', () => {
  // 0.60 x 200 000 tokens x 4 chars = 480 000; 0.45 -> 360 000. If either of
  // these drifts, Claude starts chunking differently and every long transcript
  // that used to be one call becomes several.
  assert.equal(thresholdCharsFor({ provider: 'claude-cli' }), 480_000);
  assert.equal(chunkBudgetCharsFor({ provider: 'claude-cli' }), 360_000);
  assert.equal(thresholdCharsFor({ provider: 'anthropic' }), 480_000);
  assert.equal(chunkBudgetCharsFor({ provider: 'anthropic' }), 360_000);
  // The default resolution must land on the same place as an explicit CLI.
  assert.equal(thresholdCharsFor({}), 480_000);
});

test('a bigger context window means a bigger chunk budget, not someone else\'s', () => {
  const claude = thresholdCharsFor({ provider: 'anthropic' });
  const deepseek = thresholdCharsFor({ provider: 'deepseek' });
  assert.ok(deepseek > claude, 'a 1M-token provider must not be chunked as a 200k one');
  assert.ok(chunkBudgetCharsFor({ provider: 'deepseek' }) > chunkBudgetCharsFor({ provider: 'anthropic' }));
});

// ---------------------------------------------------------------------------
// End to end: truncation survives generateDigest()
// ---------------------------------------------------------------------------

test('generateDigest: a truncated single call reports it on the returned digest', async (t) => {
  stubFetch(t, () => jsonResponse({
    choices: [{ message: { content: 'short digest' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  }));

  const res = await generateDigest('a short transcript', { provider: 'deepseek', apiKey: 'k' });
  assert.equal(res.strategy, 'single');
  assert.equal(res.truncated, true);
  assert.ok(res.truncationNote, 'the caller needs the wording, not just a flag');
  assert.equal(res.digest, 'short digest');
});

test('generateDigest: a normal single call reports nothing', async (t) => {
  stubFetch(t, () => jsonResponse(DEEPSEEK_OK));
  const res = await generateDigest('a short transcript', { provider: 'deepseek', apiKey: 'k' });
  assert.equal(res.truncated, undefined);
});

test('generateDigest: truncation inside the MAP phase is flagged — the missing content is not at the end', async (t) => {
  // Past Claude's 480 000-char threshold, so this really does take the
  // map-reduce path with two chunks. The map prompts are distinguishable by
  // their own wording ("chunk 1 of 2"), so the first chunk can be made to stop
  // at its ceiling while the reduce step stays clean — which is the worst case:
  // a complete-looking digest with a hole in the middle.
  const line = 'this is a sentence of the transcript, repeated to reach the budget. ';
  const transcript = Array.from({ length: 8000 }, () => line).join('\n');
  assert.ok(transcript.length > 480_000, 'fixture must exceed the map-reduce threshold');

  let mapCalls = 0;
  t.mock.method(messagesProto, 'create', async (body) => {
    const prompt = body.messages[0].content;
    if (prompt.includes('CHUNK SUMMARIES')) {
      return fakeAnthropicResponse({ text: '## Final digest', stopReason: 'end_turn' });
    }
    mapCalls += 1;
    return fakeAnthropicResponse({
      text: '- a chunk summary',
      stopReason: mapCalls === 1 ? 'max_tokens' : 'end_turn',
    });
  });

  const res = await generateDigest(transcript, { provider: 'anthropic', apiKey: 'sk-test', format: 'digest' });

  assert.equal(res.strategy, 'mapreduce');
  assert.ok(mapCalls >= 2, `expected the map phase to fan out, saw ${mapCalls} call(s)`);
  assert.equal(res.truncated, true, 'a truncated map chunk must not be swallowed by the reduce step');
  assert.match(res.truncationNote, /Anthropic API/);
});

test('generateDigest: a clean map-reduce run reports no truncation', async (t) => {
  const line = 'this is a sentence of the transcript, repeated to reach the budget. ';
  const transcript = Array.from({ length: 8000 }, () => line).join('\n');

  t.mock.method(messagesProto, 'create', async () => fakeAnthropicResponse({ text: 'ok' }));

  const res = await generateDigest(transcript, { provider: 'anthropic', apiKey: 'sk-test', format: 'digest' });
  assert.equal(res.strategy, 'mapreduce');
  assert.equal(res.truncated, undefined);
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');
const PROVIDER_DB = join(tmpdir(), `echo-test-providers-${process.pid}-${Date.now()}.db`);
const USAGE_LOG = join(tmpdir(), `echo-test-providers-usage-${process.pid}-${Date.now()}.jsonl`);

function cleanupDb(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/** Same child-process boot pattern as desktop-mode.test.js / web-mode.test.js. */
function bootServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const port = extraEnv.PORT;
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stderrBuf = '';
    let stdoutBuf = '';

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`server did not start listening.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    }, 15_000);

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      if (!settled && /Listening on/.test(stdoutBuf)) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          proc,
          base: `http://127.0.0.1:${port}`,
          stop: () => new Promise((res) => { proc.once('exit', () => res()); proc.kill(); }),
        });
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`server exited early (${code}).\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    });
  });
}

let server;

test('GET /api/providers serves the registry the UI is built from', async () => {
  server = await bootServer({
    ECHO_MODE: 'local',
    ECHO_DB_PATH: PROVIDER_DB,
    PORT: '8917',
    ECHO_USAGE_SYNTHETIC: '1',
    ECHO_USAGE_LOG_PATH: USAGE_LOG,
    // Pin the answer: an operator's own ECHO_PROVIDER must not decide what this
    // test sees.
    ECHO_PROVIDER: '',
    // And the DeepSeek keys must be absent for real — this machine has one, and
    // inherited, the "fails fast without a key" test would make a live request.
    ECHO_DEEPSEEK_API_KEY: '',
    DEEPSEEK_API_KEY: '',
  });

  const res = await fetch(`${server.base}/api/providers`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.default, 'claude-cli', 'local mode defaults to the keyless CLI');
  assert.equal(data.defaultThinking, 'off', 'reasoning is off by default for a clean comparison');
  const ids = data.providers.map((p) => p.id);
  assert.deepEqual(ids, ['claude-cli', 'anthropic', 'deepseek']);

  // The reasoning capability is served, not guessed by the browser: the CLI has
  // no reasoning concept, so it must report supported:false and get no control.
  assert.equal(data.providers.find((p) => p.id === 'claude-cli').reasoning.supported, false);
  assert.equal(data.providers.find((p) => p.id === 'anthropic').reasoning.supported, true);
  assert.deepEqual(
    data.providers.find((p) => p.id === 'deepseek').reasoning.levels,
    ['off', 'low', 'medium', 'high'],
    'levels come from the registry so the option list cannot drift'
  );

  const claude = data.providers.find((p) => p.id === 'claude-cli');
  assert.equal(claude.requiresKey, false);
  assert.equal(claude.longPathThresholdChars, 480_000);

  const deepseek = data.providers.find((p) => p.id === 'deepseek');
  assert.equal(deepseek.requiresKey, true);
  assert.ok(deepseek.longPathThresholdChars > 480_000);

  // Not a secret-leaking surface. Checked structurally — no key-like field, and
  // no value shaped like an API key. Grepping the JSON for the word "token"
  // would match `contextTokens` and prove nothing.
  for (const p of data.providers) {
    for (const forbidden of ['apiKey', 'key', 'secret', 'authorization']) {
      assert.ok(!(forbidden in p), `${p.id}: provider list must not expose ${forbidden}`);
    }
  }
  assert.ok(!/sk-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(data)), 'no API-key-shaped value');
});

test('response compression does not mangle the provider list', async () => {
  const res = await fetch(`${server.base}/api/providers`, { headers: { 'Accept-Encoding': 'gzip' } });
  const data = await res.json();
  assert.ok(Array.isArray(data.providers));
});

test('POST /api/digest with an unknown provider is a 400, not a silent substitution', async () => {
  const res = await fetch(`${server.base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Provider': 'gpt-5' },
    body: JSON.stringify({ text: 'hello there', format: 'digest' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'PROVIDER_UNKNOWN');
  assert.match(data.error.message, /gpt-5/);
});

test('POST /api/digest honours a named provider — and fails fast, without a key, before any network call', async () => {
  // DeepSeek's env keys are cleared for this child, so the request must stop at
  // "no key" rather than reaching out.
  const res = await fetch(`${server.base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Provider': 'deepseek' },
    body: JSON.stringify({ text: 'hello there', format: 'digest' }),
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'API_NOT_AUTHED');
  assert.match(data.error.hint, /DeepSeek/);
});

test('POST /api/digest with an unknown thinking level is a 400, not a fallback', async () => {
  const res = await fetch(`${server.base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Thinking': 'very-much' },
    body: JSON.stringify({ text: 'hello there', format: 'digest' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'THINKING_INVALID');
  assert.match(data.error.message, /very-much/);
});

test('POST /api/digest accepts a valid thinking level and passes it through', async () => {
  // DeepSeek with no key, so it cannot reach the network: a 401 here proves the
  // header was ACCEPTED (a rejection would have been the 400 above), and the hint
  // proves which provider it routed to.
  const res = await fetch(`${server.base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Provider': 'deepseek', 'X-Echo-Thinking': 'high' },
    body: JSON.stringify({ text: 'hello there', format: 'digest' }),
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'API_NOT_AUTHED');
});

test('POST /api/digest rejects an unknown provider before an unknown thinking level', async () => {
  // Ordering guard: the provider is the more fundamental mistake, so it must be
  // the one reported when both are wrong.
  const res = await fetch(`${server.base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Provider': 'gpt-5', 'X-Echo-Thinking': 'very-much' },
    body: JSON.stringify({ text: 'hello there', format: 'digest' }),
  });
  const data = await res.json();
  assert.equal(data.error.code, 'PROVIDER_UNKNOWN');
});

test('stopping the provider server cleans up', async () => {
  if (server) await server.stop();
  cleanupDb(PROVIDER_DB);
  try { rmSync(USAGE_LOG, { force: true }); } catch { /* ignore */ }
});
