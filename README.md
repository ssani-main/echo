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
| ⏱️ | **Timecoded mode** | Subtitle-editor style with monospace timecode gutter; every timestamp deep-links YouTube (`&t=<sec>s`); same highlight & note features as Readable mode |
| 💾 | **Session restore** | Refreshing the page restores the current transcript, digest, Ask thread, highlights, view mode, lens, and Library state via sessionStorage—no re-fetch |
| 🤖 | **AI Workspace** | **Summary** (short/detailed, bullets/prose, pick output language) and **Ask** (chat thread, answers sourced only from the transcript) |
| 🔎 | **Selection-driven lookups** | Select any passage in the Digest to get a floating toolbar — **Explain** it (Claude's own knowledge), get **Background** or **Fact-check** it (live web search with citations), or **Ask** about it (seeds the Ask tab). Results render as an inline card under the passage |
| 🗂️ | **Research rail** | Every Explain/Background/Fact-check lookup for the current video collects in a slide-in **Research** drawer (header button, with count) — persists across a refresh, resets when you load a new video |
| 📑 | **Reader & Library** | Transcript and Digest are underlined lens tabs—two views of the current video. Saved videos open from a **Library** button in the header (with count). AI Workspace has its own sub-nav to jump between tools |
| 🟢 | **Live status indicator** | Fixed pill shows "AI is working…" → "Ready ✓" as it processes; click to jump to the Digest pane |
| 📊 | **Usage readouts** | Today's total Claude Code cost + tokens (via **ccusage**), plus per-digest stats and session totals |
| ⭐ | **Library & organization** | Click ★ to save videos with transcripts; search, sort (Recently saved / Title A–Z), tag with chips; export your whole library as a ZIP of Markdown files or a JSON backup |
| 📺 | **Playlist mode** | Paste a playlist URL (`list=`) to browse and load any video's transcript |
| ⌨️ | **Keyboard shortcuts** | Press `?` for the overlay; `/` focus find, `1`/`2` switch Transcript & Digest lenses, `3` open Library, `t` toggle dark mode, `Esc` close — all paused while typing |
| 🎨 | **Dark mode & fonts** | Crisp dark theme, Inter for reading, JetBrains Mono for code; loading skeletons respect reduced-motion |
| 🛟 | **Automatic fallback** | If the transcript library hiccups, `yt-dlp` steps in |
| 🏠 | **Fully local** | Your own machine, your own browser — nothing leaves the room |

## 🤖 About the AI Workspace

The AI Workspace **doesn't need an Anthropic API key or any billing setup.** Instead, Echo shells out to your locally-installed [**Claude Code**](https://claude.com/claude-code) CLI in headless mode, reusing your existing login and subscription quota. There are two tabs, plus selection-driven lookups on the Digest itself:

- **Summary**: TL;DR, key points, and topic-by-topic breakdown. Choose short or detailed, bullets or prose, and pick your output language (default English).
- **Ask**: Multi-turn chat grounded in the transcript. Every answer is sourced only from what was said — no outside knowledge mixed in.

**Selection-driven lookups on the Digest.** Highlight any passage in a generated Digest and a small toolbar appears with four actions:

- **Explain**: A 1–3 sentence explanation from Claude's own knowledge (no web search) — good for jargon or a quick definition.
- **Background**: 2–4 sentences of context, grounded in a live web search with linked sources.
- **Fact-check**: A supported/disputed/unverifiable verdict on the highlighted claim, grounded in a live web search with linked sources. ⚠️ **Honest caveat:** the verdict is only as good as what the web search turns up — always verify anything consequential yourself.
- **Ask**: Seeds the Ask tab with the highlighted passage so you can ask a follow-up question about it.

Every Explain/Background/Fact-check result also renders as an inline card right under the passage, and collects in the **Research** rail (header button, with count) so you can review everything you've looked up for the current video — it persists across a page refresh and resets when you load a new video.

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
2. **Read** — toggle between Readable and Timecoded views. Adjust font size (A−/A+) and column width (Narrow/Medium/Wide). Use `/` to search, Prev/Next to navigate, or highlight text and add notes (all saved automatically).
3. **Copy or download** the transcript or digest as Markdown using the download button.
4. **AI Workspace** — click the Summary or Ask tab. A fixed status pill shows "AI is working…" and jumps to the Digest pane when ready. _(takes ~10–30s while Claude reads the whole thing)._ Once a Digest is generated, highlight any passage in it to Explain, get Background, Fact-check, or Ask about it — results collect in the **Research** rail.
5. **Save** — click **★** to store the video in your library; access saved videos via the **Library** button in the header (keyboard: `3`). Search, sort, tag, and add notes. Export your whole library as a ZIP of Markdown files or JSON backup.
6. **Playlist mode** — paste a `list=` URL to browse and load videos from a playlist.
7. **Keyboard help** — press `?` for shortcuts. The **"Claude usage today"** chip shows your total Claude Code usage for the day (cost + tokens).

## 🧩 Project structure

```
echo/
├── server.js         # Express server: API routes + serves the UI
├── transcript.js     # video-ID parsing + transcript fetch (library + yt-dlp fallback)
├── digest.js         # shells out to the Claude Code CLI for the AI workspace tools
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
| `GET` | `/api/health` | _(none)_ | `{ status: 'ok', mode }` |
| `POST` | `/api/validate-key` | `{ key }` | `{ valid: true }` or `{ valid: false, error }` |
| `POST` | `/api/transcript` | `{ url, lang? }` | `{ videoId, url, title, segments }` |
| `GET` | `/api/languages` | `?videoId=` | `{ tracks: [{ code, name, auto }] }` |
| `POST` | `/api/playlist` | `{ url }` | `{ playlistTitle, videos: [{ videoId, title }] }` |
| `POST` | `/api/digest` | `{ text, length?, format?, language? }` | `{ digest, usage }` |
| `POST` | `/api/enrich` | `{ selection, context?, mode }` (`mode`: `explain`\|`background`\|`factcheck`) | `{ mode, text, sources: [{ title, url }], usage, verdict? }` |
| `GET` | `/api/saved` | _(none)_ | list of saved entries (metadata incl. tags, favorite, noteCount, highlightCount) |
| `GET` | `/api/saved/export` | _(none)_ | `{ entries: [ ...full entries... ] }` |
| `GET` | `/api/saved/:videoId` | _(none)_ | one full entry (transcript, digest, tags, notes, highlights) |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest }` | saved entry metadata (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | _(none)_ | `{ ok: true }` |
| `PATCH` | `/api/saved/:videoId/tags` | `{ tags }` | updated entry |

## ⚠️ Good to know

- Videos with **captions disabled**, or that are **private / age-restricted**, can't be transcribed — Echo says so clearly instead of crashing.
- YouTube occasionally shifts its internals; that's exactly what the `yt-dlp` fallback is there to cover.
- The **AI Workspace** tools need Claude Code installed and logged in — without it, transcript reading, search, and library features work just fine.
- Your **saved library** (`data/library.json`) is **gitignored** — it never leaves your machine and doesn't get pushed to any repo.
- **Explain** is grounded in Claude's own training knowledge with **no live web access**; **Background** and **Fact-check** run a live web search for citations, but always verify anything consequential via other sources.
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

## 📄 License

Released under the [MIT License](LICENSE) © 2026 ssani-main.

---

<div align="center">

_Made for reading, not scrubbing._ 🎧 → 📖

</div>
