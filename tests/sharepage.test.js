import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSharePage, safeHttpUrl, escapeHtml, escapeAttr, renderMarkdown } from '../sharepage.js';

// ---------------------------------------------------------------------------
// renderSharePage — basic shape
// ---------------------------------------------------------------------------

test('renderSharePage returns a full HTML document containing the escaped title and digest content', () => {
  const html = renderSharePage({
    id: 'abc123',
    title: 'My <Cool> Video',
    sourceUrl: 'https://www.youtube.com/watch?v=abc123',
    digestMd: 'This is the digest body.',
    claims: null,
    createdAt: '2026-07-08T00:00:00.000Z',
  });

  assert.equal(typeof html, 'string');
  assert.match(html, /^<!doctype html/i);
  // Title is HTML-escaped (angle brackets neutralized).
  assert.ok(html.includes('My &lt;Cool&gt; Video'));
  assert.ok(!html.includes('My <Cool> Video'));
  // Digest content made it into the page.
  assert.ok(html.includes('This is the digest body.'));
});

test('renderSharePage tolerates missing title/sourceUrl/claims/createdAt (falls back to defaults, no crash)', () => {
  const html = renderSharePage({ digestMd: 'Just a digest.' });
  assert.match(html, /^<!doctype html/i);
  assert.ok(html.includes('Untitled digest'));
  assert.ok(html.includes('Just a digest.'));
});

// ---------------------------------------------------------------------------
// XSS hardening
// ---------------------------------------------------------------------------

test('renderSharePage escapes a raw <script> tag in digestMd — no live <script>alert in output', () => {
  const html = renderSharePage({
    title: 'XSS test',
    digestMd: '<script>alert(1)</script>\n\nSome real content.',
  });

  assert.ok(!html.includes('<script>alert'), 'raw <script>alert must not appear unescaped');
  assert.ok(html.includes('&lt;script'), 'the script tag should be HTML-escaped');
});

test('renderSharePage drops a javascript: markdown link (no javascript: scheme ever reaches an href)', () => {
  const html = renderSharePage({
    title: 'XSS link test',
    digestMd: 'Click [x](javascript:alert(1)) to win.',
  });

  assert.ok(!/href="javascript:/i.test(html), 'no href should carry a javascript: scheme');
  assert.ok(!html.includes('javascript:alert(1)'), 'the raw javascript: URL must not be emitted at all');
  // The link text is preserved as plain text since the URL was unsafe.
  assert.ok(html.includes('Click x to win.') || html.includes('>x<') || html.includes('x</p>') || html.includes('x '));
});

test('renderSharePage drops a javascript: sourceUrl — no "Watch original" link is emitted', () => {
  const html = renderSharePage({
    title: 'Bad source url',
    sourceUrl: 'javascript:alert(1)',
    digestMd: 'Body text.',
  });

  assert.ok(!/href="javascript:/i.test(html));
  assert.ok(!html.includes('javascript:alert(1)'));
  // No watch-link anchor should be present at all since sourceUrl was unsafe.
  assert.ok(!html.includes('class="watch-link"'));
});

test('renderSharePage combined XSS payload (script + bad link + bad sourceUrl) yields no exploitable output', () => {
  const html = renderSharePage({
    title: 'Combined XSS',
    sourceUrl: 'javascript:alert(1)',
    digestMd: '<script>alert(1)</script>\n\nClick [x](javascript:alert(1)) here.',
  });

  assert.ok(!html.includes('<script>alert'));
  assert.ok(!/javascript:/i.test(html));
});

// ---------------------------------------------------------------------------
// safeHttpUrl
// ---------------------------------------------------------------------------

test('safeHttpUrl rejects a javascript: URL, returning an empty string', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
});

test('safeHttpUrl rejects other unsafe schemes (data:, file:, vbscript:)', () => {
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeHttpUrl('file:///etc/passwd'), '');
  assert.equal(safeHttpUrl('vbscript:msgbox(1)'), '');
});

test('safeHttpUrl passes through a well-formed https URL unchanged', () => {
  assert.equal(safeHttpUrl('https://example.com'), 'https://example.com');
});

test('safeHttpUrl passes through a well-formed http URL unchanged', () => {
  assert.equal(safeHttpUrl('http://example.com/path?x=1'), 'http://example.com/path?x=1');
});

test('safeHttpUrl returns empty string for empty/null/undefined input', () => {
  assert.equal(safeHttpUrl(''), '');
  assert.equal(safeHttpUrl(null), '');
  assert.equal(safeHttpUrl(undefined), '');
});

// ---------------------------------------------------------------------------
// escapeHtml / escapeAttr (sanity — sharepage.js relies on these for safety)
// ---------------------------------------------------------------------------

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('escapeAttr behaves identically to escapeHtml', () => {
  assert.equal(escapeAttr('<a href="x">'), escapeHtml('<a href="x">'));
});

// ---------------------------------------------------------------------------
// renderMarkdown — used directly by claims-section-less digest rendering
// ---------------------------------------------------------------------------

test('renderMarkdown escapes embedded HTML before applying markdown transforms', () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>\n\n**bold text**');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('<strong>bold text</strong>'));
});

// ---------------------------------------------------------------------------
// Claims section rendering
// ---------------------------------------------------------------------------

test('renderSharePage renders a claims section with the claim text and a status pill/label for every status value', () => {
  const claims = [
    { claim: 'Claim one is fully supported.', status: 'supported' },
    { claim: 'Claim two is not supported.', status: 'unsupported' },
    { claim: 'Claim three has mixed evidence.', status: 'mixed' },
    { claim: 'Claim four cannot be verified.', status: 'unverifiable' },
  ];

  const html = renderSharePage({
    title: 'Claims test',
    digestMd: 'Digest body.',
    claims,
  });

  assert.ok(html.includes('Key claims'));
  for (const c of claims) {
    assert.ok(html.includes(c.claim), `expected claim text "${c.claim}" to appear in output`);
  }

  // Each status maps to a distinct pill class + label.
  assert.match(html, /claim-supported[^>]*>[^<]*Supported/);
  assert.match(html, /claim-unsupported[^>]*>[^<]*Unsupported/);
  assert.match(html, /claim-mixed[^>]*>[^<]*Mixed/);
  assert.match(html, /claim-unverifiable[^>]*>[^<]*Unverifiable/);
});

test('renderSharePage with an unknown claim status falls back to the "unverifiable" pill', () => {
  const html = renderSharePage({
    title: 'Unknown status',
    digestMd: 'Digest body.',
    claims: [{ claim: 'A weird claim.', status: 'totally-not-a-real-status' }],
  });
  assert.ok(html.includes('A weird claim.'));
  assert.match(html, /claim-unverifiable[^>]*>[^<]*Unverifiable/);
});

test('renderSharePage with no claims (null/empty array) omits the claims section entirely', () => {
  // Note: the page's <style> block always defines the .claims-section CSS
  // rule, so we assert on the absence of the actual rendered <section> markup
  // (and its "Key claims" heading) rather than the substring "claims-section".
  const htmlNull = renderSharePage({ title: 't', digestMd: 'd', claims: null });
  assert.ok(!htmlNull.includes('<section class="claims-section">'));
  assert.ok(!htmlNull.includes('Key claims'));

  const htmlEmpty = renderSharePage({ title: 't', digestMd: 'd', claims: [] });
  assert.ok(!htmlEmpty.includes('<section class="claims-section">'));
  assert.ok(!htmlEmpty.includes('Key claims'));
});
