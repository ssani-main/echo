// Injects a "Read in Echo" button into the YouTube watch page.
//
// Two things make this harder than it looks:
//
//   1. YouTube is a single-page app. Navigating from one video to the next
//      never reloads the document, so a one-shot injection at document_idle
//      lands on the first video only. YouTube fires `yt-navigate-finish` on
//      every in-app navigation, which is the documented hook; a MutationObserver
//      backs it up in case that event ever goes away.
//   2. The actions row's markup changes. Rather than depend on one selector,
//      try several and simply do nothing if none match — the toolbar button
//      still works, so a failed injection degrades to "no shortcut" instead of
//      a broken page.

const ECHO_BUTTON_ID = 'echo-read-button';

// Ordered most- to least-specific. First hit wins.
const ACTION_ROW_SELECTORS = [
  'ytd-watch-metadata #top-level-buttons-computed',
  '#actions #top-level-buttons-computed',
  'ytd-menu-renderer #top-level-buttons-computed',
  '#actions-inner #menu',
  '#menu-container #menu',
];

/** The Echo waveform, inline so it needs no web_accessible_resources entry. */
const ECHO_MARK = `
<svg viewBox="0 0 28 28" width="16" height="16" aria-hidden="true" focusable="false">
  <rect x="2"  y="12" width="2.4" height="4"  fill="currentColor"/>
  <rect x="6"  y="9"  width="2.4" height="10" fill="currentColor"/>
  <rect x="10" y="5"  width="2.4" height="18" fill="currentColor"/>
  <rect x="14" y="10" width="2.4" height="8"  fill="currentColor"/>
  <rect x="18" y="7"  width="2.4" height="14" fill="currentColor"/>
  <rect x="22" y="11" width="2.4" height="6"  fill="currentColor"/>
</svg>`;

function findActionRow() {
  for (const selector of ACTION_ROW_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Walk source from the first '{' after `key =` to its balanced closing '}',
 * respecting string literals (so a brace inside a quoted string doesn't
 * throw off the depth count) and backslash escapes inside them. A regex
 * cannot do this — ytInitialPlayerResponse nests many levels deep and a
 * non-greedy match stops at the first unrelated '}' it finds, which is
 * usually only a few keys in.
 *
 * @param {string} source
 * @param {string} key
 * @returns {string|null} the matched '{...}' substring, or null
 */
function extractBalancedObjectAfterKey(source, key) {
  const keyIdx = source.indexOf(key);
  if (keyIdx === -1) return null;
  const eqIdx = source.indexOf('=', keyIdx + key.length);
  if (eqIdx === -1) return null;
  const start = source.indexOf('{', eqIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null; // unbalanced — malformed/truncated response, give up
}

/**
 * The API path: pick a caption track off ytInitialPlayerResponse and fetch
 * its baseUrl as json3. This used to be the whole scraper. Probing it
 * against live YouTube (2026-07-26, real Chrome over CDP) found it now
 * often fails silently: the baseUrl carries no `pot=` proof-of-origin token,
 * so the fetch comes back **HTTP 200 with a zero-byte body** — a success
 * status hiding a total failure. That is why this function insists on a
 * non-empty segments array rather than just "the fetch didn't throw": a
 * 200-with-nothing has to read as null, or echoScrapeTranscript() never
 * reaches the DOM fallback below.
 *
 * @param {object} playerResponse - parsed ytInitialPlayerResponse
 * @returns {Promise<Array<{text: string, offset: number}>|null>}
 */
async function echoFetchCaptionSegments(playerResponse) {
  try {
    const tracks = playerResponse
      && playerResponse.captions
      && playerResponse.captions.playerCaptionsTracklistRenderer
      && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    // Prefer a human-authored English track, then any human-authored track,
    // then fall back to auto-generated (ASR) captions, then just take
    // whatever is first.
    const track =
      tracks.find((t) => t.kind !== 'asr' && typeof t.languageCode === 'string' && t.languageCode.startsWith('en')) ||
      tracks.find((t) => t.kind !== 'asr') ||
      tracks.find((t) => t.kind === 'asr') ||
      tracks[0];
    if (!track || !track.baseUrl) return null;

    // Scheme-check before fetching a URL that came out of page JSON. CLAUDE.md
    // documents why a host check is not enough: new URL('javascript:x').host
    // is '' , so host-based filters pass javascript:/data:/file: straight
    // through. fetch() would happily follow a data: URL here.
    if (!/^https:\/\//i.test(track.baseUrl)) return null;

    const capRes = await fetch(track.baseUrl + '&fmt=json3');
    if (!capRes.ok) return null;
    const data = await capRes.json();

    // Mirrors transcript.js's yt-dlp json3 parsing (its lines ~176-192): same
    // event/segs shape, same join-then-clean-whitespace, same HTML-entity
    // decoding (echoDecodeEntities in shared.js mirrors decodeEntities there),
    // and — easy to get backwards — offset is in SECONDS, not milliseconds.
    const segments = [];
    for (const event of (data.events || [])) {
      if (!event.segs) continue;
      const text = event.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();
      if (!text) continue;
      segments.push({ text: echoDecodeEntities(text), offset: (event.tStartMs || 0) / 1000 });
    }
    if (segments.length === 0) return null; // 200-with-empty-body reads as failure

    segments._track = track; // stash so the caller can read langCode; stripped before use
    return segments;
  } catch {
    return null;
  }
}

/**
 * The DOM fallback: read the transcript out of the panel YouTube itself
 * renders, instead of hitting an API. Added alongside
 * echoFetchCaptionSegments() because the API path can now silently return
 * nothing (see that function's comment) — this path works exactly when
 * YouTube's own "Show transcript" button works, needs no proof-of-origin
 * token, no protobuf, and no API call at all.
 *
 * Never throws — mirrors echoScrapeTranscript()'s contract, since this is
 * one of its two segment sources.
 *
 * @returns {Promise<Array<{text: string, offset: number}>|null>}
 */
async function echoScrapeTranscriptPanel() {
  let toggle = null;
  let openedByUs = false;
  try {
    // The transcript toggle lives inside the (often collapsed) description;
    // expand it first or the toggle isn't in the DOM to find.
    const expandButton = document.querySelector('tp-yt-paper-button#expand, #expand');
    if (expandButton) expandButton.click();

    // The row's markup isn't a stable single selector, so — same philosophy
    // as ACTION_ROW_SELECTORS above — scan candidates and match on content
    // rather than depend on one exact selector.
    const candidates = document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape button');
    for (const el of candidates) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (label.includes('transcript')) { toggle = el; break; }
    }
    if (!toggle) return null;

    // The panel may already be open (a previous manual click, or YouTube
    // itself opening it) — only click to open it if it isn't, and only
    // then are we responsible for closing it again afterwards.
    const alreadyPresent = document.querySelectorAll('ytd-transcript-segment-renderer').length > 0;
    if (!alreadyPresent) {
      openedByUs = true;
      toggle.click();
    }

    // Poll rather than await one fixed delay: the panel's render time varies
    // with video length and page load, and this loop simply returns as soon
    // as it can rather than always paying the worst case.
    const POLL_INTERVAL_MS = 250;
    const POLL_TIMEOUT_MS = 10000;
    let nodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    let waited = 0;
    while (nodes.length === 0 && waited < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      waited += POLL_INTERVAL_MS;
      nodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    }
    if (nodes.length === 0) return null;

    const segments = [];
    for (const node of nodes) {
      const textEl = node.querySelector('.segment-text, yt-formatted-string.segment-text');
      const text = textEl ? textEl.textContent.trim() : '';
      if (!text) continue;
      const timeEl = node.querySelector('.segment-timestamp');
      const offset = echoParseTimestamp(timeEl ? timeEl.textContent : '');
      segments.push({ text: echoDecodeEntities(text), offset });
    }
    if (segments.length === 0) return null;
    return segments;
  } catch {
    return null;
  } finally {
    // Politeness: the user asked to read a transcript, not to have their
    // page rearranged. Close the panel again if — and only if — we're the
    // one who opened it. Runs in `finally` so a parsing error above still
    // leaves the page as it was found.
    if (openedByUs && toggle) {
      try { toggle.click(); } catch { /* best effort */ }
    }
  }
}

/**
 * Scrape the current video's transcript directly from this tab: the
 * visitor's own IP, the visitor's own session. This is the whole point —
 * Echo's server fetch gets bot-blocked on a datacenter VPS, but a real
 * browser tab never does. See CLAUDE.md for the full architecture.
 *
 * Segments come from one of two sources, tried in order:
 *   1. echoFetchCaptionSegments() — the API path, fast when it works.
 *   2. echoScrapeTranscriptPanel() — the DOM path, used when the API path
 *      comes back empty (see that function's comment for why that now
 *      happens routinely rather than rarely).
 *
 * Returns a transcript payload for the background worker to fold into the
 * URL it opens, or null on ANY failure. Must never throw: it runs from a
 * click handler, and a failed scrape isn't an error — it just means Echo
 * falls back to fetching the transcript itself, exactly as it always has.
 *
 * @returns {Promise<object|null>}
 */
async function echoScrapeTranscript() {
  try {
    // The caption baseUrl below only resolves from www.youtube.com — from
    // m.youtube.com the fetch would be cross-origin (different host) and
    // CORS-blocked.
    if (location.hostname !== 'www.youtube.com') return null;

    const videoId = echoExtractVideoId(location.href);
    if (!videoId) return null;

    // Fetch the page fresh rather than reading a <script> tag already in the
    // DOM: YouTube is an SPA, so after an in-app navigation (no document
    // reload) the original ytInitialPlayerResponse script tag is stale and
    // still describes whichever video was loaded first.
    let playerResponse = null;
    try {
      const pageRes = await fetch(location.href, { credentials: 'include' });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const json = extractBalancedObjectAfterKey(html, 'ytInitialPlayerResponse');
        if (json) playerResponse = JSON.parse(json);
      }
    } catch {
      playerResponse = null;
    }

    // Metadata extraction failing is no longer fatal to the whole scrape —
    // only the API segment path actually needs playerResponse. Fall back to
    // reading title/channel straight off the rendered page so the DOM
    // fallback still has something to attach them to.
    const details = (playerResponse && playerResponse.videoDetails) || {};
    let title = typeof details.title === 'string' ? details.title : null;
    let channel = typeof details.author === 'string' ? details.author : null;
    let channelUrl = typeof details.channelId === 'string'
      ? 'https://www.youtube.com/channel/' + details.channelId
      : null;
    if (title === null) {
      const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title, #title h1');
      title = titleEl ? titleEl.textContent.trim() || null : null;
    }
    if (channel === null) {
      const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');
      channel = channelEl ? channelEl.textContent.trim() || null : null;
      if (channelEl && channelEl.href) channelUrl = channelEl.href;
    }

    let langCode = null;
    let segments = playerResponse ? await echoFetchCaptionSegments(playerResponse) : null;
    if (segments && segments._track) {
      langCode = typeof segments._track.languageCode === 'string' ? segments._track.languageCode : null;
    }
    if (!segments || segments.length === 0) {
      segments = await echoScrapeTranscriptPanel();
      langCode = null; // the panel doesn't reliably expose a language code
    }
    if (!segments || segments.length === 0) return null;

    return {
      videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId,
      title,
      channel,
      channelUrl,
      langCode,
      transcriptSource: 'captions',
      segments: segments.map(({ text, offset }) => ({ text, offset })), // strip the stashed _track
    };
  } catch {
    return null; // never let a scrape failure reach the click handler
  }
}

async function openInEcho(videoId) {
  // Send the id, not a built URL: the worker owns the server setting and
  // assembles the URL itself, so nothing from this page's world reaches
  // tabs.create(). Going through the worker also sidesteps the page's popup
  // blocking, which window.open() from a content script is subject to.
  //
  // The transcript travels the same way, when we manage to get one: scraped
  // here (this page's own fetch, this visitor's own IP/session), handed to
  // the worker as plain data, and it's the worker — not this page — that
  // decides whether/how to fold it into the opened URL. `transcript` is null
  // on any scrape failure, which is not an error case for the worker: it
  // just opens the plain ?v= URL as it always has.
  const transcript = await echoScrapeTranscript();
  chrome.runtime.sendMessage({ type: 'echo:open', videoId, transcript });
}

function buildButton(videoId) {
  const button = document.createElement('button');
  button.id = ECHO_BUTTON_ID;
  button.className = 'echo-read-button';
  button.type = 'button';
  button.title = 'Read this video in Echo';
  button.innerHTML = `${ECHO_MARK}<span>Read in Echo</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // The scrape can be several network round trips, and — when it falls
    // back to the DOM transcript panel — up to ~10s of polling on top of
    // that, so give the click somewhere to land instead of looking dead
    // until the new tab appears.
    const label = button.querySelector('span');
    const originalLabel = label ? label.textContent : '';
    button.disabled = true;
    button.classList.add('echo-read-button-busy');
    if (label) label.textContent = 'Reading…';
    openInEcho(videoId).finally(() => {
      button.disabled = false;
      button.classList.remove('echo-read-button-busy');
      if (label) label.textContent = originalLabel;
    });
  });
  return button;
}

function injectButton() {
  const videoId = echoExtractVideoId(location.href);
  const existing = document.getElementById(ECHO_BUTTON_ID);

  // Not on a video any more (search results, channel page): clean up.
  if (!videoId) {
    if (existing) existing.remove();
    return false;
  }

  // Already injected for this video — the SPA re-renders the row constantly,
  // so re-adding on every mutation would thrash.
  if (existing && existing.dataset.videoId === videoId && existing.isConnected) return true;
  if (existing) existing.remove();

  const row = findActionRow();
  if (!row) return false;

  const button = buildButton(videoId);
  button.dataset.videoId = videoId;
  row.prepend(button);
  return true;
}

// --- Wiring ----------------------------------------------------------------

let scheduled = false;
function scheduleInject() {
  if (scheduled) return;
  scheduled = true;
  // Coalesce the burst of mutations YouTube emits while a page settles.
  setTimeout(() => {
    scheduled = false;
    injectButton();
  }, 150);
}

document.addEventListener('yt-navigate-finish', scheduleInject);

// Backstop: the actions row is often rendered after yt-navigate-finish fires,
// and this also covers the very first load.
const observer = new MutationObserver(scheduleInject);
observer.observe(document.documentElement, { childList: true, subtree: true });

scheduleInject();
