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
const MAGNITUDE_WORD = '(?:%|percent|dollars?|euros?|pounds?|million|billion|trillion|thousand|k\\b|bn\\b)';
const NUMERIC_RE = new RegExp(
  `(?:[$€£¥]\\s*\\d[\\d,.]*(?:\\s*${MAGNITUDE_WORD})?|\\d[\\d,.]*\\s*${MAGNITUDE_WORD}|\\b\\d{4}s?\\b|\\b\\d+(?:[.,]\\d+)?\\b)`,
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
 * Normalise a token for comparison: casefold, strip separators, trailing
 * punctuation, and currency symbols.
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
 */
export function normalizeToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,;:!?]+$/, '')
    .replace(/[$€£¥]/g, '')
    .replace(/[\s,]/g, '')
    .trim();
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
 * @param {string} text
 * @returns {{ numeric: Set<string>, proper: Set<string> }}
 */
export function extractSpecifics(text) {
  const source = String(text || '');

  const numeric = new Set();
  for (const match of source.match(NUMERIC_RE) || []) {
    const norm = normalizeToken(match);
    // Bare single digits are noise ("one of 3 things"); they carry no identity.
    if (!norm || norm.replace(/\D/g, '').length < 2) continue;
    numeric.add(norm);
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

  return { numeric, proper };
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

  const retainedNumeric = [...out.numeric].filter((t) => src.numeric.has(t));
  const unsupportedNumeric = [...out.numeric].filter((t) => !src.numeric.has(t));

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
