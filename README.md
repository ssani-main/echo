<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/echo-logo-dark.png">
  <img alt="Echo" src="public/echo-logo-light.png" width="210">
</picture>

### _Paste a YouTube link. Read what was actually said._

Echo pulls the transcript out of any YouTube video, reflows the messy auto-captions into something you'd actually want to read, and — if you like — hands it to AI for a clean digest.

<br>

![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-3c873a?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-16181D?style=flat-square&logo=express&logoColor=white)
![Runs locally](https://img.shields.io/badge/runs-100%25%20local-0B6B4F?style=flat-square)
![No API key](https://img.shields.io/badge/AI%20digest-no%20API%20key%20needed-0B6B4F?style=flat-square)

</div>

---

## ✨ What it does

You've been there: you find a great video, but you'd rather *read* it than sit through 40 minutes. YouTube has the captions — they're just locked behind the player and chopped into unreadable two-second fragments. Echo fixes that.

```
   🔗  paste a link
        │
        ▼
   📥  fetch the caption track          (youtube-transcript → yt-dlp → Whisper)
        │
        ▼
   🧹  reflow into readable paragraphs   (sentence + pause aware)
        │
        ▼
   🤖  optional: AI digest               (via your local Claude Code CLI)
```

## 🌟 Features

| | Feature | Notes |
|---|---|---|
| 📥 | **Transcript fetching** | Works with `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, or a bare video ID; pick your caption language from available tracks |
| 📋 | **Paste-to-fetch** | Paste a YouTube link into the input field and it auto-loads the transcript—no click needed |
| 🧹 | **Readable mode** | Glues captions into proper sentences & paragraphs; find-in-transcript with live match counter and Prev/Next navigation; copy/download as Markdown — all persists across sessions |
| 🎛️ | **Shared reading controls** | Font size (A−/A+) and column width (Narrow/Medium/Wide: ~620 / 760 / 940 px) apply to both Transcript and Digest lenses, share one preference, and scale the reading column responsively. Digest AI output is typeset as a readable article |
| ⏱️ | **Timecoded mode** | Subtitle-editor style with monospace timecode gutter; every timestamp deep-links YouTube (`&t=<sec>s`) |
| 💾 | **Session restore** | Refreshing the page restores the current transcript, digest, view mode, lens, and Library state via sessionStorage—no re-fetch |
| 🤖 | **AI Digest** | Switch to the Digest lens for an AI-generated read: **Digest** (synthesized, reorganized by idea), **Article** (full-fidelity rewrite, nothing dropped), or **Bullets** — plus an output-language picker. **Streams as it is written**, so you start reading in about a second instead of waiting for the whole thing. Very long transcripts fall back to map-reduce automatically |
| 🎙️ | **Whisper transcription** | No captions? Local speech-to-text via whisper.cpp fills the gap (**Fallback**), or transcribes everything for accuracy (**High-accuracy**). Off by default; configured in Settings with a `base`/`small` model picker and on-demand download. Local/desktop only, needs `ffmpeg` on `PATH` |
| 🎧 | **Local audio & video** | Not just YouTube — open a podcast download, a lecture recording or a meeting capture and Echo transcribes it with Whisper, then digests it like anything else. Local/desktop, needs `ffmpeg` |
| 🧩 | **Browser extension** | A **Read in Echo** button on YouTube watch pages, a toolbar button, and a right-click item for links. See [`extension/`](extension/) |
| 🪨 | **Obsidian plugin** | Paste a link inside Obsidian and get a note — transcript, digest, frontmatter — filed in your vault. See [`obsidian-plugin/`](obsidian-plugin/) |
| 📑 | **Reader & Library** | Transcript and Digest are lens tabs—two views of the current video. Saved videos open from a **Library** button in the header (with count) |
| 🟢 | **Live status indicator** | Fixed pill shows "AI is digesting…" → "Digest ready ✓" as it processes; click to jump to the Digest pane |
| 💾 | **Library & tagging** | Save videos; search by keyword (SQLite FTS5), sort (Recently saved / Title A–Z), tag with auto-suggestions; export whole library as ZIP of Markdown files or JSON backup; sync to Obsidian vault |
| 🔐 | **Accounts & sync** _(hosted, optional)_ | Sign in with Google so your library follows you between devices. Off unless the operator configures it — and it never changes where your API key lives: keys stay in your browser either way |
| ⌨️ | **Keyboard shortcuts** | Press `?` for the overlay; `/` focus find, `1`/`2` switch Transcript & Digest lenses, `3` open Library, `t` toggle dark mode, `Esc` close — all paused while typing |
| 🎨 | **Light & dark themes** | The "Plaintext" theme: one system monospace family, no webfonts, no accent hue, hierarchy carried by weight rather than size. Loading skeletons respect reduced-motion |
| 🛟 | **Automatic fallback** | If the transcript library hiccups, `yt-dlp` steps in |
| 🏠 | **Fully local** | Your own machine, your own browser — nothing leaves the room |

## 🤖 About the AI Digest

The AI digest **doesn't need an Anthropic API key or any billing setup** when running locally. Echo shells out to your locally-installed [**Claude Code**](https://claude.com/claude-code) CLI in headless mode, reusing your existing login and subscription quota.

Switch to the **Digest** lens and Echo generates it directly. Three formats:

- **Digest** _(default)_ — the video's real substance, synthesized and reorganized by idea rather than in the order it was said. Not a summary of what the video "covers"; the point itself.
- **Article** — a full-fidelity rewrite you read *instead of* watching. Nothing substantive is dropped, only the noise of speech.
- **Bullets** — a short TL;DR plus the key takeaways.

Pick your output language too (default English). Transcripts past ~120k tokens are chunked, summarized in parallel, and synthesized in a final pass automatically — while that is happening the pane reports which part it is reading, since no digest text exists yet.

The digest **streams**: text appears as the model writes it rather than after the whole call returns. If streaming is unavailable for any reason, Echo silently falls back to the single-response request it used before, so the worst case is the wait you already had.

The prompts live in [`digest.js`](./digest.js) — tweak them if you'd rather have a different model, tone, or analysis approach.

## 🚀 Getting started

### Prerequisites

- **[Node.js](https://nodejs.org/) ≥ 22.5**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** _(optional)_ — the reliability fallback. `winget install yt-dlp` or `pip install yt-dlp`, and make sure it's on your `PATH`.
- **[Claude Code](https://claude.com/claude-code)** _(optional)_ — only needed for the **AI features** (the digest and Explain/Background lookups). Desktop mode can use BYOK (Bring Your Own Key) from Anthropic as a fallback.
- **[ffmpeg](https://ffmpeg.org/)** _(optional)_ — only needed for **Whisper transcription**, to extract audio. The `whisper-cli` binary itself ships with Echo on Linux x64 and Windows x64; macOS has no prebuilt binary, so Whisper stays off there.

### Install & run

```bash
git clone https://github.com/ssani-main/echo.git
cd echo
npm install
npm start
```

Then open **http://localhost:8000** 🎉

> 💡 On Windows PowerShell, if `npm start` trips the execution policy, run `npm.cmd start` or launch it from `cmd`.

## 🚀 Running Echo — Deployment modes

Echo is one codebase that runs three ways—same core, different shells.

### Local (default)

```bash
npm start
```

Opens **http://localhost:8000**. The AI features shell out to your locally-installed [Claude Code CLI](https://claude.com/claude-code) — no API key or subscription setup needed, reuses your existing quota. **This is the standard way to run Echo and requires no environment configuration.**

### Public tunnel (Holesail + Janus)

Hosting Echo on a VPS doesn't work: transcript fetches happen server-side, and
YouTube bot-blocks datacenter IP ranges outright. A machine on a residential
connection doesn't have that problem, and it can run the local Claude CLI too
— so instead of deploying, run Echo where you already are and tunnel it out.
This approach has been verified end to end: a video that failed on the VPS
with bot-blocking returned 1077 caption segments through the tunnel.

```bash
npm run serve:public
```

One command starts Echo and opens a [Holesail](https://holesail.io) tunnel
through [Janus](https://janus.ssani.dev), then prints a public
`https://0000<key>.janus.ssani.dev/` URL. The URL is **stable across
restarts** — the underlying key is derived from a seed persisted at
`.holesail-seed` in the repo root (generated on first run, gitignored, mode
`0600`). That file **is a secret**: it's the serving capability for the
tunnel, not a cosmetic id — don't share it, don't commit it. Pass `--attach`
(or set `ECHO_HOLESAIL_ATTACH=1`) to tunnel an Echo you've already started
instead of spawning a new one. **Note:** the tunnel requires a running Janus
gateway (a separate project). See `npm run serve:public -- --help` for all
available flags.

⚠️ **This makes Echo reachable by anyone with the link.** In `local` mode
(the default) that means anyone with the URL can spend your Claude CLI quota
and read/write your whole library — there's no BYOK gate and no auth. Either
set a per-key password on the tunnel in the Janus admin dashboard, or run
with `ECHO_MODE=web` first (visitors bring their own Anthropic key, and the
server-side library routes are disabled).

### Hosted web (BYOK — Bring Your Own Key)

```bash
ECHO_MODE=web PORT=8080 node server.js
```

Public web mode with no authentication. Each visitor:
- **Provides their own Anthropic API key** in Settings (gear icon)
- **First-run onboarding**: new users see a card explaining that they need to add their own API key to use the AI features
- Key validated on save via `POST /api/validate-key` — invalid keys are rejected immediately
- Key stored in browser's **localStorage**, sent per-request as `X-Echo-Api-Key` header — **never stored on server**
- Library stored in browser's **IndexedDB** — each visitor's library is isolated, no user accounts

**Optional: accounts + library sync.** Set `ECHO_GOOGLE_CLIENT_ID`,
`ECHO_GOOGLE_CLIENT_SECRET` and `ECHO_SESSION_SECRET` and Echo offers **Sign in
with Google**, so a library follows a visitor between devices. What the server
then stores is two tables — one row per account (Google's `sub` → an id) and one
row per saved video. No passwords (Google is the only way in), no sessions table
(sessions are signed cookies), and **no API keys**: signing in does not change
where an Anthropic key lives. Leave the three unset and none of it exists — no
sign-in UI, no database, no volume. See [`DEPLOY.md`](DEPLOY.md).

**Web-mode limits:**
- Server-side library API disabled (HTTP 503): `/api/saved*`, `/api/search`, `/api/vault/sync` — library in IndexedDB only
- Whisper transcription disabled (`/api/whisper/*`); captions only
- Per-IP rate limiting: 20 requests / 60s on AI and transcript routes
- Transcript and AI payload size caps
- Nothing is persisted server-side — no volume or database to provision

### Desktop app (Tauri v2)

A native window wrapper running the same Node backend as a sidecar. Build prerequisites (Rust, VS C++ Build Tools 2022, WebView2) and commands (`npm run tauri:dev`, `npm run tauri:build`) are documented in `DESKTOP.md` — refer to that file.

### Deploy with Docker

A production-ready container image runs Echo in web mode with yt-dlp pre-installed.

```bash
# Copy the example env file and add your settings (if any)
cp .env.example .env

# Build the image
docker build -t echo .

# Run the container
docker run -p 8080:8080 echo
```

Then open **http://localhost:8080**. The container:
- Runs in `ECHO_MODE=web` (BYOK — visitors bring their own Anthropic API key)
- Listens on `0.0.0.0:8080` for use behind a reverse proxy
- Includes a `HEALTHCHECK` that pings `/api/health` every 30s for orchestration tools (Kubernetes, Docker Compose, etc.)
- Uses `node:22-bookworm-slim` with yt-dlp for transcript fallback

To customize, edit `.env` before building, or pass environment variables at runtime:
```bash
docker run -e PORT=3000 -e ECHO_MODE=web -p 3000:3000 echo
```

---

## 🧩 Companions

Both talk to a running Echo over HTTP. Neither holds an API key or does any AI
of its own — that all stays in Echo, so there is one implementation of the part
that matters.

### Browser extension (Chrome, Edge, Brave)

Adds **Read in Echo** to YouTube watch pages, plus a toolbar button and a
right-click item for any YouTube link. The extension also tries to fetch the
transcript on your own tab (your IP, your session) and hand it to Echo in the
URL fragment, which sidesteps the datacenter bot-block described above; if
that fails it falls back to letting the server fetch, exactly as before. That
scrape path is **not yet confirmed against a real signed-in browser** — see
the headless-verification note in [`CLAUDE.md`](CLAUDE.md). **Chromium-only**:
Firefox needs `background.scripts` rather than an MV3 service worker, so the
extension does not load there. Load it unpacked from
[`extension/`](extension/) — `chrome://extensions` → Developer mode → **Load
unpacked**. Point it at your Echo in its options if it is not on
`http://localhost:8000`.

### Obsidian plugin

Two commands — read a URL, or read the YouTube link in your selection — and a
note lands in your vault with the transcript, the digest, and frontmatter
(`title`, `url`, `videoId`, `channel`, `tags`, `summary`). Copy
`manifest.json`, `main.js` and `styles.css` from
[`obsidian-plugin/`](obsidian-plugin/) into
`<vault>/.obsidian/plugins/echo-reader/`.

Note format and filename match `/api/vault/sync` exactly, so a vault fed by both
the plugin and folder-sync gets one consistent set of notes rather than two.

⚠️ The plugin has not yet been run inside Obsidian by its author — the logic is
covered by tests, the app integration is not. See its README.

## ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Server port |
| `ECHO_HOST` | `127.0.0.1` | Interface to bind. Localhost-only by default; set to `0.0.0.0` to expose (containers, reverse proxies) |
| `ECHO_MODE` | `local` | `local` (Claude Code CLI), `desktop` (CLI + optional BYOK), or `web` (visitor-supplied keys) |
| `ECHO_PROVIDER` | _(CLI)_ | Set to `api` to use Anthropic API instead of CLI. Web-mode per-request `X-Echo-Api-Key` also selects API provider. |
| `ANTHROPIC_API_KEY` | _(unset)_ | API key used when no per-request key is supplied |
| `ECHO_DB_PATH` | `data/library.db` | SQLite library database path (local/desktop only) |
| `ECHO_VAULT_DIR` | _(unset)_ | Default Obsidian vault folder for `/api/vault/sync` when none is passed |
| `ECHO_MAX_TRANSCRIPT_CHARS` | `200000` | Web-mode transcript character limit |
| `ECHO_MAX_AI_PAYLOAD_CHARS` | `200000` | Web-mode AI payload character limit |
| `ECHO_YTDLP_JS_RUNTIME` | `'node'` | JavaScript runtime for yt-dlp (Node >=22 supported); set to empty string to disable (required for older yt-dlp builds) |
| `ECHO_WHISPER_DEFAULT_MODEL` | `base` | Whisper model used when none is selected (`base` or `small`) |
| `ECHO_WHISPER_THREADS` | _(75% of cores)_ | Threads for whisper.cpp — lower it to keep the machine responsive |
| `ECHO_WHISPER_MAX_MINUTES` | `180` | Reject Whisper transcription of audio longer than this |
| `ECHO_GOOGLE_CLIENT_ID` | _(unset)_ | Google OAuth client ID. Set this, the secret and the session secret to enable accounts + library sync (web mode). Unset = no accounts, no database |
| `ECHO_GOOGLE_CLIENT_SECRET` | _(unset)_ | Google OAuth client secret |
| `ECHO_SESSION_SECRET` | _(unset)_ | Signs session cookies. Changing it signs everyone out |
| `ECHO_PUBLIC_URL` | _(request origin)_ | Public origin, used to build the OAuth redirect URI |
| `ECHO_SYNC_DB_PATH` | `/data/echo-sync.db` | SQLite file for accounts + synced libraries — the only server-side state |
| `ECHO_MAX_SYNC_BYTES` | `100000000` | Per-account synced-library size cap |
| `ECHO_WHISPER_VAD_MODEL` | _(unset)_ | Path to a Silero VAD model. Setting it makes Whisper skip non-speech (faster on audio with pauses); unset = today's behaviour. Opt-in — see [`WHISPER.md`](./WHISPER.md) |

See [`.env.example`](./.env.example) for the common variables with detailed documentation for each; the Whisper knobs above are documented in [`WHISPER.md`](./WHISPER.md). **Node version requirement:** ≥ 22.5 (for `node:sqlite` support).

## 🕹️ How to use

1. **Paste** a YouTube URL, optionally pick a caption language, and hit **Get transcript** — it lands in the **Transcript** tab. Or use **or open an audio / video file** to read something that was never on YouTube (local/desktop, with Whisper set up).
2. **Read** — toggle between Readable and Timecoded views. Adjust font size (A−/A+) and column width (Narrow/Medium/Wide). Use `/` to search and Prev/Next to navigate.
3. **Digest** — switch to the **Digest** lens and Echo generates the digest directly. A fixed status pill shows "AI is digesting…" and "Digest ready ✓" when done _(takes ~10–30s while Claude reads the transcript)._ Once generated, highlight any passage in the Digest to Explain or get Background — results render in an ephemeral floating popover.
4. **Copy or download** the transcript or digest as Markdown using the download button.
5. **Save** — click **Save** to store the video in your library; access saved videos via the **Library** button in the header (keyboard: `3`). Search, sort, tag, and manage your collection. Export your whole library as a ZIP of Markdown files or JSON backup.
6. **Keyboard help** — press `?` for all shortcuts.

## 🧩 Project structure

```
echo/
├── server.js         # Express server: all API routes + serves the UI
├── transcript.js     # video-ID parsing + caption fetch (library → yt-dlp) + error classification
├── whisper.js        # local whisper.cpp speech-to-text (local/desktop only)
├── whisperModel.js   # Whisper model registry + on-demand download/cache
├── digest.js         # digest generation (incl. map-reduce), auto-tagging
├── providers.js      # AI provider seam: local `claude` CLI vs Anthropic API (BYOK)
├── common/text.js    # shared with the page, the extension AND the plugin — one definition
├── auth.js           # Google sign-in + stateless signed-cookie sessions (hosted, optional)
├── syncStore.js      # accounts + synced libraries — the only server-side state
├── store.js          # SQLite library (local/desktop); web mode uses IndexedDB in the browser
├── markdown.js       # Markdown export + Obsidian vault index note
├── vault.js          # Obsidian vault folder sync
├── data/             # (gitignored, local/desktop only) persistent video library
│   └── library.db    # SQLite database of saved videos, transcripts, digests, tags
├── vendor/whisper/   # prebuilt whisper-cli binaries (linux-x64, win32-x64)
├── extension/        # Chrome extension (MV3) — Read in Echo from YouTube
├── obsidian-plugin/  # Obsidian plugin — a vault note per video
├── tools/            # dev-only: AI-writing eval, digest-fidelity eval, vendoring helper
├── public/
│   ├── index.html    # markup only (~680 lines)
│   ├── app.css       # the Plaintext theme, fully tokenised
│   ├── app.js        # the whole client — a classic script, no build step
│   ├── theme-init.js # sets the theme token before first paint
│   └── vendor/       # JSZip, vendored — no CDN, no external script origin
├── package.json
└── README.md
```

### API

| Method | Route | Body | Returns |
|--------|-------|------|---------|
| `GET` | `/api/health` | _(none)_ | `{ status: 'ok', mode }` |
| `POST` | `/api/validate-key` | _(key goes in the `X-Echo-Api-Key` header)_ | `{ valid: true }`, or a structured error envelope (web/desktop only) |
| `POST` | `/api/transcript` | `{ url, lang?, transcribe?, whisperModel?, jobId? }` | `{ videoId, url, title, channel, channelUrl, segments, langCode, transcriptSource }` |
| `POST` | `/api/transcript/file` | raw file bytes, `?name=&jobId=` | same envelope as `/api/transcript`, for a local audio/video file (local/desktop only) |
| `GET` | `/api/transcript/progress` | `?jobId=` | Server-sent events with live Whisper progress |
| `GET` | `/api/whisper/status` | _(none)_ | `{ binaryPresent, defaultModel, cacheDir, models }` (local/desktop only) |
| `POST` | `/api/whisper/model` | `{ model }` (`base`\|`small`) | download state for that model (local/desktop only) |
| `GET` | `/api/languages` | `?videoId=` | `{ tracks: [{ code, name, auto }] }` |
| `GET` | `/api/video-meta` | `?videoId=` | `{ videoId, title, channel, channelUrl }` (oEmbed metadata) |
| `POST` | `/api/digest` | `{ text, length?, format?, language?, title?, videoId? }` | `{ digest, usage, strategy, suggestedTags }` |
| `POST` | `/api/digest?stream=1` | _(same body)_ | `text/event-stream` — `phase` / `token` / `done` / `error` events; `done` carries the same payload as above |
| `GET` | `/api/auth/google` | _(none)_ | redirect into Google sign-in (accounts only) |
| `GET` | `/api/auth/callback` | `?code=&state=` | completes sign-in, sets the session cookie |
| `GET` | `/api/auth/me` | _(none)_ | `{ enabled, user }` — who is signed in, if anyone |
| `POST` | `/api/auth/logout` | _(none)_ | `{ ok: true }` |
| `POST` | `/api/auth/signout-everywhere` | _(none)_ | ends every session for the account, on every device |
| `DELETE` | `/api/auth/account` | _(none)_ | deletes the account and its synced library |
| `GET` | `/api/sync/pull` | `?since=` | entries changed since a timestamp, incl. tombstones |
| `POST` | `/api/sync/push` | `{ entries }` | `{ applied, skipped, serverTime }` — last write wins |
| `GET` | `/api/saved` | _(none)_ | list of saved entries (metadata incl. tags) |
| `GET` | `/api/saved?limit=&offset=` | _(none)_ | `{ entries, total, hasMore }` — one page of the same |
| `GET` | `/api/saved/export` | _(none)_ | `{ entries: [ ...full entries... ] }` |
| `GET` | `/api/saved/:videoId` | _(none)_ | one full entry (transcript, digest, tags) |
| `GET` | `/api/saved/:videoId/export.md` | _(none)_ | markdown export of entry |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest, tags? }` | saved entry metadata (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | _(none)_ | `{ ok: true }` |
| `PATCH` | `/api/saved/:videoId/tags` | `{ tags }` | updated entry |
| `GET` | `/api/search` | `?q=` (query string) | FTS5 keyword search over the library (local/desktop only) |
| `POST` | `/api/vault/sync` | `{ dir?, includeTranscript? }` | `{ dir, total, written, unchanged, failed, index }` (local/desktop only) |

## ⚠️ Good to know

- When a transcript can't be fetched, Echo tells you **why in plain language** — whether the video is a **scheduled premiere** ("hasn't aired yet"), a **live stream in progress**, **private**, **age-restricted**, **region-blocked**, **removed/unavailable**, or simply **has no captions** — instead of dumping a raw error. The underlying technical detail is one click away under **"Show technical details"**, and for a captionless video (local/desktop) it points you to **Whisper transcription** in Settings.
- YouTube occasionally shifts its internals; that's exactly what the `yt-dlp` fallback is there to cover.
- The **AI digest** needs Claude Code installed and logged in (local mode) or an Anthropic API key (web/desktop modes). Without AI, transcript reading, search, and library features work just fine. If a digest can't be generated — CLI not installed or signed in, or an API key/rate-limit issue — Echo shows a clear card explaining what to do (with an **Open Settings** or **Try again** button), not a cryptic error.
- Your **saved library** (`data/library.db`) is **gitignored** — it never leaves your machine and doesn't get pushed to any repo (local/desktop modes only; web mode uses client-side IndexedDB).
- **Whisper transcription** is off by default and local/desktop only. Turn it on in Settings as a **Fallback** (only when captions are missing) or **High-accuracy** (always). It needs `ffmpeg` on your `PATH`, runs entirely on your machine, and takes real time on long videos — a live progress bar shows where it's at, and closing the tab cancels it.
- **Nothing on the page comes from a third party.** The Content-Security-Policy allows no inline script, no inline style, and no external script or style origin at all (`script-src 'self'; style-src 'self'; font-src 'self'`) — JSZip is vendored, and the theme uses system fonts. The only outbound requests are YouTube thumbnails.
- **Signing in never moves your API key.** Accounts exist for one reason — a library that follows you between devices. The key stays in your browser's localStorage and is sent per-request; the server stores transcripts and digests, never credentials.
- Library **export to ZIP** uses a vendored copy of JSZip, fetched on first use rather than on every page load. Nothing on the page comes from a third-party origin, so the export works offline; a JSON backup remains as a fallback.
- Per-digest stats (tokens, cost, duration) are always shown when available; these are real billing data from your AI provider.

## 🔖 Send to Echo (bookmarklet)

> The [browser extension](extension/) does this better — a real button on the
> page, and it follows YouTube's in-app navigation. The bookmarklet stays for
> browsers where an extension is not an option.

Drag this bookmarklet to your bookmarks bar, then click it on any YouTube video page — Echo opens in a new tab with that video's transcript already loading. Requires Echo running locally at `http://localhost:8000`.

```
javascript:(function(){var u=location.href;var m=u.match(/[?&]v=([\w-]{11})/)||u.match(/youtu\.be\/([\w-]{11})/)||u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);var t=m?('http://localhost:8000/?v='+m[1]):('http://localhost:8000/?url='+encodeURIComponent(u));window.open(t,'_blank');})();
```

**How to install:** most browsers block dragging a code block straight into the bookmarks bar, so the reliable way is to create a new bookmark manually, paste the code above into its URL/address field, and give it a name like "Send to Echo".

No bookmarklet? You can also just open `http://localhost:8000/?v=VIDEO_ID` or `http://localhost:8000/?url=<full YouTube URL>` directly.

## 🧪 Development

```bash
npm test                  # 511 tests, no dependencies, ~4s
npm run digest:fidelity   # how faithfully saved digests carry the transcript's specifics
npm run digest:aitell     # score saved digests for AI-writing tells
```

Three things a unit test structurally cannot reach have their own harnesses.
They need Playwright, which is deliberately **not** a dependency, so they are
not part of `npm test`:

```bash
npm i --no-save playwright && npx playwright install chromium
node tests/e2e/oauth-flow.mjs    # the whole Google sign-in flow, against a mock provider
node extension/test/e2e.mjs      # the extension in a real browser, incl. YouTube's SPA navigation
```

CI runs the suite plus a boot job that checks every backend module parses and
the server actually starts in all three modes.

> ⚠️ **Two things to know before changing the frontend.** `public/app.css` and
> `public/app.js` are read and compressed at boot, so edits need a server
> restart. (Brotli is preferred over gzip when the browser offers it; it is
> built in the background after startup, so neither boot nor the first request
> waits on it.) And the CSP forbids inline
> `<script>`, inline `<style>`, `style=""` **and inline event handlers like
> `onerror=`** — all of which fail silently in a browser and are invisible to
> the test suite. Put code in `app.js`, CSS in `app.css`, and reach for a class
> or a real listener rather than an attribute. The last one is not theoretical:
> two thumbnail fallbacks used `onerror=""` and had quietly not worked since the
> policy was tightened.
>
> ⚠️ **And one about the library.** Anything touching "the whole library" needs
> bounding, and ten test entries will never show you the problem — seven bugs of
> that shape have been found so far, every one with a green suite. **Seed a few
> hundred entries before believing a library-wide path is fine.** The list
> itself renders a window at a time with delegated listeners, so never add a
> per-card `addEventListener` in the render path.

## 🛠️ Built with

**Node.js** · **Express** · **`node:sqlite`** · **[youtube-transcript](https://www.npmjs.com/package/youtube-transcript)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** · **[Claude Code](https://claude.com/claude-code)** · **[Tauri](https://tauri.app/)** · plain HTML/CSS/JS on a system monospace stack — no webfonts, no build step

## 📄 License

Released under the [MIT License](LICENSE) © 2026 ssani-main.

---

<div align="center">

_Made for reading, not scrubbing._ 🎧 → 📖

</div>
