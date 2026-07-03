import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClips, resolveHighlightSecond } from '../clips.js';

const segments = [
  { text: 'intro hello world here', offset: 10 },
  { text: 'second segment about cats', offset: 55.7 },
];

// ---------------------------------------------------------------------------
// resolveHighlightSecond
// ---------------------------------------------------------------------------

test('resolveHighlightSecond: matching text returns the floored offset in seconds', () => {
  assert.equal(resolveHighlightSecond('hello world', segments), 10);
  assert.equal(resolveHighlightSecond('cats', segments), 55); // floored from 55.7
});

test('resolveHighlightSecond: reads the real segment field name ("offset"), not "offset_seconds"', () => {
  const realShapeSegments = [
    { text: 'intro hello world here', offset: 42 },
  ];
  const second = resolveHighlightSecond('hello world', realShapeSegments);
  assert.notEqual(second, null);
  assert.equal(second, 42);
});

test('resolveHighlightSecond: no match returns null', () => {
  assert.equal(resolveHighlightSecond('nonexistent phrase', segments), null);
});

test('resolveHighlightSecond: empty/nullish inputs return null', () => {
  assert.equal(resolveHighlightSecond('', segments), null);
  assert.equal(resolveHighlightSecond(null, segments), null);
  assert.equal(resolveHighlightSecond(undefined, segments), null);
  assert.equal(resolveHighlightSecond('hello', []), null);
  assert.equal(resolveHighlightSecond('hello', null), null);
});

// ---------------------------------------------------------------------------
// buildClips
// ---------------------------------------------------------------------------

test('buildClips: an entry with 2 highlights (one matched, one unmatched) produces 2 clips', () => {
  const entry = {
    videoId: 'vid123',
    title: 'Test Video',
    url: 'https://www.youtube.com/watch?v=vid123',
    segments,
    highlights: [
      { id: 'h1', text: 'hello world', note: null, color: null },
      { id: 'h2', text: 'totally unmatched text', note: null, color: null },
    ],
  };

  const clips = buildClips([entry]);
  assert.equal(clips.length, 2);

  const [matched, unmatched] = clips;

  assert.equal(matched.second, 10);
  assert.notEqual(matched.second, null);
  assert.ok(Number.isInteger(matched.second));
  assert.match(matched.deepLink, /&t=10s/);
  assert.ok(matched.deepLink.includes('&t='));
  assert.equal(matched.timeLabel, '0:10');

  assert.equal(unmatched.second, null);
  assert.equal(unmatched.deepLink, entry.url);
  assert.ok(!unmatched.deepLink.includes('&t='));
  assert.equal(unmatched.timeLabel, null);
});

test('buildClips: an entry with no highlights produces no clips', () => {
  const entry = {
    videoId: 'vid456',
    title: 'No Highlights',
    url: 'https://www.youtube.com/watch?v=vid456',
    segments,
    highlights: [],
  };
  const clips = buildClips([entry]);
  assert.equal(clips.length, 0);
});

test('buildClips: URL hardening — a javascript: URL falls back to the canonical watch URL', () => {
  const entry = {
    videoId: 'vidJS',
    title: 'Malicious URL',
    url: 'javascript:alert(1)',
    segments,
    highlights: [{ id: 'h1', text: 'hello world', note: null, color: null }],
  };

  const clips = buildClips([entry]);
  assert.equal(clips.length, 1);

  const expectedBase = 'https://www.youtube.com/watch?v=vidJS';
  assert.equal(clips[0].videoUrl, expectedBase);
  assert.ok(clips[0].deepLink.startsWith(expectedBase));
  assert.doesNotMatch(clips[0].deepLink, /javascript:/);
});

test('buildClips: gracefully handles a non-array or empty entries list', () => {
  assert.deepEqual(buildClips([]), []);
  assert.deepEqual(buildClips(null), []);
  assert.deepEqual(buildClips(undefined), []);
});
