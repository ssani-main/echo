import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpecifics, compareFidelity, hasCaseSignal, normalizeToken, isSentenceInitial,
  detectNumberConvention,
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

// ---------------------------------------------------------------------------
// The locale bug: normalizeToken() used to strip every comma unconditionally
// and leave every period alone — hardcoding the English convention. That
// broke Indonesian numbers two ways: a comma-decimal like "1,9%" mangled to
// "19%" and could never match the digest's correct "1.9%" (destroying a
// legitimate specific), AND the same mangling let a comma-decimal collide
// with a genuine, unrelated number sharing its digits (a false match, which
// is worse than a miss since nobody investigates a number the tool already
// says is fine). classifyNumberShape()/detectNumberConvention() now infer
// the convention per text instead of assuming one.
// ---------------------------------------------------------------------------

test('compareFidelity: a comma-decimal transcript figure matches its period-decimal digest translation', () => {
  const transcript = 'Bunganya cuma 1,9% sampai 2,19% per tahunnya.';
  const digest = 'The interest rate runs from 1.9% to 2.19% per year.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 2, `expected both figures to carry through: ${m.numeric.retained}`);
});

test('compareFidelity: Indonesian period-grouping ("800.000") matches the English comma-grouped form ("800,000")', () => {
  // "800.000" only resolves as grouping (rather than staying ambiguous)
  // because the surrounding "1,9%" gives the transcript decisive
  // comma-decimal evidence — see detectNumberConvention() tests below for
  // the case with no such evidence at all.
  const transcript = 'Omsetnya sebesar 800.000 dengan margin 1,9% tahun ini.';
  const digest = 'Revenue was 800,000 with a 1.9% margin this year.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  const found = [...extractSpecifics(digest).numeric].map((t) => t.replace(/\D/g, ''));
  assert.ok(found.includes('800000'), `expected an 800000 token in the digest, got ${found}`);
});

test('compareFidelity: comma-grouping still works with no other evidence ("270,000" matches "$270,000")', () => {
  const transcript = 'It eventually sold for 270,000 at the auction house.';
  const digest = 'It sold for $270,000 at auction.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 1);
});

test('compareFidelity: an Indonesian comma-decimal must not falsely support an unrelated fabricated "19"', () => {
  // The dangerous direction of the bug: the old code turned the transcript's
  // genuine "1,9" into "19", which could silently validate an entirely
  // unrelated, fabricated "19" in the digest. Written so it FAILS against
  // the pre-fix code (which reported full support here).
  const transcript = 'Nilainya sekitar 1,9 juta rupiah waktu itu, sesuai laporan resmi.';
  const digest = 'The report also claims 19 partner brands joined the platform that year.';
  const m = compareFidelity(transcript, digest);
  assert.ok(
    m.numeric.unsupported.some((t) => t.replace(/\D/g, '') === '19'),
    `the fabricated "19" must be flagged, not silently matched via the mangled "1,9": ${JSON.stringify(m.numeric)}`
  );
  assert.ok(m.numeric.supportedRate < 1, `supportedRate must reflect the fabrication: ${m.numeric.supportedRate}`);
});

test('detectNumberConvention: "1.234,56" (period grouping, comma decimal) is detected as comma-decimal', () => {
  const c = detectNumberConvention('The total reached 1.234,56 units last quarter.');
  assert.equal(c.decimalSep, ',');
  assert.equal(c.groupingSep, '.');
  assert.equal(c.confident, true);
});

test('detectNumberConvention: "1,234.56" (comma grouping, period decimal) is detected as period-decimal', () => {
  const c = detectNumberConvention('The total reached 1,234.56 units last quarter.');
  assert.equal(c.decimalSep, '.');
  assert.equal(c.groupingSep, ',');
  assert.equal(c.confident, true);
});

test('detectNumberConvention: no separator evidence at all falls back to English, explicitly unconfident', () => {
  const c = detectNumberConvention('Revenue grew steadily throughout the year with no notable events.');
  assert.equal(c.decimalSep, '.');
  assert.equal(c.groupingSep, ',');
  assert.equal(c.confident, false, 'the fallback must be flagged as a guess, not treated as real evidence');
});

test('compareFidelity: an ambiguous "1.500" with no disambiguating evidence stays flagged rather than matching either reading', () => {
  const transcript = 'The estimate was roughly 1.500 units, though exact figures were not confirmed.';
  const digestAsDecimal = 'The estimate was about 1.5 units.';
  const digestAsThousand = 'The estimate was about 1500 units.';

  const mDecimal = compareFidelity(transcript, digestAsDecimal);
  assert.ok(
    mDecimal.numeric.unsupported.some((t) => t.includes('1.5')),
    `the decimal reading must not silently match: ${JSON.stringify(mDecimal.numeric)}`
  );

  const mThousand = compareFidelity(transcript, digestAsThousand);
  assert.ok(
    mThousand.numeric.unsupported.some((t) => t.includes('1500')),
    `the thousands reading must not silently match either: ${JSON.stringify(mThousand.numeric)}`
  );
});

// ---------------------------------------------------------------------------
// Indonesian magnitude words (ribu/juta/miliar/triliun). Confirmed against
// the real corpus: "40 miliar"/"229 triliun"/"18 juta"/"150 miliar" in
// transcripts against a digest's correct "40 billion"/"229 trillion"/"18
// million"/"150 billion" — all faithful translations, all previously scored
// unsupported because MAGNITUDE_WORD didn't know the Indonesian words at
// all. Simply recognising the words is not enough on its own — "18juta" and
// "18million" are still two different strings unless the scale word is
// canonicalised to a common form first (MAGNITUDE_CANON).
// ---------------------------------------------------------------------------

test('compareFidelity: Indonesian "juta" in a transcript matches a digest\'s "million"', () => {
  const transcript = 'Sisa uang gue tinggal 18 juta buat modal awal.';
  const digest = 'He had 18 million left as starting capital.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 1);
});

test('compareFidelity: Indonesian "miliar" in a transcript matches a digest\'s "billion"', () => {
  const transcript = 'Penerbitannya sebesar 40 miliar yuan tahun ini.';
  const digest = 'The issuance totalled 40 billion yuan this year.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 1);
});

test('compareFidelity: Indonesian "triliun" in a transcript matches a digest\'s "trillion"', () => {
  const transcript = 'Anggarannya diturunkan jadi 229 triliun per tahunnya.';
  const digest = 'The budget was cut to 229 trillion per year.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 1);
});

test('compareFidelity: Indonesian "ribu" in a transcript matches a digest\'s "thousand"', () => {
  const transcript = 'Harganya sekitar 15 ribu rupiah per porsi.';
  const digest = 'It costs about 15 thousand rupiah per portion.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(m.numeric.retained >= 1);
});

test('extractSpecifics/compareFidelity: canonicalising Indonesian scale words does not collapse distinct quantities', () => {
  // The hard constraint: "18 juta" must still not satisfy "18 miliar" — a
  // scale-word translation table must never merge across scales.
  const transcript = 'Modal awalnya cuma 18 juta doang waktu itu.';
  const digest = 'His starting capital was 18 miliar rupiah.'; // wrong translation on purpose
  const m = compareFidelity(transcript, digest);
  assert.ok(
    m.numeric.unsupported.some((t) => t.includes('18') && t.includes('billion')),
    `18 miliar must not be silently satisfied by a transcript's 18 juta: ${JSON.stringify(m.numeric)}`
  );
});

// ---------------------------------------------------------------------------
// Range dashes ("4.7–5.6%", "1.9–2.19%"): NUMERIC_RE attaches the unit only
// to the SECOND number, so the first number's bare token can never match a
// transcript's suffixed form of the same figure. A prior attempt forced the
// suffix onto the first number and made the corpus measurably worse (see the
// comment above RANGE_RE in specifics.mjs for the full story, including a
// second, also-reverted attempt at an additive fix); the shipped fix lets
// the first number's EXISTING bare token also count as matched via an
// alternate suffixed reading, without ever adding a new token to either set.
// ---------------------------------------------------------------------------

test('compareFidelity: the first number of a dash range matches a transcript that states it WITH the unit', () => {
  const transcript = 'Bunganya sekitar 4,7% dan bisa naik sampai 5,6% tergantung tenornya.';
  const digest = 'The interest rate runs 4.7–5.6% depending on tenor.';
  const m = compareFidelity(transcript, digest);
  assert.equal(m.numeric.supportedRate, 1, `unsupported: ${JSON.stringify(m.numeric.unsupported)}`);
  assert.ok(!m.numeric.unsupported.includes('4.7'), `"4.7" (the range's first number) should be matched: ${JSON.stringify(m.numeric.unsupported)}`);
});

test('compareFidelity: the first number of a dash range ALSO matches a transcript that states it bare (no unit)', () => {
  const transcript = 'Rate-nya kira-kira 4.7 di awal, lalu naik.';
  const digest = 'The interest rate runs 4.7–5.6% depending on tenor.';
  const m = compareFidelity(transcript, digest);
  assert.ok(!m.numeric.unsupported.includes('4.7'), `a bare transcript "4.7" should still satisfy the range's first number: ${JSON.stringify(m.numeric.unsupported)}`);
});

test('compareFidelity: fixing the range dash does not dilute an already-correct bare-to-bare match', () => {
  // The regression the additive attempt introduced: a spoken range like
  // "200 to $230 billion" leaves a bare "200" on BOTH sides, and that bare
  // match already worked. The fix must not add a new "200billion" token
  // that inflates inDigest without a matching transcript token.
  const transcript = 'FDI is attracting about 200 to $230 billion a year.';
  const digest = 'Annual FDI runs 200–230 billion.';
  const before = compareFidelity(transcript, 'Annual FDI runs about 200 a year.'); // bare-only baseline
  const after = compareFidelity(transcript, digest);
  assert.equal(after.numeric.inDigest, before.numeric.inDigest + 1, 'only the new "230billion" token should add to the count, not a second one for "200"');
  assert.ok(!after.numeric.unsupported.includes('200'), `the pre-existing bare "200" match must survive: ${JSON.stringify(after.numeric.unsupported)}`);
});

test('extractSpecifics: "in 2021 to 19%" does not synthesise a bogus "2021%" token — the documented false-match regression', () => {
  // This is why "to" must never be treated as a range connector: only an
  // explicit dash (hyphen/en dash/em dash) qualifies.
  const { numeric } = extractSpecifics('Growth flipped in 2021 to 19% by the following year.');
  assert.ok(!numeric.has('2021%'), `"2021%" must never be synthesised: ${[...numeric]}`);
  assert.ok(numeric.has('2021') && numeric.has('19%'), `2021 and 19% should still be extracted separately: ${[...numeric]}`);
});

test('compareFidelity: "in 2021 to 19%" does not falsely support a fabricated "2021%" specific', () => {
  const transcript = 'Growth flipped in 2021 to 19% by the following year.';
  const digest = 'The report claims a bizarre 2021% growth figure.'; // deliberately absurd, must not be validated
  const m = compareFidelity(transcript, digest);
  assert.ok(
    m.numeric.unsupported.some((t) => t === '2021%'),
    `a fabricated "2021%" must be flagged, not matched via the "to" connector: ${JSON.stringify(m.numeric)}`
  );
});
