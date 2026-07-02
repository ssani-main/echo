import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHttpUrl } from '../sanitize.js';

test('safeHttpUrl accepts http and https URLs', () => {
  assert.equal(safeHttpUrl('http://x'), 'http://x');
  assert.equal(safeHttpUrl('https://x'), 'https://x');
});

test('safeHttpUrl accepts uppercase scheme', () => {
  assert.equal(safeHttpUrl('HTTPS://X'), 'HTTPS://X');
});

test('safeHttpUrl accepts a normal youtube watch url', () => {
  const url = 'https://www.youtube.com/watch?v=abc12345678';
  assert.equal(safeHttpUrl(url), url);
});

test('safeHttpUrl rejects javascript: URLs', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
});

test('safeHttpUrl rejects data: URLs', () => {
  assert.equal(safeHttpUrl('data:text/html,x'), '');
});

test('safeHttpUrl rejects vbscript: URLs', () => {
  assert.equal(safeHttpUrl('vbscript:x'), '');
});

test('safeHttpUrl rejects javascript: URL with leading whitespace', () => {
  assert.equal(safeHttpUrl('  javascript:alert(1)'), '');
});

test('safeHttpUrl rejects javascript: URL with an embedded tab', () => {
  assert.equal(safeHttpUrl('java\tscript:alert(1)'), '');
});

test('safeHttpUrl rejects javascript: URL with an embedded newline', () => {
  assert.equal(safeHttpUrl('java\nscript:alert(1)'), '');
});

test('safeHttpUrl rejects ftp: URLs', () => {
  assert.equal(safeHttpUrl('ftp://x'), '');
});

test('safeHttpUrl rejects a bare relative path', () => {
  assert.equal(safeHttpUrl('foo'), '');
});

test('safeHttpUrl rejects empty string, null, and undefined', () => {
  assert.equal(safeHttpUrl(''), '');
  assert.equal(safeHttpUrl(null), '');
  assert.equal(safeHttpUrl(undefined), '');
});
