import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The page's Markdown renderer, exercised directly.
//
// renderMarkdown() parks inline code spans behind a U+0000 sentinel while it
// applies the other inline transforms. Two things follow from that, and this
// file guards both:
//
//  1. The sentinel must be written as an escape sequence, not as a raw byte.
//     It used to be a literal NUL in the source, which made public/app.js read
//     as a *binary* file to grep, git and every diff viewer — the file silently
//     dropped out of content searches.
//
//  2. Input carrying that byte must be stripped before the sentinel is
//     introduced, or a digest can forge a placeholder. Not an injection (the
//     text is HTML-escaped first) but it either steals a <code> element or
//     renders the literal string "undefined".
//
// app.js is a classic script that touches the DOM at load, so it cannot be
// imported here. The functions are lifted out by brace matching instead — the
// same approach tests/shared-parity.test.js uses, and it fails loudly if any
// of them is renamed.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

/** Slice one top-level `function name(...) { ... }` out of the source. */
function sliceFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in public/app.js — was it renamed?`);
  let depth = 0;
  let i = SOURCE.indexOf('{', start);
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SOURCE.slice(start, i + 1);
}

// renderMarkdown leans on these two; give it the page's real ones.
const renderMarkdown = new Function(
  `${sliceFunction('escapeAttr')}\n${sliceFunction('safeHttpUrl')}\n${sliceFunction('renderMarkdown')}\nreturn renderMarkdown;`
)();

const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------

test('public/app.js contains no literal control characters', () => {
  // A single raw NUL is enough to make the whole file "binary" to grep.
  const offenders = [];
  for (let i = 0; i < SOURCE.length; i++) {
    const c = SOURCE.charCodeAt(i);
    const isControl = c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31);
    if (isControl) offenders.push({ index: i, code: c });
    if (offenders.length > 4) break;
  }
  assert.deepEqual(offenders, [],
    'write control characters as \\uXXXX escapes — a raw one makes app.js unsearchable');
});

test('inline code spans survive the other inline transforms', () => {
  const html = renderMarkdown('Use `const x = **not bold**` here.');
  assert.match(html, /<code>const x = \*\*not bold\*\*<\/code>/,
    'markdown inside a code span must be left alone');
});

test('several code spans on one line each keep their own contents', () => {
  const html = renderMarkdown('Compare `alpha` with `beta` and `gamma`.');
  assert.match(html, /<code>alpha<\/code>/);
  assert.match(html, /<code>beta<\/code>/);
  assert.match(html, /<code>gamma<\/code>/);
  assert.equal((html.match(/<code>/g) || []).length, 3);
});

test('a digest carrying the sentinel byte cannot forge a code span', () => {
  // The attack shape: text that looks like the placeholder the renderer uses
  // internally, arriving before any real code span has been registered.
  const html = renderMarkdown(`Nothing to see: ${NUL}CODE0${NUL} and more text.`);

  assert.ok(!html.includes(NUL), 'no sentinel byte may reach the output');
  assert.ok(!html.includes('<code>'), 'a forged placeholder must not become a code element');
  assert.ok(!html.includes('undefined'), 'nor may it resolve to a missing code span');
  assert.match(html, /Nothing to see: CODE0 and more text\./);
});

test('a forged sentinel cannot steal a real code span either', () => {
  const html = renderMarkdown(`${NUL}CODE0${NUL} then \`real code\`.`);
  assert.equal((html.match(/<code>/g) || []).length, 1, 'exactly the one real span');
  assert.match(html, /<code>real code<\/code>/);
});

test('ordinary formatting still renders', () => {
  const html = renderMarkdown('## Heading\n\n- **bold** item\n- _italic_ item\n\nA [link](https://example.com).');
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('HTML in the source is escaped, not rendered', () => {
  const html = renderMarkdown('A <script>alert(1)</script> tag and <b>bold</b>.');
  assert.ok(!html.includes('<script>'), 'script tags must not survive');
  assert.match(html, /&lt;script&gt;/);
});

test('a javascript: link is dropped but its text is kept', () => {
  const html = renderMarkdown('Click [here](javascript:alert(1)) now.');
  assert.ok(!/href="javascript:/i.test(html), 'unsafe schemes must not become links');
  assert.match(html, /here/);
});

test('tabs and newlines are preserved — only the unprintable ones go', () => {
  // The renderer splits on newlines, so stripping those would flatten every
  // digest into a single paragraph.
  const html = renderMarkdown('## One\n\n## Two');
  assert.match(html, /<h2>One<\/h2>/);
  assert.match(html, /<h2>Two<\/h2>/);
});
