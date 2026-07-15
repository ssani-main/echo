import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Regression coverage for the suggestTags language-leak bug: suggestTags()
// used to inject languageDirective(language) ("Answer in English using
// concise Markdown.") into its prompt, which contradicted the STRICT JSON
// instruction that immediately follows. Models dropped the contradictory
// directive and echoed tags back in the SOURCE material's language instead
// of the requested one (e.g. Indonesian tags for an Indonesian video even
// with language:'English'). These tests assert prompt CONTENT, not just
// input/output shape, so a future edit can't silently reintroduce the
// contradiction.
// ---------------------------------------------------------------------------

test('suggestTags: prompt pins the tag language to English when language is "English"', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['tag'] }), usage: fakeUsage() };
  });

  await suggestTags('some material', { apiKey: 'sk-test', language: 'English' });

  assert.ok(
    capturedPrompt.includes('Write every tag in English'),
    'prompt should explicitly name English as the tag language'
  );
});

test('suggestTags: prompt defaults the tag language to English when language is omitted', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['tag'] }), usage: fakeUsage() };
  });

  await suggestTags('some material', { apiKey: 'sk-test' });

  assert.ok(
    capturedPrompt.includes('Write every tag in English'),
    'omitting language should still pin the tag language to English'
  );
});

test('suggestTags: prompt pins the tag language to Indonesian when language is "Indonesian"', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['tag'] }), usage: fakeUsage() };
  });

  await suggestTags('some material', { apiKey: 'sk-test', language: 'Indonesian' });

  assert.ok(
    capturedPrompt.includes('Write every tag in Indonesian'),
    'prompt should explicitly name Indonesian as the tag language'
  );
});

test('suggestTags: prompt does not ask for Markdown (contradicts STRICT JSON)', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['tag'] }), usage: fakeUsage() };
  });

  await suggestTags('some material', { apiKey: 'sk-test', language: 'English' });

  // Regression guard: the prompt previously called languageDirective(), which
  // asks for "concise Markdown" — directly contradicting the STRICT JSON
  // instruction a few lines later. The model resolved the contradiction by
  // dropping the language directive entirely and echoing tags back in the
  // SOURCE material's language (e.g. Indonesian tags for an Indonesian
  // video, even with language:'English' requested). Do not reintroduce any
  // Markdown request into this prompt.
  assert.ok(
    !capturedPrompt.includes('Markdown'),
    'suggestTags prompt must never request Markdown output'
  );
});

test('suggestTags: prompt still contains the STRICT JSON instruction', async (t) => {
  let capturedPrompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    capturedPrompt = prompt;
    return { result: JSON.stringify({ tags: ['tag'] }), usage: fakeUsage() };
  });

  await suggestTags('some material', { apiKey: 'sk-test', language: 'English' });

  assert.ok(
    capturedPrompt.includes('Return STRICT JSON and nothing else'),
    'prompt should still demand STRICT JSON output'
  );
});

// ---------------------------------------------------------------------------
// POST /api/digest — suggestedTags is computed in parallel with the digest
// and included in the response. The separate /api/tags/suggest route has
// been removed: auto-tagging is now folded into the digest request itself
// (never a second round-trip, never shown before Save — see CLAUDE.md /
// public/index.html maybeAutoSuggestTags()).
//
// The provider is discriminated by prompt content so a single mock can
// stand in for both the digest call and the tag-suggestion call that fire
// in parallel inside the route handler.
// ---------------------------------------------------------------------------

const DB = join(tmpdir(), `echo-test-tags-digest-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;
// Desktop mode: readApiKey() only honors the X-Echo-Api-Key header in
// web/desktop mode (see server.js readApiKey()) — in default local mode a
// keyless fallthrough would hit the real `claude` CLI instead of the mocked
// ApiKeyProvider. Desktop (not web) is used so no rate limiting/BYOK-required
// gating gets in the way of a plain apiKey-supplied request.
process.env.ECHO_MODE = 'desktop';

const { app } = await import('../server.js');
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
});

function fakeUsage2() {
  return {
    costUsd: 0.0005,
    inputTokens: 50,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 60,
    durationMs: 5,
  };
}

test('POST /api/digest returns both digest and suggestedTags, computed via a single request (no /api/tags/suggest round-trip)', async (t) => {
  let digestCalls = 0;
  let tagCalls = 0;

  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    if (prompt.includes('MATERIAL:') && prompt.includes('"tags"')) {
      tagCalls += 1;
      return { result: JSON.stringify({ tags: ['cooking', 'recipes'] }), usage: fakeUsage2() };
    }
    digestCalls += 1;
    return { result: 'A short synthesized digest of the video.', usage: fakeUsage2() };
  });

  const res = await fetch(`${base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Api-Key': 'sk-test' },
    body: JSON.stringify({ text: 'Today we are making a delicious pasta dish from scratch.' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.digest, 'string');
  assert.ok(body.digest.length > 0);
  assert.ok(Array.isArray(body.suggestedTags));
  assert.deepEqual(body.suggestedTags, ['cooking', 'recipes']);

  assert.equal(digestCalls, 1);
  assert.equal(tagCalls, 1);
});

test('POST /api/digest still succeeds with suggestedTags: [] when the tag-suggestion call fails — the digest must never be broken by a tagging failure', async (t) => {
  t.mock.method(ApiKeyProvider, 'call', async (prompt) => {
    if (prompt.includes('MATERIAL:') && prompt.includes('"tags"')) {
      throw new Error('simulated tag-suggestion provider failure');
    }
    return { result: 'Digest text that must still come through.', usage: fakeUsage2() };
  });

  const res = await fetch(`${base}/api/digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Echo-Api-Key': 'sk-test' },
    body: JSON.stringify({ text: 'A transcript about something entirely unrelated to tags.' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.digest, 'Digest text that must still come through.');
  assert.deepEqual(body.suggestedTags, []);
});

test('POST /api/tags/suggest no longer exists — auto-tagging is folded into /api/digest', async () => {
  const res = await fetch(`${base}/api/tags/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptExcerpt: 'some material' }),
  });
  assert.equal(res.status, 404);
});
