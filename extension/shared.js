// Shared helpers, loaded into both the content script and the service worker.
// Plain globals rather than an ES module: MV3 content scripts are not modules,
// and this file has to be usable from importScripts() in the worker too.

// Default Echo server. Local mode is the common case — `npm start` binds
// 127.0.0.1:8000 — and anyone running the hosted app points this at their own
// deployment from the options page.
const ECHO_DEFAULT_SERVER = 'http://localhost:8000';

/**
 * Extract an 11-character YouTube video ID from any of the URL forms YouTube
 * uses, or return null.
 *
 * Kept deliberately in step with extractVideoId() in transcript.js — same
 * patterns, same character class. The extension cannot import server code, so
 * if one side gains a URL form the other needs it too.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
function echoExtractVideoId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();

  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})(?:[&\s]|$)/,
    /youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})(?:[?&\s/]|$)/,
  ];

  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }

  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  return null;
}

/**
 * Decode the HTML entities YouTube's json3 caption payloads carry in their
 * text (`&#39;`, `&amp;`, `&quot;`, `&lt;`, `&gt;`, plus the double-encoded
 * forms YouTube sometimes emits).
 *
 * Kept deliberately in step with decodeEntities() in transcript.js — same
 * replacements, same order. The extension cannot import server code, so if
 * one side gains a case the other needs it too; tests/extension-entities-
 * parity.test.js guards the two against drift.
 *
 * @param {string} str
 * @returns {string}
 */
function echoDecodeEntities(str) {
  return str
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Parse a YouTube transcript panel timestamp ('0:15', '1:02', '1:02:33')
 * into seconds. Used by the DOM fallback in content.js — the transcript
 * panel only ever gives us these formatted strings, never raw offsets, so
 * this is the DOM path's equivalent of the API path's `tStartMs`.
 *
 * Never throws: a single bad/unexpected timestamp string must not poison an
 * otherwise-good scrape, so anything unparseable reads as 0 rather than
 * failing the whole segment.
 *
 * @param {string} str - e.g. '0:15', '1:02', '1:02:33'
 * @returns {number} seconds, or 0 if unparseable
 */
function echoParseTimestamp(str) {
  if (typeof str !== 'string') return 0;
  const trimmed = str.trim();
  if (!/^\d+(:\d+){1,2}$/.test(trimmed)) return 0;

  const parts = trimmed.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;

  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

/**
 * Normalise a user-entered server address into an origin with no trailing
 * slash. Refuses anything that isn't http(s) — the value is used to build a
 * URL we then navigate to, and a `javascript:` or `data:` value there would be
 * a self-inflicted injection (see the URL-scheme gotcha in CLAUDE.md: host
 * checks alone do NOT catch this, because `new URL('javascript:x').host` is '').
 *
 * @param {string} raw
 * @returns {string|null} normalised origin+path, or null if not usable
 */
function echoNormalizeServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/**
 * Build the Echo URL that opens a given video. Echo's frontend reads ?v= on
 * load and kicks off the transcript fetch itself (autoLoadFromQuery()).
 *
 * @param {string} server - already normalised
 * @param {string} videoId
 * @returns {string}
 */
function echoReadUrl(server, videoId) {
  return `${server}/?v=${encodeURIComponent(videoId)}`;
}

/** Read the configured server, falling back to the default. */
async function echoGetServer() {
  try {
    const stored = await chrome.storage.sync.get({ server: ECHO_DEFAULT_SERVER });
    return echoNormalizeServer(stored.server) || ECHO_DEFAULT_SERVER;
  } catch {
    return ECHO_DEFAULT_SERVER;
  }
}

// --- Extension-scraped transcript handoff -----------------------------------
// The server can't fetch transcripts from a datacenter VPS — YouTube
// bot-blocks the IP. So instead of a new server route, the transcript rides
// in the URL FRAGMENT of the tab we open: fragments are never sent to the
// server (they don't even leave the browser on navigation), so this needs no
// new host permission and no server change at all. public/app.js reads the
// fragment on load in place of its own fetch. See CLAUDE.md's streaming/CSP
// gotchas for the general shape of "the server already does X, don't build a
// second X".

/** The URL fragment key the transcript payload is packed under. */
const ECHO_TX_HASH_KEY = 'echo-tx';

/**
 * Cap on the *encoded* (base64url, post-gzip) length. This bounds the size of
 * the URL Echo is asked to open — an hour-long transcript compresses well,
 * but there is no reason to let one grow the address bar without limit, and
 * some platforms have their own URL length ceilings (see the obsidian://new
 * gotcha in CLAUDE.md for a concrete case of that).
 */
const ECHO_TX_MAX_ENCODED = 1_500_000;

/**
 * gzip + base64url encode a transcript payload for the URL fragment.
 * base64url swaps the two characters that aren't URL-safe ('+' -> '-',
 * '/' -> '_') and drops the '=' padding, which a fragment doesn't need.
 *
 * Returns null on ANY failure — including "the result is too big" — so the
 * caller's only decision is "did I get a string back", and every failure
 * mode (no CompressionStream, huge payload, serialization error) falls back
 * to opening the plain ?v= URL exactly as before this feature existed.
 *
 * @param {object} payload
 * @returns {Promise<string|null>}
 */
async function echoEncodeTranscript(payload) {
  try {
    if (typeof CompressionStream === 'undefined') return null;
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const gzipped = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(gzipped).arrayBuffer());

    let binary = '';
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    const encoded = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    if (encoded.length > ECHO_TX_MAX_ENCODED) return null;
    return encoded;
  } catch {
    return null;
  }
}

/**
 * Build the Echo URL that opens a given video AND hands it an already-scraped
 * transcript, so the page skips its own server fetch. Same read semantics as
 * echoReadUrl() — app.js still needs ?v= to know which video this is — plus
 * the fragment carrying the payload.
 *
 * @param {string} server - already normalised
 * @param {string} videoId
 * @param {string} encoded - output of echoEncodeTranscript()
 * @returns {string}
 */
function echoReadUrlWithTranscript(server, videoId, encoded) {
  return `${echoReadUrl(server, videoId)}#${ECHO_TX_HASH_KEY}=${encoded}`;
}

// Exported for the test harness; harmless in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    echoExtractVideoId,
    echoDecodeEntities,
    echoParseTimestamp,
    echoNormalizeServer,
    echoReadUrl,
    echoReadUrlWithTranscript,
    echoEncodeTranscript,
    ECHO_DEFAULT_SERVER,
    ECHO_TX_HASH_KEY,
    ECHO_TX_MAX_ENCODED,
  };
}
