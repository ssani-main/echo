# Echo browser extension

Adds a **Read in Echo** button to YouTube watch pages, plus a toolbar button and
a right-click item for YouTube links. Clicking any of them opens Echo on that
video.

The button and the toolbar icon also **bring the transcript with them**. A
hosted Echo cannot fetch one itself — YouTube blocks datacenter IPs — so the
extension reads it from the transcript panel on the tab you are already
watching and hands it to Echo in the URL fragment (`#echo-tx=`, never sent to
any server). The right-click item only has a link, not an open video, so it
opens `<your-echo>/?v=<videoId>` and leaves the fetch to Echo.

It is deliberately small: no analytics, no AI, no keys, and the transcript goes
nowhere except the Echo tab it opens.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Right-click the Echo icon → **Options** if your Echo isn't at
   `http://localhost:8000` (hosted, self-hosted, or a different port)

Works in Chrome, Edge, Brave, and any other Chromium browser. Firefox is not
supported yet — MV3 background service workers differ there.

## Layout

| file | role |
|---|---|
| `manifest.json` | MV3 manifest — permissions are `storage`, `contextMenus`, `activeTab` |
| `shared.js` | `echoExtractVideoId` / `echoNormalizeServer` / `echoReadUrl` / `echoEncodeTranscript`, loaded by both the content script and the worker |
| `content.js` | injects the button into YouTube's actions row; reads the transcript out of YouTube's own transcript panel |
| `content.css` | button styling, using YouTube's own `--yt-spec-*` tokens |
| `background.js` | service worker: toolbar click, context menu, tab opening |
| `options.html/js` | the one setting — which Echo to open |
| `test/e2e.mjs` | Playwright end-to-end check against a stand-in page (not part of `npm test`) |
| `test/live.mjs` | the same flow against real YouTube, transcript included (not part of `npm test`) |

## Three things worth knowing before editing

**YouTube is a single-page app.** Navigating between videos never reloads the
document, so a one-shot injection only ever decorates the first video you land
on. `content.js` listens for `yt-navigate-finish` and keeps a MutationObserver as
a backstop. Any change here needs the E2E check below, because a unit test cannot
see it.

**The content script never builds the URL.** It sends a bare video id to the
service worker, which assembles the URL from its own stored setting. A URL
assembled in the content script's world would be worth distrusting; an id
validated against `^[A-Za-z0-9_-]{11}$` cannot express a scheme at all. The
options page applies the same rule from the other side — `echoNormalizeServer()`
refuses anything that isn't `http(s):`, because a host-based check would not
(`new URL('javascript:alert(1)').host === ''`).

**The transcript comes from the panel, not from an API.** Fetching a caption
track's URL returns HTTP 200 with an empty body (it needs a token only
YouTube's player holds), so `content.js` opens "Show transcript", reads the
segments and closes the panel again. Three details were each measured against
live YouTube on 2026-10-09 and each broke the scrape when wrong: the button is
found by structure, because its label is localised ("Transkript anzeigen");
YouTube serves two different segment markups, sometimes on the same day; and
clicking "Show transcript" twice does not close the panel — its own close
button does.

## Testing

Pure logic (`shared.js`) is covered by the main suite, which stays
dependency-free:

```bash
npm test          # includes tests/extension-shared.test.js
```

The browser behaviour — SPA navigation, injection, the click actually landing on
Echo — needs a real Chromium with the extension loaded:

```bash
npm i --no-save playwright && npx playwright install chromium
node extension/test/e2e.mjs

# or, against a Chromium already on the machine:
ECHO_CHROMIUM=/path/to/chrome node extension/test/e2e.mjs
```

That check uses a stand-in page, so it cannot tell you whether the transcript
scrape still works on today's YouTube. This one can — real Chrome, real
YouTube, no npm dependency, about two minutes:

```bash
ECHO_CHROME=/path/to/chrome node extension/test/live.mjs
```

Run it after touching the scrape, and whenever transcripts stop arriving: it is
the quickest way to learn that YouTube changed the panel.

⚠️ For `e2e.mjs`, it must be the **full** Chromium build. Playwright's default headless build is
the headless *shell*, which cannot load extensions at all — and the symptom is
silent: zero service workers, no injected button, no error.

## Publishing

Not published yet. Before submitting to the Chrome Web Store: bump `version` in
`manifest.json`, exclude `test/` from the uploaded zip, and note in the listing
that the extension requires a running Echo (it is a companion, not a standalone
tool). The default server is still `http://localhost:8000` (`ECHO_DEFAULT_SERVER`
in `shared.js`); point it at the hosted Echo before publishing for other people.
