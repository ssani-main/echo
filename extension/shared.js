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

// Exported for the test harness; harmless in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { echoExtractVideoId, echoNormalizeServer, echoReadUrl, ECHO_DEFAULT_SERVER };
}
