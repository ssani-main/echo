<div align="center">

# 🎙️ Echo

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
| 📥 | **Transcript fetching** | Works with `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, or a bare video ID |
| 🧹 | **Readable mode** | Glues the ~2-second caption fragments back into proper sentences & paragraphs |
| ⏱️ | **Timecoded mode** | Subtitle-editor style view with a monospace timecode gutter |
| 🤖 | **AI digest** | TL;DR + key points + a topic-by-topic summary, always in English |
| 📑 | **Tabbed UI** | Three panes (Transcript · Digest · Saved) — one visible at a time; long transcripts no longer bury the digest |
| 🟢 | **Live status indicator** | Fixed pill shows "AI is digesting…" → "Digest ready ✓" as it processes, and jumps to the Digest pane |
| 📊 | **Usage readouts** | Today's total Claude Code cost + tokens (via **ccusage**), plus per-digest stats and session totals |
| ⭐ | **Save for later** | Click ★ to store the video with its transcript & digest in a personal library; re-save to fold in digests added later |
| 🛟 | **Automatic fallback** | If the transcript library hiccups, `yt-dlp` steps in |
| 🏠 | **Fully local** | Your own machine, your own browser — nothing leaves the room |

## 🤖 About the AI digest

The digest **doesn't need an Anthropic API key or any billing setup.** Instead, Echo shells out to your locally-installed [**Claude Code**](https://claude.com/claude-code) CLI in headless mode:

```bash
claude -p --model sonnet   # transcript piped in via stdin
```

So it reuses your existing Claude Code login and runs on your subscription quota. The prompt lives in [`digest.js`](./digest.js) — tweak one string if you'd rather have a pure summary, a full translation, or a different model.

### Usage tracking

Each digest shows its own **tokens · cost · duration**, and Echo tracks a **session total** from the CLI's JSON output. A **"Today" chip** in the header displays your total Claude Code usage for the current calendar day (cost + tokens), fetched on demand via the optional **ccusage** tool.

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

## 🕹️ How to use

1. **Paste** a YouTube URL and hit **Get transcript** — it lands in the **Transcript** tab.
2. Toggle between **Readable** and **Timecoded** views.
3. Hit **AI digest** — a fixed status pill shows progress ("AI is digesting…" → "Digest ready ✓"), and you can click it to jump to the **Digest** tab. _(takes ~10–30s while Claude reads the whole thing)._
4. Click **★ Save** to store the video (title, URL, transcript, digest) in your personal library — it appears in the **Saved** tab. Click an entry to re-open it, or delete it.
5. The **"Today"** chip in the header shows your total Claude Code usage for the day (cost + tokens).

## 🧩 Project structure

```
echo/
├── server.js         # Express server: API routes + serves the UI
├── transcript.js     # video-ID parsing + transcript fetch (library + yt-dlp fallback)
├── digest.js         # shells out to the Claude Code CLI for the AI digest
├── usage.js          # fetches today's Claude Code usage stats via ccusage
├── store.js          # file-based store for saved videos (library.json)
├── data/             # (gitignored) stores user's personal video library
│   └── library.json  # saved videos: metadata, transcripts, digests
├── public/
│   └── index.html    # the whole UI — one self-contained file, no build step
├── package.json
└── README.md
```

### API, briefly

| Method | Route | Body | Returns |
|--------|-------|------|---------|
| `POST` | `/api/transcript` | `{ url }` | `{ videoId, url, title, segments: [{ text, offset }] }` |
| `POST` | `/api/digest` | `{ text }` | `{ digest, usage: { costUsd, totalTokens, durationMs } }` |
| `GET` | `/api/usage` | _(none)_ | `{ available, date, costUsd, totalTokens }` — today's Claude Code totals |
| `GET` | `/api/saved` | _(none)_ | list of saved entries (metadata only) |
| `GET` | `/api/saved/:videoId` | _(none)_ | one full entry with transcript + digest |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest }` | saved entry metadata — save or update (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | _(none)_ | `{ ok: true }` |

## ⚠️ Good to know

- Videos with **captions disabled**, or that are **private / age-restricted**, can't be transcribed — Echo says so clearly instead of crashing.
- YouTube occasionally shifts its internals; that's exactly what the `yt-dlp` fallback is there to cover.
- The AI digest needs Claude Code installed and logged in — without it, everything else still works.
- Your **saved library** (`data/library.json`) is **gitignored** — it never leaves your machine and doesn't get pushed to any repo.
- The **usage readouts** show real Claude Code costs and tokens; the **"Today" chip** is cached ~60s server-side.

## 🛠️ Built with

**Node.js** · **Express** · **[youtube-transcript](https://www.npmjs.com/package/youtube-transcript)** · **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** · **[Claude Code](https://claude.com/claude-code)** · plain HTML/CSS/JS (Space Grotesk · Newsreader · JetBrains Mono)

---

<div align="center">

_Made for reading, not scrubbing._ 🎧 → 📖

</div>
