import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryToMarkdown } from '../markdown.js';

function buildFixture() {
  return {
    videoId: 'abc12345678',
    url: 'https://www.youtube.com/watch?v=abc12345678',
    title: 'My Title "quoted"',
    savedAt: '2026-01-01T00:00:00.000Z',
    favorite: true,
    tags: ['a', 'b'],
    digest: '## D\ncontent',
    segments: [{ text: 'intro hello world here', offset: 42 }],
  };
}

test('entryToMarkdown: emits frontmatter with escaped title, url, and tags flow list', () => {
  const md = entryToMarkdown(buildFixture());
  assert.ok(md.startsWith('---'));
  assert.match(md, /title: "My Title \\"quoted\\""/);
  assert.match(md, /url: "https:\/\/www\.youtube\.com\/watch\?v=abc12345678"/);
  assert.match(md, /tags: \["a", "b"\]/);
});

test('entryToMarkdown: includes an H1 with the title', () => {
  const md = entryToMarkdown(buildFixture());
  assert.match(md, /# My Title "quoted"/);
});

test('entryToMarkdown: includes the digest under a ## Digest heading', () => {
  const md = entryToMarkdown(buildFixture());
  assert.match(md, /## Digest/);
  assert.match(md, /## D\ncontent/);
});

test('entryToMarkdown: includes a ## Transcript section by default', () => {
  const md = entryToMarkdown(buildFixture());
  assert.match(md, /## Transcript/);
  assert.match(md, /intro hello world here/);
});

test('entryToMarkdown: omits the ## Transcript section when includeTranscript is false', () => {
  const md = entryToMarkdown(buildFixture(), { includeTranscript: false });
  assert.doesNotMatch(md, /## Transcript/);
});

test('entryToMarkdown: an entry with no digest omits that section without crashing', () => {
  const entry = {
    videoId: 'xyz98765432',
    url: 'https://www.youtube.com/watch?v=xyz98765432',
    title: 'Bare Entry',
    savedAt: '2026-01-01T00:00:00.000Z',
    favorite: false,
    tags: [],
    digest: null,
    segments: [],
  };

  const md = entryToMarkdown(entry);
  assert.doesNotMatch(md, /## Digest/);
  assert.match(md, /# Bare Entry/);
});

test('entryToMarkdown: an unsafe url (javascript:) never appears and no Source link is emitted', () => {
  const entry = { ...buildFixture(), url: 'javascript:alert(1)' };
  const md = entryToMarkdown(entry);
  assert.doesNotMatch(md, /javascript:/);
  assert.doesNotMatch(md, /\*\*Source:\*\*/);
});

test('entryToMarkdown: a valid https url produces a Source link', () => {
  const entry = { ...buildFixture(), url: 'https://www.youtube.com/watch?v=abc12345678' };
  const md = entryToMarkdown(entry);
  assert.match(md, /\*\*Source:\*\* \[https:\/\/www\.youtube\.com\/watch\?v=abc12345678\]\(https:\/\/www\.youtube\.com\/watch\?v=abc12345678\)/);
});
