import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDigest } from '../digest.js';
import { ApiKeyProvider } from '../providers.js';

// The digest prompt reorganised every video by importance, which turned a
// podcast into a profile of the guest: the conversation's order was lost and
// the host survived only as "asked whether...". These guard the instructions
// that fixed it. The suite never spawns a real model, so the text is all a
// unit test can see.

async function capturePrompt(t, opts) {
  let prompt = '';
  t.mock.method(ApiKeyProvider, 'call', async (p) => {
    prompt = p;
    return { result: 'digest', usage: {} };
  });
  await generateDigest('>> hello >> hi there', { apiKey: 'sk-test', format: 'digest', ...opts });
  return prompt;
}

test('digest prompt: a conversation is followed in order, host included', async (t) => {
  const prompt = await capturePrompt(t, {});
  assert.ok(prompt.includes('do NOT reorganize it by importance'), 'conversation order rule');
  assert.ok(prompt.includes('A host is a participant, not a prompt'), 'host rule');
  assert.ok(prompt.includes('">>" marks a change of speaker'), 'speaker-turn marker rule');
  assert.ok(prompt.includes('no sponsor reads, plugs, housekeeping'), 'longer must not mean padded');
});

test('digest prompt: the channel is offered as a hint for the host name', async (t) => {
  const prompt = await capturePrompt(t, { channel: 'Some "Host"\nName' });
  assert.ok(prompt.includes(`published on the channel "Some 'Host' Name"`), 'channel sanitised and present');
});

test('digest prompt: no channel, no channel sentence', async (t) => {
  const prompt = await capturePrompt(t, {});
  assert.ok(!prompt.includes('published on the channel'));
});
