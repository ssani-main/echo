# Echo — Continuation / Handoff

**Status: OBSOLETE. All work merged. Several features mentioned below (semantic search, clips, notes, highlights, favorites) were removed 2026-07-06 — see PLAN.md.**

This file captures in-progress work on branch `feat/sqlite-and-features` so any future
session can resume with zero context loss. Delete it once all remaining tasks are merged.

## Big picture
A round of robustness + feature work on Echo (local YouTube transcript reader, `claude -p`
CLI for AI, no API key). Ten items were planned. **All ten are done and committed on this
branch** (`feat/sqlite-and-features`).

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
- **URL safety:** any external `url` must pass `safeHttpUrl()` (from `sanitize.js`) before
  being used as an href or written into an export. It is enforced both at save time (`store.js`)
  and at each render sink; reuse it rather than trusting stored `url` values.
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
6. **Markdown / Obsidian export** — `markdown.js` with `entryToMarkdown()` helper;
   `GET /api/saved/:videoId/export.md` (honors `?transcript=0` to skip full transcript);
   "Download .md" button on each saved card + detail view. YAML frontmatter for Obsidian.
   (commit `8f9e900`)
7. **Highlights clip reel** — `clips.js` with `buildClips()` and `resolveHighlightSecond()`
   helpers; `GET /api/clips` (optional `?videoId=` filter); "Clips" toolbar button + modal
   showing grouped deep-links with per-clip Copy, Copy all, and Export .md actions.
   (commit `f73aeb8`)
8. **Batch playlist digest** — `playlistJob.js` in-memory background job (sequential,
   per-video failure tolerant, fatal on CLAUDE_NOT_INSTALLED/AUTHED, prunes jobs >20);
   routes `POST /api/playlist/digest`, `GET /api/playlist/digest/status`,
   `POST /api/playlist/digest/cancel`; "Digest all" button on playlist panel + polling
   progress line; refreshes saved library on completion. (commit `ee66314`)
9. **Browser bookmarklet / send-to-Echo** — `autoLoadFromQuery()` reads `?v=<id>`/`?url=<url>`
   on load, populates input, clears query via `history.replaceState`, auto-fetches; README
   "Send to Echo" bookmarklet section + manual `/?v=`/`/?url=` usage documented.
   (commit `a339cb6`)
10. **Test suite** — `node:test` + `node:assert`, 53 tests (digest pure helpers, markdown
    export, clips, store CRUD/tags/notes/highlights/search, API error-envelope integration,
    URL sanitization); `npm test` script; added `process.env.ECHO_DB_PATH` (temp DB, skips legacy-JSON
    migration) and `process.env.PORT` hooks; guarded `app.listen` behind direct-run check
    and `export { app }`; bumped engines to Node >=22.5. (commit `6d0dae4`)

## Follow-ups / known gaps

Both previously-open gaps were resolved on 2026-07-02:

1. **Visual QA — DONE.** Ran an automated Playwright + Chromium screenshot pass (browsers used from the global install; NOT added to the repo's zero-dep package.json) against a seeded library on a local server. Captured desktop (1280×900) + mobile (390×844), light + dark: landing, query-param auto-load (`/?v=…`), Readable + Timecoded views, Saved library cards (tags/favorite/DIGEST badge/Notes/`.md`/Delete), Clips modal (Copy all / Export .md), and the playlist "Digest all" panel (loaded via a `watch?v=…&list=…` URL — 100-video playlist, "Digest all" button present). All flows render cleanly with good dark contrast, no mobile overflow, and ZERO console/page errors.

2. **Untrusted URL as href — FIXED.** New module `sanitize.js` exports `safeHttpUrl(raw)` (strips all whitespace via `/\s+/g` — defeating tab/newline scheme-splitting like `java<TAB>script:` — then allowlists only `/^https?:\/\//i`). Applied defense-in-depth: validated at WRITE time in `store.js` `saveEntry()` (sanitizes `url` before INSERT/UPDATE) AND at every render sink — saved-card link degrades to a non-clickable `<span>` when unsafe, `updateNowReading()` removes the href when unsafe, the ZIP-export markdown omits the `Source:` line when unsafe, and `markdown.js` (frontmatter, `**Source:**` link, and the `resolveWatchUrl()` fallback) all route through it. `clips.js` was refactored to reuse the same helper; `public/index.html` carries an inline copy. Verified by vishnu-sentinel-scan + vishnu-guard (both clean).

### Still open
- The playlist **"Digest all" happy path has still not been run end-to-end** (it spawns a real `claude` call per video; only the UI/panel and job lifecycle/error paths are exercised). Worth one real manual run.
- All work — the 10 items + the URL-protocol security fix — is committed AND pushed to `origin/main` (tip `63bad71`). This handoff doc is now **obsolete** and can be deleted; it is kept only for historical reference.

## How to run
- `node server.js` -> http://localhost:8000  (needs Node >= 22.5)
- `npm test` — runs 53 test cases via `node:test`; uses a temp DB via `process.env.ECHO_DB_PATH`
- Test URL for manual QA: `https://www.youtube.com/watch?v=GRzaq5AHiV8`
- Before calling any UI change "done": screenshot desktop + mobile, light + dark, and the
  digesting state.

---

**All work is merged into `main` and pushed to `origin/main` (`63bad71`). This file is safe to delete.**
