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

/** Open Echo for a video id, or Echo's home page when there is no video. */
async function openEcho(videoId) {
  const server = await echoGetServer();
  await openTab(videoId ? echoReadUrl(server, videoId) : `${server}/`);
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
// shape cannot express a scheme at all.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'echo:open') return;
  if (typeof message.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId)) return;
  openEcho(message.videoId);
});
