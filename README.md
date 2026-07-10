<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/echo-logo-dark.png">
  <img alt="Echo" src="public/echo-logo-light.png" width="210">
</picture>

### _Paste a YouTube link. Read what was actually said._

Echo pulls the transcript out of any YouTube video, reflows the messy auto-captions into something you'd actually want to read, and — if you like — hands it to AI for a clean English digest.

<br>

![Node](https://img.shields.io/badge/Node-%E2%89%A518-3c873a?style=flat-square&logo=node.js&logoColor=white)
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
   📥  fetch the caption track          (youtube-transcript → yt-dlp fallback)
        │
        ▼
   🧹  reflow into readable paragraphs   (sentence + pause aware)
        │
        ▼
   🤖  optional: AI digest in English    (via your local Claude Code CLI)
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
| 🤖 | **AI Workspace** | **Summary**: AI-generated digest with short/detailed, bullets/prose, and output language options |
| 🔎 | **Selection-driven enrich** | Select any passage in the Digest to show an ephemeral floating popover with **Explain** (Claude's own knowledge), **Background** (live web search with citations), and **Verify** (claim verification via web search). Results render inside the popover; dismiss on click-outside, Esc, or new selection—nothing persists |
| 📑 | **Reader & Library** | Transcript and Digest are lens tabs—two views of the current video. Saved videos open from a **Library** button in the header (with count) |
| 🟢 | **Live status indicator** | Fixed pill shows "AI is digesting…" → "Digest ready ✓" as it processes; click to jump to the Digest pane |
| 💾 | **Library & tagging** | Save videos; search by keyword (SQLite FTS5), sort (Recently saved / Title A–Z), tag with auto-suggestions; export whole library as ZIP of Markdown files or JSON backup; sync to Obsidian vault |
| 🎬 | **Channel following & Inbox** | Follow YouTube channels, browse channel uploads, and track new uploads in an Inbox card-grid (local/desktop only) |
| 📺 | **Playlist mode** | Paste a playlist URL (`list=`) to browse and load any video's transcript; multi-video digest (local/desktop only) |
| 🔗 | **Shareable digest pages** | Generate a shareable public URL (`/s/:id`) for any digest; optional "Key claims" verification ledger (local/desktop only) |
| 🔍 | **Discovery** | In-app YouTube search and browse (local/desktop only) |
| ⌨️ | **Keyboard shortcuts** | Press `?` for the overlay; `/` focus find, `1`/`2` switch Transcript & Digest lenses, `3` open Library, `t` toggle dark mode, `Esc` close — all paused while typing |
| 🎨 | **Dark mode & fonts** | Crisp dark-first theme ("Signal" aesthetic), Inter for reading, JetBrains Mono for code; loading skeletons respect reduced-motion |
| 🛟 | **Automatic fallback** | If the transcript library hiccups, `yt-dlp` steps in |
| 🏠 | **Fully local** | Your own machine, your own browser — nothing leaves the room |

## 🤖 About the AI Workspace

The AI Workspace **doesn't need an Anthropic API key or any billing setup** when running locally. Echo shells out to your locally-installed [**Claude Code**](https://claude.com/claude-code) CLI in headless mode, reusing your existing login and subscription quota.

- **Summary**: AI-generated digest with TL;DR, key points, and topic-by-topic breakdown. Choose short or detailed, bullets or prose, and pick your output language (default English).

**Selection-driven lookups on the Digest.** Highlight any passage in a generated Digest and a floating popover appears with three actions:

- **Explain**: A 1–3 sentence explanation from Claude's own knowledge (no web search) — good for jargon or a quick definition.
- **Background**: 2–4 sentences of context, grounded in a live web search with linked sources.
- **Verify**: A supported/disputed/mixed/unverifiable verdict on the highlighted claim, grounded in a live web search with linked sources (hidden in web mode). ⚠️ **Honest caveat:** the verdict is only as good as what the web search turns up — always verify anything consequential yourself.

Results render **inside the popover** (max-height 320px, scrollable); dismiss with Esc, click-outside, or select new text — nothing persists. Every enrich call shows its **tokens · cost · duration**.

The prompts live in [`digest.js`](./digest.js) — tweak them if you'd rather have a different model, tone, or analysis approach.

## 🚀 Getting started

### Prerequisites

- **[Node.js](https://nodejs.org/) ≥ 22.5**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** _(optional)_ — the reliability fallback. `winget install yt-dlp` or `pip install yt-dlp`, and make sure it's on your `PATH`.
- **[Claude Code](https://claude.com/claude-code)** _(optional)_ — only needed for the **AI Workspace** (Summary and Explain/Background/Verify tools). Desktop mode can use BYOK (Bring Your Own Key) from Anthropic as a fallback.

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

Opens **http://localhost:8000**. The AI Workspace shells out to your locally-installed [Claude Code CLI](https://claude.com/claude-code) — no API key or subscription setup needed, reuses your existing quota. **This is the standard way to run Echo and requires no environment configuration.**

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

**Web-mode limits:**
- Server-side library API disabled (HTTP 503): `/api/saved*` — library in IndexedDB only
- Per-IP rate limiting: 20 requests / 60s on AI and transcript routes
- Transcript and AI payload size caps
- Batch playlist digest unavailable

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
- Uses `node:22-bookworm-slim` with yt-dlp for transcript fallback and Discovery features

To customize, edit `.env` before building, or pass environment variables at runtime:
```bash
docker run -e PORT=3000 -e ECHO_MODE=web -p 3000:3000 echo
```

---

## ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Server port |
| `ECHO_MODE` | `local` | `local` (Claude Code CLI) or `web` (visitor-supplied keys) |
| `ECHO_PROVIDER` | _(CLI)_ | Set to `api` to use Anthropic API instead of CLI. Web-mode per-request `X-Echo-Api-Key` also selects API provider. |
| `ANTHROPIC_API_KEY` | _(unset)_ | API key used when no per-request key is supplied |
| `ECHO_DB_PATH` | `data/library.db` | SQLite library database path |
| `ECHO_MAX_TRANSCRIPT_CHARS` | `200000` | Web-mode transcript character limit |
| `ECHO_MAX_AI_PAYLOAD_CHARS` | `200000` | Web-mode AI payload character limit |

See [`.env.example`](./.env.example) for the full list of variables and detailed documentation for each. **Node version requirement:** ≥ 22.5 (for `node:sqlite` support).

## 🕹️ How to use

1. **Paste** a YouTube URL, optionally pick a caption language, and hit **Get transcript** — it lands in the **Transcript** tab.
2. **Read** — toggle between Readable and Timecoded views. Adjust font size (A−/A+) and column width (Narrow/Medium/Wide). Use `/` to search and Prev/Next to navigate.
3. **AI Workspace** — click the **Digest** tab, then **Summary**. A fixed status pill shows "AI is digesting…" and "Digest ready ✓" when done _(takes ~10–30s while Claude reads the transcript)._ Once generated, highlight any passage in the Digest to Explain, get Background, or Verify claims — results render in an ephemeral floating popover.
4. **Copy or download** the transcript or digest as Markdown using the download button.
5. **Save** — click **Save** to store the video in your library; access saved videos via the **Library** button in the header (keyboard: `3`). Search, sort, tag, and manage your collection. Export your whole library as a ZIP of Markdown files or JSON backup.
6. **Playlist mode** — paste a `list=` URL to browse and load videos from a playlist (local/desktop only).
7. **Channel following** — click **Follow** on any video card in Discovery or Inbox to track a channel's uploads (local/desktop only).
8. **Share digest** — click **Share** to generate a public shareable link for any digest (local/desktop only).
9. **Keyboard help** — press `?` for all shortcuts.

## 🧩 Project structure

```
echo/
├── server.js         # Express server: API routes + serves the UI
├── transcript.js     # video-ID parsing + transcript fetch (library + yt-dlp fallback)
├── digest.js         # AI workspace tools: Summary, Explain/Background/Verify
├── store.js          # library storage layer (local: file-based; web: IndexedDB)
├── data/             # (gitignored, local mode only) persistent video library
│   └── library.db    # SQLite database of saved videos, tags, follows, inbox
├── public/
│   └── index.html    # the whole UI — one self-contained file, no build step; loads JSZip from CDN for library export
├── package.json
└── README.md
```

### API

| Method | Route | Body | Returns |
|--------|-------|------|---------|
| `GET` | `/api/health` | _(none)_ | `{ status: 'ok', mode }` |
| `POST` | `/api/validate-key` | `{ key }` | `{ valid: true }` or `{ valid: false, error }` |
| `POST` | `/api/transcript` | `{ url, lang? }` | `{ videoId, url, title, segments }` |
| `GET` | `/api/languages` | `?videoId=` | `{ tracks: [{ code, name, auto }] }` |
| `GET` | `/api/video-meta` | `?videoId=` | `{ title, channel, channelUrl, duration, … }` (oEmbed metadata) |
| `POST` | `/api/playlist` | `{ url }` | `{ playlistTitle, videos: [{ videoId, title }] }` (local/desktop only) |
| `POST` | `/api/digest` | `{ text, length?, format?, language? }` | `{ digest, usage, suggestedTags }` |
| `POST` | `/api/enrich` | `{ selection, context?, mode }` (`mode`: `explain`\|`background`\|`factcheck`) | `{ mode, text, sources: [{ title, url }], usage, verdict? }` |
| `POST` | `/api/claims` | `{ claims: [...], context? }` | `{ results: [{ claim, verdict, sources }] }` (local/desktop only) |
| `GET` | `/api/saved` | _(none)_ | list of saved entries (metadata incl. tags) |
| `GET` | `/api/saved/export` | _(none)_ | `{ entries: [ ...full entries... ] }` |
| `GET` | `/api/saved/:videoId` | _(none)_ | one full entry (transcript, digest, tags) |
| `GET` | `/api/saved/:videoId/export.md` | _(none)_ | markdown export of entry |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest, tags? }` | saved entry metadata (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | _(none)_ | `{ ok: true }` |
| `PATCH` | `/api/saved/:videoId/tags` | `{ tags }` | updated entry |
| `POST` | `/api/share` | `{ digest, claims? }` | `{ id, shortUrl }` (local/desktop only) |
| `DELETE` | `/api/share/:id` | _(none)_ | `{ ok: true }` (local/desktop only) |
| `POST` | `/api/vault/sync` | `{ url, videoId, title, digest, tags? }` | `{ synced: true, path }` (local/desktop only) |
| `POST` | `/api/cross-digest` | `{ texts: [...], length?, format?, language? }` | `{ digest, usage }` (multi-video; local/desktop only) |
| `POST` | `/api/playlist/digest` | `{ url, length?, format? }` | async digest job (local/desktop only) |
| `GET` | `/api/playlist/digest/status` | `?jobId=` | `{ jobId, status, progress, digest? }` (local/desktop only) |
| `POST` | `/api/playlist/digest/cancel` | `{ jobId }` | `{ ok: true }` (local/desktop only) |
| `GET` | `/api/search` | `?q=&tags?=` | library search results (local/desktop only) |
| `GET` | `/api/discovery/search` | `?q=` | YouTube search results (local/desktop only) |
| `GET` | `/api/discovery/foryou` | _(none)_ | For You feed (local/desktop only) |
| `POST` | `/api/follows` | `{ channelId, channelUrl, channelName? }` | follow entry (local/desktop only) |
| `GET` | `/api/follows` | _(none)_ | list of followed channels (local/desktop only) |
| `DELETE` | `/api/follows/:channelId` | _(none)_ | `{ ok: true }` (local/desktop only) |
| `GET` | `/api/follows/inbox` | `?page=` | paginated inbox of new uploads (local/desktop only) |
| `POST` | `/api/follows/seen` | `{ videoIds: [...] }` | mark as seen (local/desktop only) |
| `GET` | `/api/follows/channel` | `?channelId=&page=` | channel upload history (local/desktop only) |

## ⚠️ Good to know

- Videos with **captions disabled**, or that are **private / age-restricted**, can't be transcribed — Echo says so clearly instead of crashing.
- YouTube occasionally shifts its internals; that's exactly what the `yt-dlp` fallback is there to cover.
- The **AI Workspace** tools need Claude Code installed and logged in (local mode) or an Anthropic API key (web/desktop modes). Without AI, transcript reading, search, and library features work just fine.
- Your **saved library** (`data/library.db`) is **gitignored** — it never leaves your machine and doesn't get pushed to any repo (local/desktop modes only; web mode uses client-side IndexedDB).
- **Explain** is grounded in Claude's own training knowledge with **no live web access**; **Background** and **Verify** run a live web search for citations, but always verify anything consequential via other sources.
- Each enrich lookup shows its own **tokens · cost · duration**.
- Library **export to ZIP** loads JSZip from a CDN; if the CDN is unavailable, the app falls back to a single JSON backup file.
- Per-digest stats (tokens, cost, duration) are always shown when available; these are real billing data from your AI provider.

## 🔖 Send to Echo (bookmarklet)

Drag this bookmarklet to your bookmarks bar, then click it on any YouTube video page — Echo opens in a new tab with that video's transcript already loading. Requires Echo running locally at `http://localhost:8000`.

```
javascript:(function(){var u=location.href;var m=u.match(/[?&]v=([\w-]{11})/)||u.match(/youtu\.be\/([\w-]{11})/)||u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);var t=m?('http://localhost:8000/?v='+m[1]):('http://localhost:8000/?url='+encodeURIComponent(u));window.open(t,'_blank');})();
```

**How to install:** most browsers block dragging a code block straight into the bookmarks bar, so the reliable way is to create a new bookmark manually, paste the code above into its URL/address field, and give it a name like "Send to Echo".

No bookmarklet? You can also just open `http://localhost:8000/?v=VIDEO_ID` or `http://localhost:8000/?url=<full YouTube URL>` directly.

## 🛠️ Built with

**Node.js** · **Express** · **[youtube-transcript](https://www.npmjs.com/package/youtube-transcript)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[Claude Code](https://claude.com/claude-code)** · plain HTML/CSS/JS (Space Grotesk · Inter · JetBrains Mono)

## 📄 License

Released under the [MIT License](LICENSE) © 2026 ssani-main.

---

<div align="center">

_Made for reading, not scrubbing._ 🎧 → 📖

</div>
