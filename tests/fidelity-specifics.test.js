import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpecifics, compareFidelity, hasCaseSignal, normalizeToken, isSentenceInitial,
} from '../tools/fidelity/specifics.mjs';

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

test('extractSpecifics: a caption line-wrap newline between a number and its magnitude word still counts as one gap', () => {
  // Regression guard for a real transcript: "Meta's Llama 3 ate through more
  // than 15 \ntrillion tokens" — a caption line-wrap put a newline right
  // after the ordinary space. A zero-or-one whitespace gap silently dropped
  // "trillion" and left a bare, unmatchable "15".
  const { numeric } = extractSpecifics('more than 15 \ntrillion tokens of text');
  assert.ok(numeric.has('15trillion'), `expected "15trillion" across the wrap, got ${[...numeric]}`);
});

test('extractSpecifics: ignores bare single digits, which carry no identity', () => {
  const { numeric } = extractSpecifics('There are 3 things and 4 reasons.');
  assert.equal(numeric.size, 0, 'single digits are noise, not specifics');
});

test('extractSpecifics: finds proper nouns, single and multi-word', () => {
  // Mid-paragraph, not sentence-initial, so this is a clean test of full-name
  // extraction on its own terms — see the sentence-initial tests below for
  // why a name at position 0 is deliberately handled differently.
  const { proper } = extractSpecifics('He recalled that Anna Kowalski went to Yale and later joined Deutsche Bank.');
  const found = [...proper];
  assert.ok(found.some((t) => t.includes('annakowalski')), `expected a full name, got ${found}`);
  assert.ok(found.some((t) => t.includes('yale')), `expected Yale, got ${found}`);
  assert.ok(found.some((t) => t.includes('deutschebank')), `expected Deutsche Bank, got ${found}`);
});

test('extractSpecifics: sentence-initial common words are not proper nouns', () => {
  const { proper } = extractSpecifics('The thing is that. And then it happened. But we knew.');
  assert.equal(proper.size, 0, `capitalised stopwords must not count: ${[...proper]}`);
});

// ---------------------------------------------------------------------------
// Proper-noun sentence-initial handling. Capitalisation at the start of a
// sentence/heading/bullet carries no information — English capitalises that
// word regardless of what it is — so a naive extractor reads Markdown digests
// (bold section leads, bullets) as full of invented "proper nouns" that are
// really just ordinary words sitting where a sentence happens to start.
// ---------------------------------------------------------------------------

test('extractSpecifics: a lone sentence-initial word is dropped, not counted as a proper noun', () => {
  const { proper } = extractSpecifics('Building a home lab is realistic today. Skipping straight to gear is the classic mistake.');
  assert.equal(proper.size, 0, `sentence-initial commonwords must not count: ${[...proper]}`);
});

test('extractSpecifics: the leading word of a sentence-initial multi-word run is dropped, the rest survives', () => {
  // "When" is only capitalised because it starts the sentence; "Logan Paul" is
  // a real name and must survive that word being dropped.
  const { proper } = extractSpecifics('When Logan Paul streamed the box opening, the market took off.');
  const found = [...proper];
  assert.ok(found.some((t) => t.includes('loganpaul')), `expected Logan Paul to survive, got ${found}`);
  assert.ok(!found.some((t) => t.startsWith('when')), `"When" must not survive: ${found}`);
});

test('extractSpecifics: a sentence-ending period no longer bridges into the next capitalised word', () => {
  // Regression guard for the real bug found in production data: the old
  // regex allowed '.' inside a proper-noun word, so "...the Senate. He
  // expects..." matched as ONE token, "senate.he" — a garbage compound that
  // reads as a fabricated specific when it is really two ordinary sentences.
  const { proper } = extractSpecifics('It was blocked by the Senate. He expects it to return this fall.');
  const found = [...proper];
  assert.ok(!found.some((t) => t.includes('.')), `no token should contain a literal period: ${found}`);
  assert.ok(!found.some((t) => t.includes('senate') && t.includes('he')),
    `"Senate" and "He" must not merge into one token: ${found}`);
  assert.ok(found.some((t) => t.includes('senate')), `Senate itself should still be extracted: ${found}`);
});

test('isSentenceInitial: true at the start of the text, after sentence punctuation, and after a newline', () => {
  const source = 'Hello there. World.\nNext line here';
  assert.equal(isSentenceInitial(source, 0), true, 'start of text');
  assert.equal(isSentenceInitial(source, source.indexOf('World')), true, 'after ". "');
  assert.equal(isSentenceInitial(source, source.indexOf('Next')), true, 'after a newline');
  assert.equal(isSentenceInitial(source, source.indexOf('there')), false, 'mid-sentence');
});

test('isSentenceInitial: sees through Markdown bold/heading decoration to the real boundary underneath', () => {
  const source = '## Heading\n\n**1. Workspace.** A bench and good lighting.';
  assert.equal(isSentenceInitial(source, source.indexOf('Heading')), true);
  assert.equal(isSentenceInitial(source, source.indexOf('Workspace')), true);
  assert.equal(isSentenceInitial(source, source.indexOf('bench')), false);
});

// ---------------------------------------------------------------------------
// normalizeToken — the currency-symbol bug and cross-format equivalence.
// ---------------------------------------------------------------------------

test('normalizeToken: matches the same figure written differently', () => {
  assert.equal(normalizeToken('1,200'), normalizeToken('1200'));
  assert.equal(normalizeToken('Yale.'), 'yale');
  assert.equal(normalizeToken("O’Brien"), "o'brien");
});

test('normalizeToken: strips currency symbols so a digest figure can match a bare transcript figure', () => {
  // The real bug: $/£/€/¥ used to survive normalisation, so "$270,000" in a
  // digest normalised to "$270000" and could never match a transcript's bare
  // "270,000" (-> "270000") however faithfully the digest quoted it.
  assert.equal(normalizeToken('$270,000'), normalizeToken('270,000'));
  assert.equal(normalizeToken('£100'), normalizeToken('100'));
  assert.equal(normalizeToken('€9'), normalizeToken('9'));
  assert.equal(normalizeToken('¥500'), normalizeToken('500'));
});

test('normalizeToken: a currency amount and a plain percentage stay distinct', () => {
  // Stripping the currency symbol must not collapse genuinely different
  // specifics — "$100" and "100%" describe different things.
  assert.notEqual(normalizeToken('$100'), normalizeToken('100%'));
});

// ---------------------------------------------------------------------------
// The second real bug: NUMERIC_RE's currency alternative used to stop at the
// digits, so "$450 billion" produced "$450" while a transcript's bare "450
// billion" produced "450billion" — the SAME quantity, tokenised two
// incompatible ways. The currency alternative now also consumes an optional
// trailing magnitude/percent word.
// ---------------------------------------------------------------------------

test('extractSpecifics: a currency-prefixed magnitude matches its bare transcript form', () => {
  const { numeric: digestNumeric } = extractSpecifics('The plan raises $450 billion a year.');
  const { numeric: transcriptNumeric } = extractSpecifics('Estimates put it at 450 billion a year.');
  const shared = [...digestNumeric].filter((t) => transcriptNumeric.has(t));
  assert.ok(shared.length > 0, `expected a shared token, digest=${[...digestNumeric]} transcript=${[...transcriptNumeric]}`);
});

test('extractSpecifics: comma and non-comma forms of the same currency figure match', () => {
  const { numeric: digestNumeric } = extractSpecifics('It sold for $270,000 at auction.');
  const { numeric: transcriptNumeric } = extractSpecifics('worth about 270000 dollars at auction');
  // Both sides should at minimum produce a token whose digits are "270000".
  const digestDigits = [...digestNumeric].map((t) => t.replace(/\D/g, ''));
  const transcriptDigits = [...transcriptNumeric].map((t) => t.replace(/\D/g, ''));
  assert.ok(digestDigits.includes('270000'), `digest missing 270000: ${[...digestNumeric]}`);
  assert.ok(transcriptDigits.includes('270000'), `transcript missing 270000: ${[...transcriptNumeric]}`);
});

// ---------------------------------------------------------------------------
// Negative cases — these matter more than the positive ones. They prove the
// fix does not overcorrect into false matches by comparing SUBSTRINGS instead
// of whole normalised tokens.
// ---------------------------------------------------------------------------

test('extractSpecifics/compareFidelity: "45" does not satisfy a transcript specific of "450"', () => {
  const transcript = 'Revenue hit $450 million that quarter.';
  const digest = 'Revenue was about $45 million that quarter.';
  const m = compareFidelity(transcript, digest);
  assert.ok(m.numeric.unsupported.length > 0, `"45" must not be silently matched against "450": ${JSON.stringify(m.numeric)}`);
  assert.ok(m.numeric.supportedRate < 1);
});

test('extractSpecifics/compareFidelity: "1.5 million" does not satisfy a transcript specific of "1.5 billion"', () => {
  const transcript = 'The fund is valued at 1.5 billion dollars.';
  const digest = 'The fund is valued at 1.5 million dollars.';
  const m = compareFidelity(transcript, digest);
  assert.ok(m.numeric.unsupported.length > 0, `1.5 million must not satisfy 1.5 billion: ${JSON.stringify(m.numeric)}`);
});

test('extractSpecifics: "$100" and "100%" remain distinct specifics after currency-stripping', () => {
  const { numeric } = extractSpecifics('It cost $100, a 100% markup over wholesale.');
  const found = [...numeric];
  assert.ok(found.includes('100') && found.includes('100%'), `expected both "100" and "100%": ${found}`);
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
