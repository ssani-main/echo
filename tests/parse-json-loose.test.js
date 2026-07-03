import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose } from '../digest.js';

// ---------------------------------------------------------------------------
// parseJsonLoose
// ---------------------------------------------------------------------------

test('parseJsonLoose: parses clean JSON directly', () => {
  const input = '{"claims":[{"claim":"foo","assessment":"supported"}]}';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { claims: [{ claim: 'foo', assessment: 'supported' }] });
});

test('parseJsonLoose: strips ```json fences before parsing', () => {
  const input = '```json\n{"chapters":[{"title":"Intro","startSec":0}]}\n```';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { chapters: [{ title: 'Intro', startSec: 0 }] });
});

test('parseJsonLoose: strips bare ``` fences (no language tag) before parsing', () => {
  const input = '```\n{"quotes":[{"text":"hello","startSec":5}]}\n```';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { quotes: [{ text: 'hello', startSec: 5 }] });
});

test('parseJsonLoose: recovers JSON followed by trailing prose after the closing brace', () => {
  const input = '{"claims":[{"claim":"bar","assessment":"disputed"}]}\n\nHope this helps!';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { claims: [{ claim: 'bar', assessment: 'disputed' }] });
});

test('parseJsonLoose: recovers JSON with a "}" character inside a quoted string value', () => {
  const input = '{"claim":"a set like {1,2,3} was mentioned","assessment":"supported"}';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { claim: 'a set like {1,2,3} was mentioned', assessment: 'supported' });
});

test('parseJsonLoose: recovers JSON when trailing prose itself contains braces', () => {
  const input =
    '{"chapters":[{"title":"Intro","startSec":0}]}\n\n' +
    'Note: the format above uses {curly braces} for objects.';
  const parsed = parseJsonLoose(input);
  assert.deepEqual(parsed, { chapters: [{ title: 'Intro', startSec: 0 }] });
});

test('parseJsonLoose: throws a tagged MODEL_BAD_JSON error for fully malformed input', () => {
  const input = 'Sorry, I cannot produce that response right now.';
  assert.throws(
    () => parseJsonLoose(input),
    (err) => {
      assert.equal(err.echoCode, 'MODEL_BAD_JSON');
      return true;
    }
  );
});

test('parseJsonLoose: throws a tagged MODEL_BAD_JSON error for text that looks like JSON but is unrecoverably broken', () => {
  const input = '{"claims": [ this is not valid json at all }}}';
  assert.throws(
    () => parseJsonLoose(input),
    (err) => {
      assert.equal(err.echoCode, 'MODEL_BAD_JSON');
      return true;
    }
  );
});
