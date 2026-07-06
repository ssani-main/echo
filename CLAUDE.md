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

## Current direction & status (as of 2026-07-06)
Direction: **ship to others** — a hosted web BYOK app + a free desktop app, from one codebase. Done this session and on `main`:
- Web BYOK shell (onboarding, key validation, legal footer, `Dockerfile`/`.env.example`).
- Desktop BYOK mode (`ECHO_MODE=desktop`).
- Web-mode cost-sink hardening (`/api/usage` + `/api/playlist` gated; yt-dlp timeout; ccusage dedup).
- Fixed a Windows `spawn('*.cmd',{shell:false})` EINVAL crash in `usage.js` (see [`docs/memory/echo-windows-cmd-spawn-einval.md`](docs/memory/echo-windows-cmd-spawn-einval.md)).
- **Feature cut**: removed embeddings/semantic search (+ `@xenova/transformers`), clips, notes, favorites, and saved highlights (all 0-use). **Kept** FTS5 keyword search, digest/ask/enrich, tags, find-in-transcript, Discovery, export, and the map-reduce digest fallback.

**What's left (all external-dependency-blocked):**
- Deploy the web app → `fly deploy` (see [`DEPLOY.md`](DEPLOY.md); Fly builds the image remotely, no local Docker needed).
- Confirm a real BYOK digest on the live site (needs a real Anthropic key; the CLI path is already proven end-to-end).
- Ship desktop installers → needs Rust + MSVC toolchain + first `npm run tauri:build` (the `src-tauri/src/lib.rs` change is unverified until compiled).

## Gotchas worth knowing
- **Digest CLI isolation:** the `claude -p` digest subprocess must spawn with `cwd=tmpdir()` + an isolating `--system-prompt`, or it leaks this repo's own CLAUDE.md/memory into digests. See [`docs/memory/digest-cli-isolation.md`](docs/memory/digest-cli-isolation.md).
- **Windows `.cmd` spawns:** `spawn('*.cmd', args, {shell:false})` throws `EINVAL` synchronously on Windows (Node post-CVE-2024-27980). Use `shell:true` with a constant command string. yt-dlp is currently a real `.exe` here (unaffected); `claude` already routes via `cmd.exe /c`.
- **Tests miss runtime:** `node --test` doesn't spawn the real CLI or load the page under CSP. Before calling UI work done, drive a real digest + load the page (screenshots across light/dark/mobile). See [`docs/memory/echo-tests-miss-runtime.md`](docs/memory/echo-tests-miss-runtime.md) and [`docs/memory/visual-qa-before-ui-done.md`](docs/memory/visual-qa-before-ui-done.md).
- **Test video:** use `youtube.com/watch?v=GRzaq5AHiV8` for manual/E2E checks.

## Key docs
- [`DEPLOY.md`](DEPLOY.md) — Fly.io runbook (+ Railway note).
- [`DESKTOP.md`](DESKTOP.md) — Tauri desktop shell (build-blocked on toolchain).
- [`PLAN.md`](PLAN.md) — feature-cut plan (now completed).
- [`docs/memory/`](docs/memory/) — full accumulated context.
