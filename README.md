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
| 🧹 | **Readable mode** | Glues captions into proper sentences & paragraphs; find-in-transcript with live match counter and Prev/Next navigation; highlight passages, attach notes, and copy/download as Markdown — all persists across sessions |
| 🎛️ | **Shared reading controls** | Font size (A−/A+) and column width (Narrow/Medium/Wide: ~620 / 760 / 940 px) apply to both Transcript and Digest lenses, share one preference, and scale the reading column responsively. Digest AI output is typeset as a readable article |
| ⏱️ | **Timecoded mode** | Subtitle-editor style with monospace timecode gutter; every timestamp deep-links YouTube (`&t=<sec>s`); same highlight & note features as Readable mode |
| 💾 | **Session restore** | Refreshing the page restores the current transcript, digest, Ask thread, highlights, view mode, lens, and Library state via sessionStorage—no re-fetch |
| 🤖 | **AI Workspace** | Five-tab AI assistant grounded in your transcript: **Summary** (short/detailed, bullets/prose, pick output language), **Ask** (chat thread, answers sourced only from the transcript), **Fact-check** (claims assessed with confidence), **Chapters** (AI-generated outline with timecoded jumps), **Quotes** (key excerpts with timestamps) — all without web search |
| 📑 | **Reader & Library** | Transcript and Digest are underlined lens tabs—two views of the current video. Saved videos open from a **Library** button in the header (with count). AI Workspace has its own sub-nav to jump between tools |
| 🟢 | **Live status indicator** | Fixed pill shows "AI is working…" → "Ready ✓" as it processes; click to jump to the Digest pane |
| 📊 | **Usage readouts** | Today's total Claude Code cost + tokens (via **ccusage**), plus per-digest stats and session totals |
| ⭐ | **Library & organization** | Click ★ to save videos with transcripts; search, sort (Recently saved / Title A–Z / Favorites first), tag with chips, add per-video notes, and mark favorites; export your whole library as a ZIP of Markdown files or a JSON backup |
| 📺 | **Playlist mode** | Paste a playlist URL (`list=`) to browse and load any video's transcript |
| ⌨️ | **Keyboard shortcuts** | Press `?` for the overlay; `/` focus find, `1`/`2` switch Transcript & Digest lenses, `3` open Library, `t` toggle dark mode, `Esc` close — all paused while typing |
| 🎨 | **Dark mode & fonts** | Crisp dark theme, Inter for reading, JetBrains Mono for code; loading skeletons respect reduced-motion |
| 🛟 | **Automatic fallback** | If the transcript library hiccups, `yt-dlp` steps in |
| 🏠 | **Fully local** | Your own machine, your own browser — nothing leaves the room |

## 🤖 About the AI Workspace

The AI Workspace **doesn't need an Anthropic API key or any billing setup.** Instead, Echo shells out to your locally-installed [**Claude Code**](https://claude.com/claude-code) CLI in headless mode, reusing your existing login and subscription quota. Each tool runs the transcript through Claude with a tailored prompt:

- **Summary**: TL;DR, key points, and topic-by-topic breakdown. Choose short or detailed, bullets or prose, and pick your output language (default English).
- **Ask**: Multi-turn chat grounded in the transcript. Every answer is sourced only from what was said — no outside knowledge mixed in.
- **Fact-check**: Extracts claims and assesses them as supported, disputed, or unverifiable with confidence levels. ⚠️ **Honest caveat:** assessment is from Claude's training knowledge **with no live web access** — use it as a starting point, but verify important claims yourself via other sources.
- **Chapters**: Generates a chapter outline from the transcript with AI-generated titles and timecoded jump links to both YouTube and the transcript.
- **Quotes**: Pulls key quotes directly from the transcript with their timecodes, suitable for reference or sharing.

The prompts live in [`digest.js`](./digest.js) — tweak them if you'd rather have a different model, tone, or analysis approach. Each tool shows its own **tokens · cost · duration**.

### Usage tracking

Echo tracks Claude Code usage from the CLI's JSON output. A **"Claude usage today" chip** in the header displays your total Claude Code usage for the current calendar day (cost + tokens), fetched on demand via the optional **ccusage** tool.

> **Note:** these are actual cost and token figures from Claude Code, **not** the Claude web app's daily usage percentage — that percentage isn't available via any API. The usage readouts show real billing data.

## 🚀 Getting started

### Prerequisites

- **[Node.js](https://nodejs.org/) ≥ 18**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** _(optional)_ — the reliability fallback. `winget install yt-dlp` or `pip install yt-dlp`, and make sure it's on your `PATH`.
- **[Claude Code](https://claude.com/claude-code)** _(optional)_ — only needed for the **AI digest** button.
- **[ccusage](https://www.npmjs.com/package/ccusage)** _(optional)_ — shows today's total Claude Code usage. Runs on demand via `npx`, no installation needed; if unavailable, the rest of the app works fine.

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
- Key stored in browser's **localStorage**, sent per-request as `X-Echo-Api-Key` header — **never stored on server**
- Library stored in browser's **IndexedDB** — each visitor's library is isolated, no user accounts

**Web-mode limits:**
- Semantic search disabled (falls back to client-side text filtering)
- Per-IP rate limiting to prevent abuse
- Transcript and AI payload size caps
- Playlist digest disabled

### Desktop app (Tauri v2)

A native window wrapper running the same Node backend as a sidecar. Build prerequisites (Rust, VS C++ Build Tools 2022, WebView2) and commands (`npm run tauri:dev`, `npm run tauri:build`) are documented in `DESKTOP.md` — refer to that file.

---

## ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Server port |
| `ECHO_MODE` | `local` | `local` (Claude Code CLI) or `web` (visitor-supplied keys) |
| `ECHO_PROVIDER` | _(CLI)_ | Set to `api` to use Anthropic API instead of CLI. Web-mode per-request `X-Echo-Api-Key` also selects API provider. |
| `ANTHROPIC_API_KEY` | _(unset)_ | API key used when no per-request key is supplied |
| `ECHO_DB_PATH` | `data/library.db` | SQLite library database path |
| `ECHO_MODELS_DIR` | `data/models` | Embeddings model cache directory |
| `ECHO_MAX_TRANSCRIPT_CHARS` | `200000` | Web-mode transcript character limit |
| `ECHO_MAX_AI_PAYLOAD_CHARS` | `200000` | Web-mode AI payload character limit |

**Node version requirement:** ≥ 22.5 (for `node:sqlite` support).

## 🕹️ How to use

1. **Paste** a YouTube URL, optionally pick a caption language, and hit **Get transcript** — it lands in the **Transcript** tab.
2. **Read** — toggle between Readable and Timecoded views. Adjust font size (A−/A+) and column width (Narrow/Medium/Wide). Use `/` to search, Prev/Next to navigate, or highlight text and add notes (all saved automatically).
3. **Copy or download** the transcript or digest as Markdown using the download button.
4. **AI Workspace** — click any of the five tabs (Summary · Ask · Fact-check · Chapters · Quotes). A fixed status pill shows "AI is working…" and jumps to the Digest pane when ready. _(takes ~10–30s while Claude reads the whole thing)._
5. **Save** — click **★** to store the video in your library; access saved videos via the **Library** button in the header (keyboard: `3`). Search, sort, tag, and add notes. Export your whole library as a ZIP of Markdown files or JSON backup.
6. **Playlist mode** — paste a `list=` URL to browse and load videos from a playlist.
7. **Keyboard help** — press `?` for shortcuts. The **"Claude usage today"** chip shows your total Claude Code usage for the day (cost + tokens).

## 🧩 Project structure

```
echo/
├── server.js         # Express server: API routes + serves the UI
├── transcript.js     # video-ID parsing + transcript fetch (library + yt-dlp fallback)
├── digest.js         # shells out to the Claude Code CLI for the AI workspace tools
├── usage.js          # fetches today's Claude Code usage stats via ccusage
├── store.js          # file-based store for saved videos (library.json)
├── data/             # (gitignored) stores user's personal video library
│   └── library.json  # saved videos: metadata, transcripts, digests, tags, notes, highlights
├── public/
│   └── index.html    # the whole UI — one self-contained file, no build step; loads JSZip from CDN for library export
├── package.json
└── README.md
```

### API

| Method | Route | Body | Returns |
|--------|-------|------|---------|
| `POST` | `/api/transcript` | `{ url, lang? }` | `{ videoId, url, title, segments }` |
| `GET` | `/api/languages` | `?videoId=` | `{ tracks: [{ code, name, auto }] }` |
| `POST` | `/api/playlist` | `{ url }` | `{ playlistTitle, videos: [{ videoId, title }] }` |
| `POST` | `/api/digest` | `{ text, length?, format?, language? }` | `{ digest, usage }` |
| `POST` | `/api/chat` | `{ text, question }` | `{ answer, usage }` |
| `POST` | `/api/chapters` | `{ segments }` | `{ chapters: [{ title, startSec }], usage }` |
| `POST` | `/api/quotes` | `{ segments }` | `{ quotes: [{ text, startSec }], usage }` |
| `POST` | `/api/factcheck` | `{ text }` | `{ claims: [{ claim, assessment, confidence, explanation }], caveat, usage }` |
| `GET` | `/api/usage` | _(none)_ | today's Claude Code totals |
| `GET` | `/api/saved` | _(none)_ | list of saved entries (metadata incl. tags, favorite, noteCount, highlightCount) |
| `GET` | `/api/saved/export` | _(none)_ | `{ entries: [ ...full entries... ] }` |
| `GET` | `/api/saved/:videoId` | _(none)_ | one full entry (transcript, digest, tags, notes, highlights) |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest }` | saved entry metadata (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | _(none)_ | `{ ok: true }` |
| `PATCH` | `/api/saved/:videoId/tags` | `{ tags }` | updated entry |
| `PATCH` | `/api/saved/:videoId/favorite` | `{ favorite }` | updated entry |
| `POST` | `/api/saved/:videoId/notes` | `{ text }` | created note |
| `DELETE` | `/api/saved/:videoId/notes/:noteId` | _(none)_ | `{ ok: true }` |
| `PUT` | `/api/saved/:videoId/highlights` | `{ highlights }` | updated entry |
| `POST` | `/api/saved/:videoId/highlights` | `{ text, note?, color? }` | created highlight |
| `DELETE` | `/api/saved/:videoId/highlights/:highlightId` | _(none)_ | `{ ok: true }` |

## ⚠️ Good to know

- Videos with **captions disabled**, or that are **private / age-restricted**, can't be transcribed — Echo says so clearly instead of crashing.
- YouTube occasionally shifts its internals; that's exactly what the `yt-dlp` fallback is there to cover.
- The **AI Workspace** tools need Claude Code installed and logged in — without it, transcript reading, search, and library features work just fine.
- Your **saved library** (`data/library.json`) is **gitignored** — it never leaves your machine and doesn't get pushed to any repo.
- **Fact-check** is grounded in Claude's training knowledge; it has **no live web access**, so verify important claims via other sources.
- The **usage readouts** show real Claude Code costs and tokens; the **"Claude usage today" chip** is cached ~60s server-side.
- Library **export to ZIP** loads JSZip from a CDN; if the CDN is unavailable, the app falls back to a single JSON backup file.

## 🔖 Send to Echo (bookmarklet)

Drag this bookmarklet to your bookmarks bar, then click it on any YouTube video page — Echo opens in a new tab with that video's transcript already loading. Requires Echo running locally at `http://localhost:8000`.

```
javascript:(function(){var u=location.href;var m=u.match(/[?&]v=([\w-]{11})/)||u.match(/youtu\.be\/([\w-]{11})/)||u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);var t=m?('http://localhost:8000/?v='+m[1]):('http://localhost:8000/?url='+encodeURIComponent(u));window.open(t,'_blank');})();
```

**How to install:** most browsers block dragging a code block straight into the bookmarks bar, so the reliable way is to create a new bookmark manually, paste the code above into its URL/address field, and give it a name like "Send to Echo".

No bookmarklet? You can also just open `http://localhost:8000/?v=VIDEO_ID` or `http://localhost:8000/?url=<full YouTube URL>` directly.

## 🛠️ Built with

**Node.js** · **Express** · **[youtube-transcript](https://www.npmjs.com/package/youtube-transcript)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[Claude Code](https://claude.com/claude-code)** · plain HTML/CSS/JS (Space Grotesk · Inter · JetBrains Mono)

---

<div align="center">

_Made for reading, not scrubbing._ 🎧 → 📖

</div>
