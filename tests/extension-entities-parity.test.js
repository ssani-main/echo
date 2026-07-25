import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// extension/shared.js's echoDecodeEntities() is a THIRD copy of a small piece
// of logic: transcript.js's decodeEntities() is the original, and the
// extension keeps its own copy because it cannot import server code. This
// repo's CLAUDE.md documents at length how copied functions drift silently
// (extractSummary() was wrong in all three of its copies for months before
// anyone noticed) — so this file runs one corpus through both
// implementations and fails the moment they disagree.
//
// Neither function is exported from its module in the normal sense:
// transcript.js deliberately does NOT export decodeEntities (adding an
// export just to satisfy a test would widen its public surface for no
// reason), so — following the same technique tests/shared-parity.test.js
// uses for the page's inline copy — both functions are extracted from their
// source TEXT and made callable.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lift a top-level function out of a source file and make it callable.
 *
 * Crude on purpose: the alternative is a build step, which this repo does
 * not have and does not want. If the function is ever renamed this throws
 * loudly, which is the correct outcome — a silently skipped parity check is
 * worse than a failing one.
 */
function extractFunctionFromSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found — was it renamed?`);

  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = source.slice(open + 1, i);
  const args = source.slice(source.indexOf('(', start) + 1, source.indexOf(')', start));
  // eslint-disable-next-line no-new-func
  return new Function(args, body);
}

const transcriptSource = readFileSync(join(ROOT, 'transcript.js'), 'utf8');
const sharedSource = readFileSync(join(ROOT, 'extension', 'shared.js'), 'utf8');

const canonicalDecodeEntities = extractFunctionFromSource(transcriptSource, 'decodeEntities');
const extensionDecodeEntities = extractFunctionFromSource(sharedSource, 'echoDecodeEntities');

// --- Corpus ------------------------------------------------------------

const ENTITY_CASES = [
  "&#39;",
  "&amp;#39;",
  '&quot;',
  '&amp;quot;',
  '&amp;',
  '&amp;amp;',
  '&lt;',
  '&gt;',
  // Real caption-like prose with several entities mixed in.
  "Here&#39;s the thing &amp; it&#39;s &quot;important&quot;: x &lt; y &gt; z.",
  // No entities at all.
  'A plain sentence with no entities whatsoever.',
  // Empty string.
  '',
  // Pins the replacement ORDER: &amp;amp; must be handled as its own unit
  // BEFORE the plain &amp; replacement runs. If &amp; ran first, the regex
  // would consume the leading "&amp;" out of "&amp;amp;" (matches are found
  // against the original string, not re-scanned after substitution) and
  // leave "&amp;" behind unresolved — one entity short of "&". Correct order
  // fully decodes it to "&"; naive amp-first order stops at "&amp;".
  '&amp;amp;',
];

test('the extension\'s echoDecodeEntities agrees with transcript.js\'s decodeEntities on every case', () => {
  for (const input of ENTITY_CASES) {
    assert.equal(
      extensionDecodeEntities(input),
      canonicalDecodeEntities(input),
      `extension/shared.js disagrees on: ${JSON.stringify(input)}`
    );
  }
});

test('reversing the &amp; / &amp;amp; replacement order would break the pinned case', () => {
  // Sanity-check the pinned case actually exercises the ordering bug it
  // claims to, independent of the two real implementations: apply the
  // replacements in the WRONG order (&amp; before &amp;amp;) and confirm it
  // disagrees with the correct, canonical result.
  const input = '&amp;amp;';
  const wrongOrder = input
    .replace(/&amp;/g, '&')
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  assert.notEqual(wrongOrder, canonicalDecodeEntities(input));
});
