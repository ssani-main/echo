import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranscriptFailure } from '../transcript.js';

// ---------------------------------------------------------------------------
// classifyTranscriptFailure
// ---------------------------------------------------------------------------

test('classifyTranscriptFailure: premiere with interval extraction', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('Premieres in 7 days'),
    ''
  );
  assert.equal(reason, 'premiere');
  assert.ok(message.length > 0);
  assert.ok(hint.includes('7 days'));
});

test('classifyTranscriptFailure: premiere via "will begin in"', () => {
  const { reason, hint } = classifyTranscriptFailure(
    new Error('This live event will begin in 3 hours'),
    ''
  );
  assert.equal(reason, 'premiere');
  assert.ok(hint.includes('3 hours'));
});

test('classifyTranscriptFailure: live stream in progress', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('some error'),
    'This live event has begun.'
  );
  assert.equal(reason, 'live');
  assert.ok(message.toLowerCase().includes('live'));
  assert.ok(hint.length > 0);
});

test('classifyTranscriptFailure: private video', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('Private video'),
    ''
  );
  assert.equal(reason, 'private');
  assert.ok(message.toLowerCase().includes('private'));
  assert.ok(hint.length > 0);
});

test('classifyTranscriptFailure: unavailable / removed', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('Video unavailable'),
    ''
  );
  assert.equal(reason, 'unavailable');
  assert.ok(message.toLowerCase().includes('unavailable'));
  assert.ok(hint.length > 0);
});

test('classifyTranscriptFailure: age restricted', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('Sign in to confirm your age'),
    ''
  );
  assert.equal(reason, 'age_restricted');
  assert.ok(message.toLowerCase().includes('age-restricted'));
  assert.ok(hint.length > 0);
});

test('classifyTranscriptFailure: geo blocked', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('The uploader has not made this video available in your country'),
    ''
  );
  assert.equal(reason, 'geo_blocked');
  assert.ok(message.toLowerCase().includes('region'));
  assert.ok(hint.length > 0);
});

test('classifyTranscriptFailure: default no_captions', () => {
  const { reason, message, hint } = classifyTranscriptFailure(
    new Error('some generic youtube-transcript error'),
    'yt-dlp: unknown error'
  );
  assert.equal(reason, 'no_captions');
  assert.ok(message.toLowerCase().includes('no transcript'));
  assert.ok(hint.length > 0);
});
