# Echo — project context

Echo is a local-first "read YouTube instead of watching it" tool: **paste a YouTube link → get the transcript → AI digest → optionally save to a library**. Repo name is `echo` (the working dir is `yt_transcript`).

> **Continuity note:** the detailed, accumulated project memory lives in [`docs/memory/`](docs/memory/) — start with [`docs/memory/MEMORY.md`](docs/memory/MEMORY.md) (the index). Those files are a **snapshot** copied from the Claude Code per-user memory store so the context is portable across machines/workspaces. They may lag the very latest work; trust the code + git history when they disagree.

## Stack & how to run
- **Runtime:** Node **>=22.5** (uses the built-in `node:sqlite` — no native DB deps). ESM (`"type":"module"`).
- **Server:** `server.js` (Express, all routes). Binds `127.0.0.1:8000` by default; set `ECHO_HOST=0.0.0.0` to expose.
- **Frontend:** `public/index.html` — a single ~10k-line inline-everything monolith (HTML+CSS+JS, no build step). **The server caches index.html at boot** — restart the server to see frontend edits in dev.
- **AI:** goes through a provider seam (`providers.js`). Default = `ClaudeCliProvider` (shells the local `claude -p` CLI, keyless). `ApiKeyProvider` (Anthropic SDK) is used only when a per-request key is supplied (BYOK) or `ECHO_PROVIDER=api`.
- **Run:** `npm start` (local mode) · `npm test` (`node --test`) · `ECHO_MODE=web PORT=8080 node server.js` (hosted) · `ECHO_MODE=desktop node server.js`.

## The three modes (`ECHO_MODE`)
- **local** (default): local `claude` CLI, full server-side SQLite library, no limits. The dev/personal experience — **never break this** (hard constraint).
- **desktop**: like local + **optional BYOK** (a user without the CLI can add their own Anthropic key in Settings). Used by the Tauri shell.
- **web**: **BYOK required** (key per-request via `X-Echo-Api-Key`), library is client-side IndexedDB (server library routes are `blockInWeb` 503), per-IP rate limits + payload caps. Stateless — no server secrets/volume needed.

## Current direction & status (as of 2026-07-07)
Direction: **ship to others** — a hosted web BYOK app + a free desktop app, from one codebase. Done across prior sessions + this session on `main`:
- Web BYOK shell (onboarding, key validation, legal footer, `Dockerfile`/`.env.example`).
- Desktop BYOK mode (`ECHO_MODE=desktop`).
- Web-mode cost-sink hardening (`/api/usage` + `/api/playlist` gated; yt-dlp timeout; ccusage dedup).
- Fixed a Windows `spawn('*.cmd',{shell:false})` EINVAL crash in `usage.js` (see [`docs/memory/echo-windows-cmd-spawn-einval.md`](docs/memory/echo-windows-cmd-spawn-einval.md)).
- Security/correctness hardening pass: resolveHref XSS scheme filter + /api/languages input validation + parallelized map-reduce + prompt-input sanitization + playlistJob rejection guard. Tests 154/154 green.
- **Feature cut**: removed embeddings/semantic search (+ `@xenova/transformers`), clips, notes, favorites, and saved highlights (all 0-use). **Kept** FTS5 keyword search, digest/ask/enrich, tags, find-in-transcript, Discovery, export, and the map-reduce digest fallback.
- **Desktop installers build (Linux)**: fixed the Tauri bundle (stale `embeddings.js`/`clips.js` refs, missing `websearch.js`/`discovery.js`/`usagelog.js`, dev-`node_modules` musl leak) so `npm run tauri:build` produces AppImage/`.deb`/`.rpm`; `lib.rs` compiles (`cargo check`, Rust 1.95) and the bundled backend drives a real transcript+digest end-to-end. Added `tests/tauri-bundle.test.js` as a drift guard. Tests 157/157 green.
- **Roadmap features shipped (2026-07-07):** A1 (multi-paste queue + `startBatchDigest` + `/api/batch/digest`), C2 (auto-tagging via dedicated `/api/tags/suggest`), C1 (ask-across-library RAG + `buildLibraryFtsQuery()` FTS5 OR-of-quoted-terms), B1 (vault.js markdown sync + `/api/vault/sync`), A2 (channel following: one-click Follow everywhere — Discovery cards, loaded videos, saved entries with self-heal channelUrl backfill; Inbox is paginated full-catalog card-grid browser; local/desktop-only). B2 (TTS read-aloud) intentionally dropped by user request. All tests pass 218/218, security-scanned, runtime-verified on dev tree.

**What's left (all external-dependency-blocked):**
- Deploy the web app → `fly deploy` (see [`DEPLOY.md`](DEPLOY.md); Fly builds the image remotely, no local Docker needed).
- Confirm a real BYOK digest on the live site (needs a real Anthropic key; the CLI path is already proven end-to-end).
- Ship desktop installers → **Linux done** (`npm run tauri:build` → AppImage/`.deb`/`.rpm`, verified 2026-07-06 on Arch). Remaining: macOS/Windows installers (need those toolchains) + code-signing/notarization for distribution.

## Gotchas worth knowing
- **Digest CLI isolation:** the `claude -p` digest subprocess must spawn with `cwd=tmpdir()` + an isolating `--system-prompt`, or it leaks this repo's own CLAUDE.md/memory into digests. See [`docs/memory/digest-cli-isolation.md`](docs/memory/digest-cli-isolation.md).
- **Windows `.cmd` spawns:** `spawn('*.cmd', args, {shell:false})` throws `EINVAL` synchronously on Windows (Node post-CVE-2024-27980). Use `shell:true` with a constant command string. yt-dlp is currently a real `.exe` here (unaffected); `claude` already routes via `cmd.exe /c`.
- **URL scheme filtering by host is unsafe:** `new URL('javascript:alert(1)').host === ''` (empty string), so host-based filters like `host.includes('duckduckgo.com')` pass `javascript:`/`file:`/`data:` URLs through. Always validate scheme with `/^https?:\/\//i` before using a URL. See [`docs/memory/echo-url-scheme-host-empty.md`](docs/memory/echo-url-scheme-host-empty.md) and `websearch.js` `resolveHref()`.
- **Tests miss runtime:** `node --test` doesn't spawn the real CLI or load the page under CSP. Before calling UI work done, drive a real digest + load the page (screenshots across light/dark/mobile). See [`docs/memory/echo-tests-miss-runtime.md`](docs/memory/echo-tests-miss-runtime.md) and [`docs/memory/visual-qa-before-ui-done.md`](docs/memory/visual-qa-before-ui-done.md).
- **Natural-language → FTS5 query:** raw questions passed to SQLite MATCH operator AND all tokens, so questions with stopwords return zero rows. Use `store.js` `buildLibraryFtsQuery()` to convert to OR-of-quoted-terms (e.g., "what is machine learning" → `("machine" OR "learning")` in MATCH syntax). C1's ask-library found this via live testing.
- **Test video:** use `youtube.com/watch?v=GRzaq5AHiV8` for manual/E2E checks.
- **Tauri bundle drift:** `tauri.conf.json` `bundle.resources` lists backend `.js` files individually — a new backend module (or a new `./x.js` import) that isn't added there crashes the desktop sidecar at runtime with `ERR_MODULE_NOT_FOUND`, and `node --test` / the `.deb`/`.rpm` bundlers never catch it (they don't start the backend). `tests/tauri-bundle.test.js` guards this. AppImage bundling also needs a production-only `node_modules` + `NO_STRIP=1` + `APPIMAGE_EXTRACT_AND_RUN=1`, all handled by `npm run tauri:build` (see [`DESKTOP.md`](DESKTOP.md)).
- **Old saved entries predate channel metadata:** Entries saved before A2 shipped lack `channelUrl`. Opening one triggers `GET /api/video-meta` (oEmbed, keyless, non-blocking) to back-fill the channel, revealing the one-click Follow button. Best-effort with navigation-race guard. Channel listings cannot pre-filter by transcript availability (YouTube doesn't expose it), so the Inbox card-grid shows all uploads; videos without transcripts fall back to the existing "no transcript" message on open.

## Key docs
- [`DEPLOY.md`](DEPLOY.md) — Fly.io runbook (+ Railway note).
- [`DESKTOP.md`](DESKTOP.md) — Tauri desktop shell (Linux installers build; macOS/Windows + signing pending).
- [`PLAN.md`](PLAN.md) — feature-cut plan (now completed).
- [`docs/memory/`](docs/memory/) — full accumulated context.
