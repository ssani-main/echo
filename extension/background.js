// MV3 service worker: toolbar click, right-click menu, and tab opening on
// behalf of the content script.
//
// Note the worker is not persistent — it is torn down when idle and restarted
// on the next event, so everything here is stateless and all listeners are
// registered at top level (a listener added inside an async callback would miss
// events after a restart).

importScripts('shared.js');

const CONTEXT_MENU_ID = 'echo-read-link';

/** Open a URL in a new tab next to the current one. */
async function openTab(url) {
  await chrome.tabs.create({ url });
}

/**
 * Strictly validate a scraped transcript before it is allowed to shape a URL
 * this worker opens. This is defense in depth, not the real trust boundary —
 * the content script sending this message is Echo's own code. The check that
 * actually matters lives in public/app.js, because a hostile page can hand a
 * visitor `<echo>/?v=…#echo-tx=…` directly with a fabricated payload, and
 * this worker never sees that path at all.
 *
 * @param {*} payload
 * @param {string} videoId - the id this message also carried, independently
 * @returns {boolean}
 */
function isValidTranscriptPayload(payload, videoId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  if (!Array.isArray(payload.segments)) return false;
  if (payload.segments.length < 1 || payload.segments.length > 50000) return false;
  for (const seg of payload.segments) {
    if (!seg || typeof seg !== 'object') return false;
    if (typeof seg.text !== 'string' || seg.text.length > 5000) return false;
    if (typeof seg.offset !== 'number' || !Number.isFinite(seg.offset)) return false;
  }

  if (typeof payload.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(payload.videoId)) return false;
  if (payload.videoId !== videoId) return false;

  for (const key of ['title', 'channel', 'channelUrl', 'langCode']) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > 500) return false;
  }

  return true;
}

/**
 * Open Echo for a video id, or Echo's home page when there is no video.
 *
 * When a validated transcript is available it's folded into the URL
 * fragment (see shared.js echoEncodeTranscript()) so the page skips its own
 * server fetch entirely. Any failure along that path — invalid payload,
 * encode failure, oversized result — falls back to the plain ?v= URL exactly
 * as before this feature existed.
 *
 * @param {string|null} videoId
 * @param {object} [transcript] - optional scraped payload from content.js
 */
async function openEcho(videoId, transcript) {
  const server = await echoGetServer();
  if (!videoId) {
    await openTab(`${server}/`);
    return;
  }
  if (transcript && isValidTranscriptPayload(transcript, videoId)) {
    const encoded = await echoEncodeTranscript(transcript);
    if (encoded) {
      await openTab(echoReadUrlWithTranscript(server, videoId, encoded));
      return;
    }
  }
  await openTab(echoReadUrl(server, videoId));
}

// --- Toolbar button --------------------------------------------------------
// Clicking the icon reads the current tab's URL (activeTab is granted by the
// click itself, so no broad host permission is needed) and opens that video.
// Off a video page it just opens Echo, which is the useful fallback.

chrome.action.onClicked.addListener(async (tab) => {
  await openEcho(echoExtractVideoId(tab && tab.url));
});

// --- Right-click a YouTube link --------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Read in Echo',
    contexts: ['link'],
    targetUrlPatterns: [
      'https://*.youtube.com/watch*',
      'https://*.youtube.com/shorts/*',
      'https://*.youtube.com/live/*',
      'https://youtu.be/*',
    ],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const videoId = echoExtractVideoId(info.linkUrl);
  if (videoId) await openEcho(videoId);
});

// --- Messages from the content script --------------------------------------

// The content script sends a video id, never a URL. The worker builds the URL
// itself from its own stored setting, so nothing a page could influence ever
// reaches chrome.tabs.create — a URL assembled in the content script's world
// would be worth distrusting, and a bare id validated against the YouTube id
// shape cannot express a scheme at all. It may also send a scraped
// transcript payload alongside the id; that's validated separately in
// openEcho() before it's allowed to touch the URL.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'echo:open') return;
  if (typeof message.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId)) return;
  openEcho(message.videoId, message.transcript);
});
