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

function openInEcho(videoId) {
  // Send the id, not a built URL: the worker owns the server setting and
  // assembles the URL itself, so nothing from this page's world reaches
  // tabs.create(). Going through the worker also sidesteps the page's popup
  // blocking, which window.open() from a content script is subject to.
  chrome.runtime.sendMessage({ type: 'echo:open', videoId });
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
    openInEcho(videoId);
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
