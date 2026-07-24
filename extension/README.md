# Echo browser extension

Adds a **Read in Echo** button to YouTube watch pages, plus a toolbar button and
a right-click item for YouTube links. Clicking any of them opens Echo with that
video's transcript already loading.

It is deliberately tiny. It reads no page content, sends nothing anywhere, has no
analytics, and bundles no AI: all it does is turn a YouTube URL into
`<your-echo>/?v=<videoId>` and open it. Echo's frontend takes it from there
(`autoLoadFromQuery()`).

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
| `shared.js` | `echoExtractVideoId` / `echoNormalizeServer` / `echoReadUrl`, loaded by both the content script and the worker |
| `content.js` | injects the button into YouTube's actions row |
| `content.css` | button styling, using YouTube's own `--yt-spec-*` tokens |
| `background.js` | service worker: toolbar click, context menu, tab opening |
| `options.html/js` | the one setting — which Echo to open |
| `test/e2e.mjs` | Playwright end-to-end check (not part of `npm test`) |

## Two things worth knowing before editing

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

⚠️ It must be the **full** Chromium build. Playwright's default headless build is
the headless *shell*, which cannot load extensions at all — and the symptom is
silent: zero service workers, no injected button, no error.

## Publishing

Not published yet. Before submitting to the Chrome Web Store: bump `version` in
`manifest.json`, exclude `test/` from the uploaded zip, and note in the listing
that the extension requires a running Echo (it is a companion, not a standalone
tool).
