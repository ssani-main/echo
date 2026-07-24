import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpecifics, compareFidelity, hasCaseSignal, normalizeToken } from '../tools/fidelity/specifics.mjs';

// ---------------------------------------------------------------------------
// The fidelity metrics behind tools/fidelity/score-fidelity.mjs.
//
// These matter more than a dev tool's tests usually would: the eval exists to
// police the digest prompt's central promise, so an extractor that silently
// stops finding numbers would make a regressing prompt look perfect.
// ---------------------------------------------------------------------------

test('extractSpecifics: finds money, percentages, years and large numbers', () => {
  const { numeric } = extractSpecifics(
    'It went from €3.50 to €9, about 27% higher, back in 2019, with 12 million users.'
  );
  const found = [...numeric].join(' ');
  assert.match(found, /3\.50|350/);
  assert.match(found, /27/);
  assert.match(found, /2019/);
  assert.match(found, /12/);
});

test('extractSpecifics: ignores bare single digits, which carry no identity', () => {
  const { numeric } = extractSpecifics('There are 3 things and 4 reasons.');
  assert.equal(numeric.size, 0, 'single digits are noise, not specifics');
});

test('extractSpecifics: finds proper nouns, single and multi-word', () => {
  const { proper } = extractSpecifics('Anna Kowalski went to Yale and later joined Deutsche Bank.');
  const found = [...proper];
  assert.ok(found.some((t) => t.includes('annakowalski')), `expected a full name, got ${found}`);
  assert.ok(found.some((t) => t.includes('yale')), `expected Yale, got ${found}`);
  assert.ok(found.some((t) => t.includes('deutschebank')), `expected Deutsche Bank, got ${found}`);
});

test('extractSpecifics: sentence-initial common words are not proper nouns', () => {
  const { proper } = extractSpecifics('The thing is that. And then it happened. But we knew.');
  assert.equal(proper.size, 0, `capitalised stopwords must not count: ${[...proper]}`);
});

test('normalizeToken: matches the same figure written differently', () => {
  assert.equal(normalizeToken('1,200'), normalizeToken('1200'));
  assert.equal(normalizeToken('Yale.'), 'yale');
  assert.equal(normalizeToken("O’Brien"), "o'brien");
});

// ---------------------------------------------------------------------------
// hasCaseSignal — the guard that stops lowercase auto-captions from reading as
// a total failure of the proper-noun check.
// ---------------------------------------------------------------------------

test('hasCaseSignal: normal prose has case', () => {
  const prose = 'The speaker explained that Germany had changed. '.repeat(20);
  assert.equal(hasCaseSignal(prose), true);
});

test('hasCaseSignal: YouTube-style lowercase auto-captions do not', () => {
  const captions = 'so the thing about this is that when you look at it closely you realise '.repeat(10);
  assert.equal(hasCaseSignal(captions), false);
});

test('hasCaseSignal: too short to judge is treated as no signal', () => {
  assert.equal(hasCaseSignal('Short Text Here'), false);
});

// ---------------------------------------------------------------------------
// compareFidelity — the two halves of the prompt's promise.
// ---------------------------------------------------------------------------

test('compareFidelity: a faithful digest scores fully supported', () => {
  const transcript = 'A kebab in Berlin went from 3.50 euros to 9 euros between 2019 and 2024, roughly 157% up.';
  const digest = 'In Berlin a kebab rose from 3.50 euros to 9 euros between 2019 and 2024 — about 157%.';

  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${m.numeric.unsupported}`);
  assert.ok(m.numeric.retained >= 4);
});

test('compareFidelity: an invented number is flagged as unsupported', () => {
  // The failure mode the prompt exists to prevent: a confident specific the
  // source never stated.
  const transcript = 'Prices rose by about 5 percent last year according to an economist.';
  const digest = 'Prices rose 5.03 percent last year, according to The Economist, up from 2.1 percent in 2019.';

  const m = compareFidelity(transcript, digest);
  assert.ok(m.numeric.unsupported.length > 0, 'invented figures must be flagged');
  assert.ok(m.numeric.supportedRate < 1);
});

test('compareFidelity: dropping the transcript\'s specifics shows as low coverage', () => {
  const transcript = 'It went from 3.50 euros to 9 euros, a 157% rise, between 2019 and 2024 in Berlin.';
  const digest = 'Prices have risen a lot recently.';

  const m = compareFidelity(transcript, digest);
  assert.ok(m.numeric.coverage < 0.2, `expected low coverage, got ${m.numeric.coverage}`);
  // Nothing was invented, though — the two metrics must be independent.
  assert.equal(m.numeric.supportedRate, 1);
});

test('compareFidelity: proper-noun results are marked unusable for caseless transcripts', () => {
  const transcript = 'so he went to yale and then he joined the bank and it was fine '.repeat(10);
  const digest = 'He studied at Yale before joining the bank.';

  const m = compareFidelity(transcript, digest);
  assert.equal(m.proper.meaningful, false,
    'a lowercase transcript must not make every name look invented');
});

test('compareFidelity: reports compression alongside, since the metrics need it', () => {
  const transcript = 'word '.repeat(1000);
  const digest = 'word '.repeat(50);
  const m = compareFidelity(transcript, digest);
  assert.ok(m.compression > 0.04 && m.compression < 0.06, `got ${m.compression}`);
});

test('compareFidelity: empty digest does not divide by zero', () => {
  const m = compareFidelity('Some transcript with 2019 and 45%.', '');
  assert.equal(m.numeric.inDigest, 0);
  assert.equal(m.numeric.supportedRate, 1);
  assert.equal(m.digestChars, 0);
});
