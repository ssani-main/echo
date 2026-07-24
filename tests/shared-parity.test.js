import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Every copy of the shared text logic must agree with common/text.js.
//
// Two surfaces cannot import it: the extension's content script (MV3 classic
// scripts are not modules) and the page's inline <script>. They keep their own
// copies, so this file runs one corpus through every implementation and fails
// the moment any of them disagrees.
//
// This is not hypothetical tidiness. extractSummary() was wrong in all three of
// its copies for months — it returned nothing whenever a digest put a blank
// line after "## TL;DR", which is what the model actually writes — and no test
// caught it because every copy was equally wrong. Comparing them is what makes
// that class of bug loud.
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const canonical = require_(join(ROOT, 'common', 'text.js'));
const extension = require_(join(ROOT, 'extension', 'shared.js'));

/**
 * Lift a function out of the inline page script and make it callable.
 *
 * Crude on purpose: the alternative is a build step, which this repo does not
 * have and does not want. If the function is ever renamed this throws loudly,
 * which is the correct outcome — a silently skipped parity check is worse than
 * a failing one.
 */
function extractFunctionFromPage(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in public/app.js — was it renamed?`);

  // Walk braces from the function's opening brace to its matching close.
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

// The page's copy lives in app.js since index.html was split into real files.
const pageSource = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const pageExtractSummary = extractFunctionFromPage(pageSource, 'extractSummaryClient');

// --- Corpora ---------------------------------------------------------------

const VIDEO_ID_CASES = [
  'https://www.youtube.com/watch?v=GRzaq5AHiV8',
  'https://www.youtube.com/watch?v=GRzaq5AHiV8&t=42s',
  'https://www.youtube.com/watch?list=PL123&v=GRzaq5AHiV8',
  'https://youtu.be/GRzaq5AHiV8',
  'https://youtu.be/GRzaq5AHiV8?t=10',
  'https://www.youtube.com/shorts/GRzaq5AHiV8',
  'https://www.youtube.com/embed/GRzaq5AHiV8',
  'https://www.youtube.com/live/GRzaq5AHiV8',
  'GRzaq5AHiV8',
  '_-aBcDeFgHi',
  'https://www.youtube.com/',
  'https://www.youtube.com/feed/subscriptions',
  'https://www.youtube.com/@somechannel',
  'https://www.youtube.com/playlist?list=PL1234567890',
  'https://example.com/watch?v=GRzaq5AHiV8',
  'too-short',
  'waytoolongtobeavideoid',
  '',
  '   ',
];

const SUMMARY_CASES = [
  // The case that was broken everywhere: a blank line after the heading.
  '## TL;DR\n\nThe real point of the video.\n\n## Key Points\n- a',
  '## TL;DR\nNo blank line here.\n\n## Key Points\n- a',
  '## TL;DR\n\n\n\nSeveral blank lines.\n',
  '## TL;DR\n\n## Key Points\n- nothing under the heading',
  '# tl;dr\n\nLowercase heading, one hash.',
  '###### TLDR\n\nNo semicolon, six hashes.',
  '## Overview\n\nNo TL;DR at all, so the first paragraph wins.\nsecond line.\n\n## Next',
  'Just a bare paragraph with no headings whatsoever.',
  '## TL;DR\n\nWith **bold**, _italic_, `code` and a [link](https://example.com).',
  `## TL;DR\n\n${'a very long sentence that will need truncating. '.repeat(20)}`,
  '',
  '   \n  \n ',
  '## TL;DR\n\nUnicode — em dashes, “quotes”, and ellipses…',
];

// --- The checks ------------------------------------------------------------

test('the extension\'s extractVideoId agrees with common/text.js on every case', () => {
  for (const input of VIDEO_ID_CASES) {
    assert.equal(
      extension.echoExtractVideoId(input),
      canonical.extractVideoId(input),
      `extension/shared.js disagrees on: ${JSON.stringify(input)}`
    );
  }
});

test('the extension\'s extractVideoId handles junk identically', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(
      extension.echoExtractVideoId(input),
      canonical.extractVideoId(input),
      `extension/shared.js disagrees on: ${String(input)}`
    );
  }
});

test('the page\'s extractSummaryClient agrees with common/text.js on every case', () => {
  for (const digest of SUMMARY_CASES) {
    assert.equal(
      pageExtractSummary(digest),
      canonical.extractSummary(digest),
      `public/app.js disagrees on: ${JSON.stringify(digest.slice(0, 60))}`
    );
  }
});

test('the page\'s extractSummaryClient truncates at the same length', () => {
  const long = `## TL;DR\n\n${'word '.repeat(200)}`;
  const fromPage = pageExtractSummary(long);
  const fromCommon = canonical.extractSummary(long);
  assert.equal(fromPage, fromCommon);
  assert.ok(fromPage.endsWith('…'), 'both should mark the truncation');
});

test('the server and the Obsidian plugin use the shared module rather than a copy', async () => {
  // Not behaviour — identity. If either grows its own implementation again,
  // the parity corpus above would still pass while the copies drift apart on
  // the next edit, which is exactly how the last bug survived.
  const { extractVideoId } = await import('../transcript.js');
  const { extractSummary } = await import('../markdown.js');
  assert.equal(extractVideoId, canonical.extractVideoId, 'transcript.js should re-export the shared function');
  assert.equal(extractSummary, canonical.extractSummary, 'markdown.js should re-export the shared function');

  const pluginLib = require_(join(ROOT, 'obsidian-plugin', 'lib.js'));
  assert.equal(pluginLib.extractVideoId, canonical.extractVideoId, 'the plugin should require the shared function');
  assert.equal(pluginLib.extractSummary, canonical.extractSummary, 'the plugin should require the shared function');
});
