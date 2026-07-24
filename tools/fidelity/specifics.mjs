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
const NUMERIC_RE = /(?:[$€£¥]\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent|dollars?|euros?|pounds?|million|billion|trillion|thousand|k\b|bn\b)|\b\d{4}s?\b|\b\d+(?:[.,]\d+)?\b)/gi;

// Capitalised multi-word or standalone proper nouns. Weaker signal: only
// meaningful when the source is punctuated and cased (Whisper output is;
// YouTube auto-captions frequently are not — see readCaseSignal()).
const PROPER_RE = /\b[A-Z][a-zA-Z0-9'’.-]*(?:\s+[A-Z][a-zA-Z0-9'’.-]*)*\b/g;

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

/** Normalise a token for comparison: casefold, strip separators and trailing punctuation. */
export function normalizeToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,;:!?]+$/, '')
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
  for (const match of source.match(PROPER_RE) || []) {
    const norm = normalizeToken(match);
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
