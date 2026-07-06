import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHref } from '../websearch.js';

// ---------------------------------------------------------------------------
// resolveHref — scheme-validation security regression
//
// Regression guard for the bug where javascript:, file:, and data: scheme
// URLs slipped through the duckduckgo.com host filter because
// new URL('javascript:...').host returns '' (empty string), which does NOT
// include 'duckduckgo.com', so those URLs were returned as valid results and
// eventually rendered as clickable links in the frontend (XSS vector).
// ---------------------------------------------------------------------------

test('resolveHref: accepts a plain https URL', () => {
  const result = resolveHref('https://example.com/article');
  assert.equal(result, 'https://example.com/article');
});

test('resolveHref: accepts a plain http URL', () => {
  const result = resolveHref('http://example.com/page');
  assert.equal(result, 'http://example.com/page');
});

test('resolveHref: accepts a protocol-relative URL by upgrading to https', () => {
  // The function prepends 'https:' to '//' URLs before resolving.
  const result = resolveHref('//example.com/path');
  assert.equal(result, 'https://example.com/path');
});

test('resolveHref: rejects a javascript: URL (XSS regression)', () => {
  const result = resolveHref('javascript:alert(1)');
  assert.equal(result, null);
});

test('resolveHref: rejects a javascript: URL with mixed case (XSS regression)', () => {
  const result = resolveHref('JavaScript:void(0)');
  assert.equal(result, null);
});

test('resolveHref: rejects a file: URL', () => {
  const result = resolveHref('file:///etc/passwd');
  assert.equal(result, null);
});

test('resolveHref: rejects a data: URL', () => {
  const result = resolveHref('data:text/html,<script>alert(1)</script>');
  assert.equal(result, null);
});

test('resolveHref: rejects a DDG redirect that resolves to a javascript: URL', () => {
  // Simulate an uddg= param whose decoded value is a javascript: URL.
  const encoded = encodeURIComponent('javascript:alert(1)');
  const result = resolveHref(`//duckduckgo.com/l/?uddg=${encoded}`);
  assert.equal(result, null);
});

test('resolveHref: rejects an empty string', () => {
  const result = resolveHref('');
  assert.equal(result, null);
});

test('resolveHref: rejects a duckduckgo.com internal link', () => {
  const result = resolveHref('https://duckduckgo.com/some-internal-page');
  assert.equal(result, null);
});

test('resolveHref: unwraps a valid DDG redirect (uddg param) and returns the destination', () => {
  const destination = 'https://example.com/real-article';
  const encoded = encodeURIComponent(destination);
  const result = resolveHref(`//duckduckgo.com/l/?uddg=${encoded}&rut=xyz`);
  assert.equal(result, destination);
});
