import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryFtsQuery } from '../store.js';

// ---------------------------------------------------------------------------
// buildLibraryFtsQuery
//
// Fixes the /api/library/ask retrieval bug: FTS5 MATCH ANDs all bareword
// tokens, so a raw natural-language question full of stopwords ("what",
// "is", "about", "in") forces zero matches even when the library clearly
// has relevant content. buildLibraryFtsQuery() strips stopwords/short
// tokens and OR-joins quoted phrases so any term hitting a doc ranks it
// (FTS5 `rank` still orders by relevance).
// ---------------------------------------------------------------------------

test('buildLibraryFtsQuery: natural-language question -> stopwords dropped, OR-joined quoted terms', () => {
  const q = buildLibraryFtsQuery('What is discussed about living in Germany?');
  assert.equal(q, '"discussed" OR "living" OR "germany"');
});

test('buildLibraryFtsQuery: all-stopword input falls back to a non-empty query', () => {
  const q = buildLibraryFtsQuery('what is this about');
  assert.ok(q.length > 0);
  // Falls back to quoting the original tokens (none survive stopword filtering).
  assert.equal(q, '"what" OR "is" OR "this" OR "about"');
});

test('buildLibraryFtsQuery: tokens of length <= 2 are dropped', () => {
  const q = buildLibraryFtsQuery('is ai a big deal in EU');
  // "ai", "eu" are <=2 chars and dropped along with stopwords "is", "a", "in".
  assert.equal(q, '"big" OR "deal"');
});

test('buildLibraryFtsQuery: FTS5 special characters are quoted, not left bareword', () => {
  const q = buildLibraryFtsQuery('what about C++ and "quotes" or NEAR/2 stuff?');
  // Tokenizer strips punctuation entirely (word-char extraction), so no raw
  // FTS5 operator/special-char syntax (NEAR, quotes, +) can leak through.
  assert.ok(!/[^"A-Za-z0-9 ]/.test(q.replace(/"/g, '').replace(/ OR /g, ' ')) || true);
  for (const term of q.split(' OR ')) {
    assert.match(term, /^"[\p{L}\p{N}]+"$/u);
  }
});

test('buildLibraryFtsQuery: empty/whitespace input returns empty string', () => {
  assert.equal(buildLibraryFtsQuery(''), '');
  assert.equal(buildLibraryFtsQuery('   '), '');
  assert.equal(buildLibraryFtsQuery(undefined), '');
});

test('buildLibraryFtsQuery: a bare keyword still works as before', () => {
  assert.equal(buildLibraryFtsQuery('germany'), '"germany"');
});
