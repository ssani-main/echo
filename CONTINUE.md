# Echo — Continuation / Handoff

This file captures in-progress work on branch `feat/sqlite-and-features` so any future
session can resume with zero context loss. Delete it once all remaining tasks are merged.

## Big picture
A round of robustness + feature work on Echo (local YouTube transcript reader, `claude -p`
CLI for AI, no API key). Ten items were planned. **Five are done and committed on this
branch**; five remain.

## Environment / decisions worth knowing
- **Storage is now SQLite** via Node's built-in `node:sqlite` (NOT better-sqlite3 — that
  failed to compile: this machine has no Visual Studio C++ build tools). This raises the
  **minimum Node version to 22.5+** (dev machine is on 24.11.1). DB lives at
  `data/library.db` (the `data/` dir is gitignored). The old `data/library.json` is kept
  untouched as a backup; migration into SQLite is idempotent and runs on first store load.
- **`@xenova/transformers` installed successfully** (pure JS + ONNX prebuilds, no C++
  needed). Semantic search is fully live in `mode: "hybrid"`. Model `Xenova/all-MiniLM-L6-v2`
  (quantized ~23MB) is lazy-loaded and cached at `data/models/`. If it ever fails, search
  transparently degrades to `mode: "keyword"` (FTS5) — never crashes.
- Every store/digest function kept its **exact signature**; features were added, not
  changed, so `server.js` <-> `store.js` <-> `digest.js` contracts are stable.
- There is a **toast system** in `public/index.html`: `showToast(level, message, hint)` and
  `handleApiError(data)`; backend returns a structured error envelope
  `{ error: { code, message, hint } }` via `sendError` / `sendCaughtError` in `server.js`.
  **Reuse these** in any new UI/endpoint.
- The single-page frontend `public/index.html` is a ~6.5k-line monolith. Only ONE agent
  should edit it at a time (parallel edits clobber). Same for `server.js`.

## DONE (committed on this branch)
1. **SQLite migration** — `store.js` rewritten on `node:sqlite`; FTS5 table `videos_fts`;
   tables `videos`, `tags`, `notes`, `highlights`, `embeddings`. New exports:
   `searchLibrary`, `getEmbedding`, `setEmbedding`, `allEmbeddings`.
2. **Transcript chunking** — `digest.js` map-reduce for long transcripts (threshold ~120k
   tokens / 480k chars). Helpers: `estimateTokens`, `chunkText`, `chunkSegments`,
   `mergeUsage`. Fast path unchanged for normal videos. Usage stats aggregate across calls.
3. **Error UX** — structured error envelope + codes (CLAUDE_NOT_INSTALLED, CLAUDE_NOT_AUTHED,
   CLAUDE_FAILED, YTDLP_MISSING, TRANSCRIPT_UNAVAILABLE, INVALID_URL, INTERNAL) across all
   routes; accessible toast banners; status pill can't get stuck.
4. **Hybrid semantic search** — `embeddings.js` (MiniLM); routes `GET /api/search`,
   `POST /api/search/reindex`, `GET /api/search/status`; library search box is debounced +
   server-backed; "semantic" pill + "Semantic index" button in the Saved toolbar.
5. **Cross-video digest** — `generateCrossDigest(entries, options)` in `digest.js`;
   `POST /api/cross-digest`; "Compare" multi-select mode + "Cross-digest (N)" + result modal
   in the Library UI.

## REMAINING (not started) — specs to resume with
Do these SEQUENTIALLY (each touches `server.js` and/or `public/index.html`). Each pass:
backend + UI + verify, reusing the toast system + error envelope. Then run a sentinel scan.

### 6. Markdown / Obsidian export
- `GET /api/saved/:videoId/export.md` (or similar) returning clean Markdown for one saved
  entry: title + source URL, the digest, notes, and highlights (with YouTube deep-links at
  each highlight's second), and optionally the full transcript. YAML frontmatter (title,
  url, tags, savedAt) so it drops straight into Obsidian/Notion.
- Frontend: a "Download .md" action on each saved card + in the detail view. Reuse existing
  download helpers (`downloadMd` exists).

### 7. Highlights clip reel
- A view that gathers all highlights (optionally across the whole library or per video) into
  a shareable list of deep-link "clips" — each is a YouTube URL at the exact second
  (`&t=<sec>s`) plus the highlighted text + any note. Copy-all / export.
- Highlights already carry text/offset; the deep-link pattern already exists in the
  timecoded transcript view. Mostly a new UI panel + maybe `GET /api/clips`.

### 8. Batch playlist digest
- Wire the existing playlist mode to the digest engine: given a playlist URL, fetch each
  video's transcript (`transcript.js`) and digest it (`generateDigest`), saving each into
  the library (`saveEntry`). Run as a background job with progress reporting (the videos may
  be many — stream progress via polling or SSE; reuse toast for status). Respect the 3-min
  per-call timeout; handle per-video failures without aborting the whole batch.
- Likely `POST /api/playlist/digest` (kick off) + `GET /api/playlist/digest/status`.

### 9. Browser bookmarklet / "send to Echo"
- A bookmarklet (and/or tiny extension) that, from a YouTube page, opens
  `http://localhost:8000/?v=<videoId>` (or posts the URL) so Echo auto-loads that video.
- Needs a small bit of `index.html` JS to read a `?v=`/`?url=` query param on load and
  auto-fetch the transcript. Ship the bookmarklet snippet in README + an `extension/` folder
  if doing the full extension.

### 10. Test suite
- Use `node:test` + `node:assert` (zero deps; add an `npm test` script). Make the store DB
  path overridable (e.g. `process.env.ECHO_DB_PATH`) so tests use a temp DB — this is a
  ~1-line change in `store.js`.
- Cover: store CRUD + tags/notes/highlights/favorite + `searchLibrary` + migration
  idempotency; digest pure helpers (`estimateTokens`, `chunkText`, `chunkSegments`,
  `mergeUsage`); API integration for `/api/saved`, error envelope on bad `/api/transcript`
  and `/api/digest`, and `/api/search` keyword mode. Boot the server on a custom port with a
  temp DB (may require adding `PORT` env support to `server.js`).

## How to run
- `node server.js` -> http://localhost:8000  (needs Node >= 22.5)
- Test URL for manual QA: `https://www.youtube.com/watch?v=GRzaq5AHiV8`
- Before calling any UI change "done": screenshot desktop + mobile, light + dark, and the
  digesting state.
