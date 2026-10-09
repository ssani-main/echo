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

// Both generations of YouTube's transcript panel markup. Measured 2026-10-09
// in real Chrome: the same day served the old element on some videos and the
// new one on others.
const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer, transcript-segment-view-model';

/**
 * Read the transcript out of the panel YouTube itself renders. This is the
 * only route that works: fetching a caption track's baseUrl returns HTTP 200
 * with a zero-byte body (it carries no `pot=` proof-of-origin token), measured
 * on every video tried, 2026-10-09. The panel works exactly when YouTube's
 * own "Show transcript" button works and needs no token and no API call.
 *
 * Never throws — mirrors echoScrapeTranscript()'s contract.
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

    // By structure first: the label is localised ("Transkript anzeigen" on a
    // German YouTube), so matching the English word alone finds nothing
    // there. The description expands asynchronously, hence the short poll.
    for (let waited = 0; !toggle && waited < 3000; waited += 250) {
      toggle = document.querySelector('ytd-video-description-transcript-section-renderer button');
      if (!toggle) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!toggle) {
      const candidates = document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape button');
      for (const el of candidates) {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
        if (label.includes('transcript')) { toggle = el; break; }
      }
    }
    if (!toggle) return null;

    // The panel may already be open (a previous manual click, or YouTube
    // itself opening it) — only click to open it if it isn't, and only
    // then are we responsible for closing it again afterwards.
    const alreadyPresent = document.querySelectorAll(SEGMENT_SELECTOR).length > 0;
    if (!alreadyPresent) {
      openedByUs = true;
      toggle.click();
    }

    // Poll rather than await one fixed delay: the panel's render time varies
    // with video length and page load, and this loop simply returns as soon
    // as it can rather than always paying the worst case.
    const POLL_INTERVAL_MS = 250;
    const POLL_TIMEOUT_MS = 10000;
    let nodes = document.querySelectorAll(SEGMENT_SELECTOR);
    let waited = 0;
    while (nodes.length === 0 && waited < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      waited += POLL_INTERVAL_MS;
      nodes = document.querySelectorAll(SEGMENT_SELECTOR);
    }
    if (nodes.length === 0) return null;

    // Wait for the count to stop growing, so a list that renders in chunks
    // is not read half-built.
    for (let previous = -1; nodes.length !== previous && waited < POLL_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
      previous = nodes.length;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      nodes = document.querySelectorAll(SEGMENT_SELECTOR);
    }

    const segments = [];
    for (const node of nodes) {
      const textEl = node.querySelector('.segment-text, [role="text"]');
      const text = textEl ? textEl.textContent.trim() : '';
      if (!text) continue;
      const timeEl = node.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp');
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
    // leaves the page as it was found. The panel's own close button, because
    // clicking "Show transcript" a second time does not close it (measured
    // 2026-10-09, both markups).
    if (openedByUs) {
      try {
        const segment = document.querySelector(SEGMENT_SELECTOR);
        const panel = (segment && segment.closest('ytd-engagement-panel-section-list-renderer'))
          || document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
        const close = panel && panel.querySelector('#visibility-button button');
        if (close) close.click();
      } catch { /* best effort */ }
    }
  }
}

/**
 * Scrape the current video's transcript directly from this tab: the
 * visitor's own IP, the visitor's own session. This is the whole point —
 * Echo's server fetch gets bot-blocked on a datacenter VPS, but a real
 * browser tab never does. See CLAUDE.md for the full architecture.
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
    // m.youtube.com has no transcript panel in this markup.
    if (location.hostname !== 'www.youtube.com') return null;

    const videoId = echoExtractVideoId(location.href);
    if (!videoId) return null;

    const segments = await echoScrapeTranscriptPanel();
    if (!segments) return null;

    // Read off the rendered page: YouTube is an SPA, so these elements — unlike
    // the ytInitialPlayerResponse script tag — describe the current video.
    const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title, #title h1');
    const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');

    return {
      videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId,
      title: (titleEl && titleEl.textContent.trim()) || null,
      channel: (channelEl && channelEl.textContent.trim()) || null,
      channelUrl: (channelEl && channelEl.href) || null,
      langCode: null, // the panel doesn't expose a language code
      transcriptSource: 'captions',
      segments,
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
    // The scrape polls the transcript panel for up to ~13s, so give the click
    // somewhere to land instead of looking dead until the new tab appears.
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

// The toolbar button has no page access of its own, so the worker asks here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'echo:scrape') return;
  echoScrapeTranscript().then(sendResponse);
  return true; // keep the channel open for the async response
});

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
