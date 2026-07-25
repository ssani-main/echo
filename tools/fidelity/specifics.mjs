// Fidelity metrics for digests: how many of the transcript's concrete specifics
// survive, and how many specifics the digest states that the transcript never did.
//
// This exists because Echo's positioning rests on a claim the digest prompt
// makes explicitly — "KEEP every concrete specific", "NEVER manufacture a
// specific the transcript does not contain" — and a claim nobody measures is a
// claim nobody should believe. These are the two halves of that promise, and
// they pull in opposite directions: a digest that copies everything scores
// perfectly on retention, and one that says almost nothing scores perfectly on
// invention. Read them together, against the compression ratio.
//
// Deliberately deterministic and model-free: no API call, no judge, no
// nondeterminism. It measures a necessary condition for faithfulness, not
// faithfulness itself — a digest can preserve every number and still misread
// the video.

// Numbers, money, percentages, years, times. The robust signal: digits survive
// even in YouTube's lowercase, unpunctuated auto-captions.
//
// The currency-prefixed alternative also swallows an optional trailing
// magnitude/percent word (e.g. "$450 billion"), so a digest's "$450 billion"
// and a transcript's bare "450 billion" normalise to the SAME token instead of
// silently talking past each other ("$450" vs "450billion").
//
// The gap between a number and its magnitude word is `\s*` (zero or more),
// not `\s?` (zero or one) — a real transcript had "15 \ntrillion" (a caption
// line-wrap landed a newline right after the ordinary space), which a
// zero-or-one gap can't bridge. That silently dropped the magnitude word,
// leaving a bare "15" that could never match the digest's cleanly-formatted
// "15 trillion". Any run of whitespace between a number and its unit is the
// same unit, however it happened to wrap.
// Indonesian scale words added alongside their English equivalents: "juta",
// "miliar", "triliun" and "ribu" turn up throughout the corpus ("40 miliar",
// "229 triliun", "18 juta", "150 miliar" against a digest's correct "40
// billion"/"229 trillion"/"18 million"/"150 billion") and were previously
// invisible to this regex, so a faithful translation could never be scored
// as supported. "jt" and "rb" are the common informal-text abbreviations for
// juta/ribu and are narrow enough (word-bounded, like the existing "k"/"bn")
// to add safely; a bare "m"/"b" is NOT added — English "million" and
// Indonesian "miliar" would both plausibly abbreviate to "M", and guessing
// wrong would silently manufacture a false match, which is worse than
// leaving the abbreviation unmatched.
const MAGNITUDE_WORD = '(?:%|percent|dollars?|euros?|pounds?|million|billion|trillion|thousand|juta|miliar|triliun|ribu|k\\b|bn\\b|jt\\b|rb\\b)';
const NUMERIC_RE = new RegExp(
  `(?:[$€£¥]\\s*\\d[\\d,.]*(?:\\s*${MAGNITUDE_WORD})?|\\d[\\d,.]*\\s*${MAGNITUDE_WORD}|\\b\\d{4}s?\\b|\\b\\d+(?:[.,]\\d+)?\\b)`,
  'gi'
);

// Indonesian (and informal-abbreviation) scale words canonicalise to their
// English equivalent BEFORE joining the number, so "18 juta" and "18
// million" normalise to the exact same token ("18million") instead of two
// tokens that can never match. This is deliberately a translation table, not
// a numeric power-of-ten merge: every English scale word maps to itself
// (identity), so existing tokens like "15trillion" are completely unchanged.
// Indonesian uses the short scale, same as English (ribu=10^3, juta=10^6,
// miliar=10^9, triliun=10^12 — verified against this corpus, not assumed),
// so each maps to the single English word at the same power of ten and
// nothing merges across scales: "1.5 million" still normalises differently
// from "1.5 billion", and "18 juta" still cannot satisfy "18 miliar".
const MAGNITUDE_CANON = {
  ribu: 'thousand', rb: 'thousand',
  juta: 'million', jt: 'million',
  miliar: 'billion',
  triliun: 'trillion',
};

// A range like "4.7–5.6%" or "1.9–2.19%" attaches the unit only to the
// SECOND number, so on its own NUMERIC_RE extracts a bare, unmatchable first
// number. A previous attempt fixed this by forcing the shared suffix onto
// the first number (replacing the bare token), and it made the corpus
// measurably WORSE: (a) the transcript side is frequently just as
// inconsistent about attaching the suffix to a spoken range's first number
// ("...FDI of about 200 to $230 billion..." leaves a bare "200" on BOTH
// sides), so forcing a suffix on only one side turned a previously-correct
// bare-to-bare match into a mismatch; and (b) a literal "to" connector
// produced a real false match — "...in 2021 to 19%..." synthesised a bogus
// "2021%" token that no one intended.
//
// A second attempt (also measured and also reverted, mid-development of
// THIS fix) tried to fix that by keeping the bare token and ADDING a second,
// suffixed token as a new member of the numeric set — "gain the match
// without losing the bare one". That still made the corpus worse, for a
// subtler reason: adding a set member changes `inDigest`/`inTranscript`
// (the denominator), not just `retained`. Whenever the guessed suffix did
// NOT happen to appear on the other side — exactly the "200 to $230
// billion" shape above, which is common and was already matching fine via
// its bare form — the new member counted as an extra "stated" specific with
// no match, and net-diluted a specific that was already fully supported.
//
// The fix that actually works leaves the SET OF TOKENS untouched (so
// `inDigest`/`inTranscript` never change) and instead only widens what
// counts as a MATCH for a token already in that set: RANGE_RE below
// identifies a dash-connected range's first number and records, in a
// side-table (not the numeric Set), the suffixed form it could also
// legitimately mean. compareFidelity() consults that table only to decide
// whether an existing bare token should count as retained — it can turn an
// existing unsupported token into a supported one, but it can never create
// a new one, so it cannot dilute a match that already worked.
//
// Deliberately narrow: only a hyphen/en dash/em dash directly between two
// numbers, with the unit attached to the second — never the word "to"
// (that's the documented false-match case above; "to" is simply never
// treated as a connector by this pattern at all, not filtered out after the
// fact). This cannot leak into non-range numbers: it only ever adds an
// alternate reading for the exact bare token sitting before the dash, and
// every other number's matching is completely unaffected.
const RANGE_RE = new RegExp(
  `(\\d[\\d,.]*)\\s*[-–—]\\s*(\\d[\\d,.]*\\s*${MAGNITUDE_WORD})`,
  'gi'
);

// Capitalised multi-word or standalone proper nouns. Weaker signal: only
// meaningful when the source is punctuated and cased (Whisper output is;
// YouTube auto-captions frequently are not — see readCaseSignal()).
//
// Deliberately does NOT include '.' in the word-character class. It used to,
// to allow abbreviations like "U.S." — but that also let the match bridge a
// real sentence boundary ("...blocked by the Senate. He expects...") into one
// garbage compound token ("senate.he"), because a trailing sentence period
// plus the following capitalised word looks identical to an abbreviation
// period to a regex with no notion of sentences. Losing "U.S." as one token is
// a smaller cost than every cross-sentence merge being reported as a
// fabricated specific.
const PROPER_RE = /\b[A-Z][a-zA-Z0-9'’-]*(?:\s+[A-Z][a-zA-Z0-9'’-]*)*\b/g;

// Words that start sentences or are simply common; capitalisation tells us
// nothing about them, so they would swamp the proper-noun signal.
const PROPER_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'if', 'then', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'what', 'when', 'where', 'why', 'how', 'who', 'there', 'here', 'now', 'not', 'no',
  'yes', 'ok', 'okay', 'well', 'just', 'like', 'really', 'very', 'more', 'most', 'some', 'all',
  'one', 'two', 'three', 'first', 'second', 'next', 'last', 'also', 'because', 'about',
  'tldr', 'key', 'points', 'summary', 'detailed', 'part', 'echo',
]);

/**
 * Split a digits-and-separators string into its digit groups and the
 * separator characters between them, e.g. "1,234.56" -> parts ["1","234",
 * "56"], seps [",","."]. Pure plumbing for classifyNumberShape() and
 * normalizeToken() below — kept separate so both use the exact same split.
 *
 * @param {string} raw - digits and '.'/',' only (no currency, no magnitude word)
 * @returns {{ parts: string[], seps: string[] }}
 */
function splitNumberParts(raw) {
  const segs = String(raw).split(/([.,])/);
  const parts = [];
  const seps = [];
  segs.forEach((seg, i) => {
    if (i % 2 === 0) parts.push(seg);
    else seps.push(seg);
  });
  return { parts, seps };
}

/**
 * Classify how a single number's separator(s) should be read, using rules
 * that hold regardless of which convention (English, Indonesian, German...)
 * the text follows:
 *
 *  - two DIFFERENT separator characters in one number (e.g. "1,234.56" or
 *    "1.234,56"): the number has one decimal point at most, so the LAST
 *    separator must be it; anything earlier is grouping.
 *  - the SAME separator repeated 2+ times (e.g. "7.200.000"): a number
 *    cannot have two decimal points, so it must be pure grouping — there is
 *    no decimal point in the number at all.
 *  - a single separator whose trailing digit run is NOT exactly 3 digits
 *    (e.g. "1,9", "3.50"): a grouping separator always produces exactly
 *    3-digit groups, so this one can only be a decimal point.
 *  - a single separator whose trailing digit run IS exactly 3 digits (e.g.
 *    "800.000", "270,000"): genuinely ambiguous in isolation — could be a
 *    thousands group or a (unusual) 3-digit decimal fraction. Resolved by
 *    detectNumberConvention()/normalizeToken() using the rest of the text.
 *
 * @param {{ parts: string[], seps: string[] }} split
 * @returns {null|{kind:'decisive', decimalSep: string|null, groupingSep?: string}|{kind:'ambiguous', sep: string}}
 *   null when there is no separator to classify at all.
 */
function classifyNumberShape({ parts, seps }) {
  if (seps.length === 0) return null;
  const uniqueSeps = new Set(seps);
  if (uniqueSeps.size === 2) {
    return { kind: 'decisive', decimalSep: seps[seps.length - 1] };
  }
  if (seps.length >= 2) {
    return { kind: 'decisive', decimalSep: null, groupingSep: seps[0] };
  }
  const sep = seps[0];
  const lastLen = parts[parts.length - 1].length;
  if (lastLen !== 3) {
    return { kind: 'decisive', decimalSep: sep };
  }
  return { kind: 'ambiguous', sep };
}

/** The convention assumed when a text gives no evidence either way at all —
 * ordinary English: period decimal, comma grouping. Every English-only
 * transcript/digest with no large grouped numbers or foreign-style decimals
 * looks exactly like this, so it is the only defensible default. */
const ENGLISH_FALLBACK_CONVENTION = Object.freeze({ decimalSep: '.', groupingSep: ',', confident: false });

// Loose enough to catch a full multi-separator run ("7.200.000") that
// NUMERIC_RE itself would only partially capture — this is used purely to
// gather text-wide evidence of which separator a text uses for what, not to
// extract reportable specifics, so being looser here is safe.
const RAW_NUMBER_WITH_SEPARATOR_RE = /\d[\d.,]*\d|\d/g;

/**
 * Decide, from the evidence IN THIS TEXT ALONE, whether it reads numbers in
 * the comma-decimal convention (Indonesian, German, ...: "1,9%", "800.000")
 * or the period-decimal convention (English: "1.9%", "800,000").
 *
 * Only numbers classifyNumberShape() calls decisive contribute a vote —
 * the ambiguous group-of-3 shape ("800.000" in isolation) never votes on its
 * own, which is exactly why a lone "1.500" stays unresolved rather than
 * silently deciding the whole text's convention from one ambiguous number.
 *
 * transcript and digest must be judged independently (a translated pair can
 * legitimately use two different conventions), so this takes one text and
 * callers run it once per side.
 *
 * @param {string} text
 * @returns {{decimalSep: string, groupingSep: string, confident: boolean}}
 */
export function detectNumberConvention(text) {
  const votes = { ',': 0, '.': 0 };
  for (const raw of String(text || '').match(RAW_NUMBER_WITH_SEPARATOR_RE) || []) {
    const shape = classifyNumberShape(splitNumberParts(raw));
    if (!shape || shape.kind !== 'decisive') continue;
    if (shape.decimalSep) {
      votes[shape.decimalSep] += 1;
    } else if (shape.groupingSep) {
      // Pure repeated-separator grouping implies the OTHER character is the
      // text's decimal separator, by elimination.
      votes[shape.groupingSep === ',' ? '.' : ','] += 1;
    }
  }
  if (votes[','] > votes['.']) return { decimalSep: ',', groupingSep: '.', confident: true };
  if (votes['.'] > votes[',']) return { decimalSep: '.', groupingSep: ',', confident: true };
  // No decisive evidence either way, or a genuine tie — fall back to English
  // rather than guess (see ENGLISH_FALLBACK_CONVENTION above).
  return { ...ENGLISH_FALLBACK_CONVENTION };
}

/**
 * Normalise a token for comparison: casefold, strip trailing punctuation and
 * currency symbols, then — for anything that looks like a number — resolve
 * its separators to ONE canonical form so the same quantity written under
 * different conventions compares equal.
 *
 * Currency symbols matter here because they used to survive unstripped, so a
 * digest's "$270,000" normalised to "$270000" and could never match a
 * transcript's bare "270,000" (which normalises to "270000") — every
 * currency figure in a digest was structurally unmatchable, however faithful
 * it was. Stripping the symbol on both sides is safe precisely because the
 * two sides are compared as sets of *specifics*, not prose: "$100" and "100"
 * describe the same quantity once the currency marker is gone, which is what
 * we want when comparing a digest's rendering against the transcript's.
 * Distinctness that actually matters (e.g. "$100" vs "100%") is preserved by
 * the magnitude/percent word staying part of the token — a percent sign is
 * not a currency symbol, so it is untouched here.
 *
 * The separator handling used to just strip every comma unconditionally and
 * leave every period alone — hardcoding the English convention. That broke
 * on Indonesian numbers two ways at once: "1,9%" (a decimal) collapsed to
 * "19%", which could never match a transcript's correct "1.9%" AND could
 * silently collide with a genuine, unrelated "19" elsewhere in the same
 * text (a false match — worse than a missed one, since nobody double-checks
 * a number the tool says is fine); and "800.000" (Indonesian thousands
 * grouping) was read as the decimal 800 instead of 800,000. Every number
 * that reaches this function with a separator is now classified by
 * classifyNumberShape() first; only the genuinely ambiguous group-of-3 shape
 * consults `convention` (from detectNumberConvention() on the whole text) or
 * falls back to English — see there for exactly which numbers are decisive
 * on their own versus which need that context.
 *
 * @param {string} token
 * @param {{decimalSep: string, groupingSep: string, confident: boolean}} [convention]
 *   text-wide convention from detectNumberConvention(); defaults to the
 *   unconfident English fallback so existing single-argument callers (every
 *   proper-noun normalisation, and any caller not tracking convention) keep
 *   their prior behaviour.
 */
export function normalizeToken(token, convention = ENGLISH_FALLBACK_CONVENTION) {
  const t = String(token || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,;:!?]+$/, '')
    .replace(/[$€£¥]/g, '');

  const numberMatch = t.match(/^(\d[\d.,]*)([\s\S]*)$/);
  if (!numberMatch) {
    // Not a numeric token at all (a proper-noun word, etc.) — old behaviour.
    return t.replace(/[\s,]/g, '').trim();
  }

  const [, numericPart, rest] = numberMatch;
  const rawSuffix = rest.replace(/\s+/g, '');
  // Translate a scale word to its English form (identity for English words
  // themselves) so "juta"/"million" etc. join the number into the same
  // token — see MAGNITUDE_CANON above.
  const suffix = MAGNITUDE_CANON[rawSuffix] || rawSuffix;
  const split = splitNumberParts(numericPart);
  const shape = classifyNumberShape(split);

  if (!shape) {
    // No separator at all: nothing to disambiguate.
    return numericPart + suffix;
  }

  if (shape.kind === 'decisive') {
    if (shape.decimalSep === null) {
      // Pure repeated grouping — no decimal point in this number at all.
      return split.parts.join('') + suffix;
    }
    const decimalIndex = split.seps.lastIndexOf(shape.decimalSep);
    const wholePart = split.parts.slice(0, decimalIndex + 1).join('');
    const fractionPart = split.parts[decimalIndex + 1];
    return `${wholePart}.${fractionPart}${suffix}`;
  }

  // Ambiguous shape: a single separator followed by exactly 3 digits, with
  // nothing else in the number itself to resolve it.
  const { sep } = shape;
  if (sep === ',' && !convention.confident) {
    // No text-wide evidence either way. A comma followed by exactly 3
    // digits reads as thousands-grouping in essentially every real-world
    // convention — a genuine 3-digit comma-decimal fraction ("1,900" as
    // 1.900) is vanishingly rare — so this one ambiguous shape is safe to
    // resolve without corroborating evidence. This preserves the
    // long-standing behaviour of "270,000" matching "$270,000".
    return split.parts.join('') + suffix;
  }

  if (convention.confident) {
    return sep === convention.decimalSep
      ? `${split.parts.join('.')}${suffix}` // only valid when exactly one separator, checked above
      : split.parts.join('') + suffix;
  }

  // A lone period followed by exactly 3 digits with no text-wide evidence
  // either way — genuinely ambiguous between a decimal ("1.500" = 1.5) and a
  // thousands group ("1.500" = 1500). Flag it rather than guess: this
  // sentinel cannot collide with any real normalised numeric token, so it
  // shows up as unmatched (a flag for a human), never as a false match.
  return `~ambiguous~${numericPart}${suffix}`;
}

/**
 * Does this text look like it carries case information at all?
 *
 * YouTube's auto-captions are often entirely lowercase, which would make every
 * proper-noun measurement read as a catastrophic failure when nothing is wrong.
 * Callers use this to decide whether the proper-noun half of the report means
 * anything for a given entry.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasCaseSignal(text) {
  const letters = String(text || '').replace(/[^a-zA-Z]/g, '');
  if (letters.length < 200) return false;
  const upper = (letters.match(/[A-Z]/g) || []).length;
  const ratio = upper / letters.length;
  // Normal English prose runs a few percent uppercase. Below 1% means the
  // source is effectively caseless.
  return ratio >= 0.01;
}

// A boundary a new "sentence" can start after: end-of-sentence punctuation,
// a colon (introduces a clause/list item), or a list/bullet dash.
const SENTENCE_BOUNDARY_RE = /[.!?:\-+]/;

/**
 * Is the character at `index` the start of a new sentence, heading or list
 * item, as best a regex-only tool can tell without real sentence splitting?
 *
 * This exists because capitalisation at a sentence/line start carries NO
 * information — English capitalises the first word of every sentence
 * regardless of what the word is — so a capitalised "Building", "Skipping" or
 * "He's" at that position is not evidence of a proper noun, just evidence of
 * where a sentence began. Digest Markdown makes this worse than ordinary
 * prose: bold section leads (`**1. Workspace.**`) and bullet items put a
 * capitalised common word at the start of a huge fraction of lines.
 *
 * Walks backward from `index` over whitespace and Markdown decoration
 * (`*`, `_`, `#`, `>`, `` ` ``) — invisible formatting that doesn't change
 * what "starts" the sentence underneath it — until it hits a real character.
 * A newline anywhere in that run always means "yes" (every new line in a
 * digest is a fresh heading, bullet or paragraph). Otherwise it's "yes" only
 * if the real character found is sentence/list-boundary punctuation, or there
 * is no real character at all (start of the whole text).
 *
 * @param {string} source
 * @param {number} index
 * @returns {boolean}
 */
export function isSentenceInitial(source, index) {
  let i = index;
  while (i > 0) {
    const ch = source[i - 1];
    if (ch === '\n') return true;
    if (/\s/.test(ch) || '*_#>`'.includes(ch)) {
      i -= 1;
      continue;
    }
    break;
  }
  if (i === 0) return true;
  return SENTENCE_BOUNDARY_RE.test(source[i - 1]);
}

/**
 * Pull the concrete specifics out of a piece of text.
 *
 * `numericRangeAlts` maps a bare numeric token to the OTHER forms it may
 * legitimately mean, when it was the first number of a dash range whose
 * second number carried a unit (see RANGE_RE above) — e.g. "4.7" -> {"4.7%"}
 * from "4.7–5.6%". It never adds a member to `numeric` itself; it is a
 * side-table compareFidelity() consults to decide whether a token already in
 * `numeric` should also count as matched under an alternate reading, without
 * ever changing how many specifics a text is considered to state.
 *
 * @param {string} text
 * @returns {{ numeric: Set<string>, proper: Set<string>, numericRangeAlts: Map<string, Set<string>> }}
 */
export function extractSpecifics(text) {
  const source = String(text || '');
  // Transcript and digest are judged independently: a faithful digest can
  // legitimately translate Indonesian "1,9%" into English "1.9%", so each
  // side's own separator convention is detected from its own text, not
  // assumed to match the other side's.
  const convention = detectNumberConvention(source);

  const numeric = new Set();
  for (const match of source.match(NUMERIC_RE) || []) {
    const norm = normalizeToken(match, convention);
    // Bare single digits are noise ("one of 3 things"); they carry no identity.
    if (!norm || norm.replace(/\D/g, '').length < 2) continue;
    numeric.add(norm);
  }

  // Range fix (see RANGE_RE above): record the suffixed alternate reading of
  // a dash range's first number WITHOUT adding it to `numeric` — see the
  // function doc for why this side-table, and not a second Set member, is
  // what keeps the fix from diluting matches that already worked.
  const numericRangeAlts = new Map();
  for (const match of source.matchAll(RANGE_RE)) {
    const [, firstRaw, secondRaw] = match;
    const unit = secondRaw.replace(/^[\d,.\s]+/, '');
    if (!unit) continue;
    const bareNorm = normalizeToken(firstRaw, convention);
    const altNorm = normalizeToken(`${firstRaw} ${unit}`, convention);
    if (!bareNorm || !altNorm || altNorm.replace(/\D/g, '').length < 2) continue;
    if (!numericRangeAlts.has(bareNorm)) numericRangeAlts.set(bareNorm, new Set());
    numericRangeAlts.get(bareNorm).add(altNorm);
  }

  const proper = new Set();
  for (const match of source.matchAll(PROPER_RE)) {
    let words = match[0].split(/\s+/);
    // The leading word of a sentence/line-initial run is capitalised purely
    // by position, not because it's a proper noun — drop it and keep judging
    // the rest of the run on its own merits ("When Logan Paul" → "Logan
    // Paul"; a lone "He's" or "Building" drops to nothing and is skipped).
    if (isSentenceInitial(source, match.index)) {
      words = words.slice(1);
    }
    if (words.length === 0) continue;

    const norm = normalizeToken(words.join(''));
    if (!norm || norm.length < 3) continue;
    if (PROPER_STOPWORDS.has(norm)) continue;
    proper.add(norm);
  }

  return { numeric, proper, numericRangeAlts };
}

/**
 * Compare a digest against the transcript it came from.
 *
 * `retained` answers "did the specifics survive?" and `unsupported` answers
 * "did it invent any?" — the second is the one that matters most, since a
 * confidently invented specific is the failure mode that makes a summary worse
 * than useless.
 *
 * @param {string} transcript
 * @param {string} digest
 * @returns {object} metrics
 */
export function compareFidelity(transcript, digest) {
  const src = extractSpecifics(transcript);
  const out = extractSpecifics(digest);

  // A token counts as supported if it matches directly, OR if it is one of
  // the alternate (bare/suffixed) range readings recorded on EITHER side —
  // covers a digest range whose first number only the transcript states
  // with a unit, and the mirror case where the transcript's own range is
  // the one missing it. Never adds a token to either Set, so it can only
  // turn an existing unsupported token into a supported one.
  const isNumericSupported = (token) => {
    if (src.numeric.has(token)) return true;
    const outAlts = out.numericRangeAlts.get(token);
    if (outAlts) {
      for (const alt of outAlts) if (src.numeric.has(alt)) return true;
    }
    for (const altSet of src.numericRangeAlts.values()) {
      if (altSet.has(token)) return true;
    }
    return false;
  };

  const retainedNumeric = [...out.numeric].filter((t) => isNumericSupported(t));
  const unsupportedNumeric = [...out.numeric].filter((t) => !isNumericSupported(t));

  const caseSignal = hasCaseSignal(transcript);
  const retainedProper = [...out.proper].filter((t) => src.proper.has(t));
  const unsupportedProper = [...out.proper].filter((t) => !src.proper.has(t));

  const transcriptChars = String(transcript || '').length;
  const digestChars = String(digest || '').length;

  return {
    transcriptChars,
    digestChars,
    compression: transcriptChars > 0 ? digestChars / transcriptChars : 0,

    numeric: {
      inTranscript: src.numeric.size,
      inDigest: out.numeric.size,
      retained: retainedNumeric.length,
      // Of the specifics the digest states, how many are backed by the source.
      supportedRate: out.numeric.size > 0 ? retainedNumeric.length / out.numeric.size : 1,
      // Of the source's specifics, how many made it through.
      coverage: src.numeric.size > 0 ? retainedNumeric.length / src.numeric.size : 1,
      unsupported: unsupportedNumeric,
    },

    proper: {
      // Only meaningful when the transcript carries case at all.
      meaningful: caseSignal,
      inTranscript: src.proper.size,
      inDigest: out.proper.size,
      retained: retainedProper.length,
      supportedRate: out.proper.size > 0 ? retainedProper.length / out.proper.size : 1,
      coverage: src.proper.size > 0 ? retainedProper.length / src.proper.size : 1,
      unsupported: unsupportedProper,
    },
  };
}
