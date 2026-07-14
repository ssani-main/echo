# Echo — project context

Echo is a local-first "read YouTube instead of watching it" tool: **paste a YouTube link → get the transcript → AI digest → optionally save to a library**. Repo name is `echo` (the working dir is `yt_transcript`).

> **Continuity note:** detailed accumulated project memory is kept in a **private local store outside this repo** (not published). This file, the code, and git history are the public source of truth; when they disagree, trust the code + git history.

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

## Where things stand
Direction: **ship to others** — a hosted web BYOK app + a free desktop app, from one codebase. UI is the dark-first "Signal" theme (waveform brand mark, ambient background that blooms while digesting). The frontend is fully tokenized — type / spacing / `--radius-*` / `--z-*` (named z-index layers) / `--dur-*` (transition durations) scales in `:root`; **edit via tokens, not literals.** Design review is done with the `hallmark` skill (`hallmark audit <files>`); Echo passed a full audit on 2026-07-14 (no gradient-clip headlines, CSP-safe font stacks — see the CSP-fonts gotcha, left-biased hero). Detailed session-by-session history lives in git + the private memory store; this section is the durable current-state snapshot.

**Current feature set (the core loop is `paste → transcript → digest → library`):**
- **Digest** (`digest.js`) — synthesized AI digest, the product's differentiator. Map-reduce fallback for long transcripts. Auto-tagging is folded into the digest pass (`/api/digest` runs `generateDigest` + `suggestTags` concurrently, tags best-effort with a timeout that can't reject → `suggestedTags[]`; applied at save). Optional **"Include visuals"** frame-augmented digest (`frames.js`, **local/desktop only**, needs ffmpeg — see [`FRAMES.md`](FRAMES.md)).
- **Library** — server SQLite (`store.js`) in local/desktop; client IndexedDB in web. FTS5 keyword search, tags, find-in-transcript, export.
- **Enrich** — ephemeral floating popover over selected digest text (Verify / Explain / Background) via `/api/enrich`. Verify-claims ledger (`extractClaims`/`verifyClaims` in `digest.js`, `/api/claims`).
- **Discovery + channel following** — in-app YouTube search/browse (`discovery.js`, keyless via yt-dlp) + one-click Follow → paginated Inbox card-grid. **local/desktop only.**
- **Share** — standalone HTML digest pages (`sharepage.js`, `GET /s/:id`, unguessable id). **local/desktop only** (web is stateless).
- **Vault sync** — write the library into an Obsidian vault: server typed-path (`vault.js` + `/api/vault/sync`) and a client folder-picker (File System Access API, all modes). Notes filed into `YYYY-MM/` month folders + an `Echo Library.md` dashboard index note + `summary:` frontmatter. Per-note `obsidian://new` deep-link in web. See [[echo-vault-index-note]].

**Web-mode gating** (`blockInWeb` — code intact for local/desktop): server library routes, `/api/claims`, `/api/cross-digest`, `/api/playlist*`, and `/api/enrich mode:'factcheck'` all 503/reject in web; the Verify button is hidden.

**Removed features — don't go looking for these** (cut as 0-use or out-of-scope): embeddings/semantic search (`@xenova/transformers`), clips, notes, favorites, saved highlights, the **Ask** feature (`/api/chat`), ask-across-library (`/api/library/ask`, `buildLibraryFtsQuery`), batch/multi-paste (`/api/batch/digest`), and ccusage cost-display (`usage.js`, `/api/usage`). TTS read-aloud was intentionally dropped.

**Module map:** `server.js` (all Express routes) · `providers.js` (CLI/API provider seam) · `transcript.js` · `digest.js` · `frames.js` · `store.js` (SQLite) · `markdown.js` (export + `buildVaultIndex`/`extractSummary`) · `vault.js` · `sharepage.js` · `websearch.js` (`resolveHref`) · `discovery.js` · `playlistJob.js` · `sanitize.js` · `usagelog.js` + `usage_stats.mjs` (local JSONL action meter) · `tools/ai-tell/` (AI-writing eval, `npm run digest:aitell`).

**What's left (all external-dependency-blocked):**
- Deploy the web app → `fly deploy` ([`DEPLOY.md`](DEPLOY.md); Fly builds the image remotely, no local Docker).
- Confirm a real BYOK digest on the live site (needs a real Anthropic key; the CLI path is proven E2E).
- Desktop installers → **Linux done** (`npm run tauri:build` → AppImage/`.deb`/`.rpm`). Remaining: macOS/Windows installers + code-signing/notarization.
- **Phase-2 backlog** (deferred, not built): web share via a TTL'd store; accounts + paid server-saved library; a YouTube-OAuth subscriptions feed.

## Gotchas worth knowing
- **Removing a route? Grep the frontend for indirect callers, not just the literal path.** When cutting `/api/chat`, an initial scout reported "no frontend caller" and the route was deleted — but the Ask tab called it via an `aiFetch('/api/chat', …)` wrapper, leaving a 404-on-click P0. A `vishnu-sentinel-scan` after the fact caught it. Always: after removing an endpoint, integration-scan for the endpoint string AND for wrapper helpers (`aiFetch`/`apiFetch`) before calling it done.
- **Digest CLI isolation:** the `claude -p` digest subprocess must spawn with `cwd=tmpdir()` + an isolating `--system-prompt`, or it leaks this repo's own CLAUDE.md/memory into digests.
- **Windows `.cmd` spawns:** `spawn('*.cmd', args, {shell:false})` throws `EINVAL` synchronously on Windows (Node post-CVE-2024-27980). Use `shell:true` with a constant command string. yt-dlp is currently a real `.exe` here (unaffected); `claude` already routes via `cmd.exe /c`.
- **URL scheme filtering by host is unsafe:** `new URL('javascript:alert(1)').host === ''` (empty string), so host-based filters like `host.includes('duckduckgo.com')` pass `javascript:`/`file:`/`data:` URLs through. Always validate scheme with `/^https?:\/\//i` before using a URL. See `websearch.js` `resolveHref()`.
- **Tests miss runtime:** `node --test` doesn't spawn the real CLI or load the page under CSP. Before calling UI work done, drive a real digest + load the page (screenshots across light/dark/mobile).
- **Natural-language → FTS5 query:** raw questions passed to SQLite MATCH operator AND all tokens, so questions with stopwords return zero rows — if a future feature needs NL-question retrieval over the FTS5 store, strip stopwords and OR-join quoted tokens (e.g., "what is machine learning" → `("machine" OR "learning")` in MATCH syntax) rather than passing the raw question. (Previously lived in `store.js` as `buildLibraryFtsQuery()`, removed with the C1 ask-across-library feature cut.)
- **Test video:** use `youtube.com/watch?v=GRzaq5AHiV8` for manual/E2E checks.
- **Tauri bundle drift:** `tauri.conf.json` `bundle.resources` lists backend `.js` files individually — a new backend module (or a new `./x.js` import) that isn't added there crashes the desktop sidecar at runtime with `ERR_MODULE_NOT_FOUND`, and `node --test` / the `.deb`/`.rpm` bundlers never catch it (they don't start the backend). `tests/tauri-bundle.test.js` guards this. AppImage bundling also needs a production-only `node_modules` + `NO_STRIP=1` + `APPIMAGE_EXTRACT_AND_RUN=1`, all handled by `npm run tauri:build` (see [`DESKTOP.md`](DESKTOP.md)).
- **Old saved entries predate channel metadata:** Entries saved before A2 shipped lack `channelUrl`. Opening one triggers `GET /api/video-meta` (oEmbed, keyless, non-blocking) to back-fill the channel, revealing the one-click Follow button. Best-effort with navigation-race guard. Channel listings cannot pre-filter by transcript availability (YouTube doesn't expose it), so the Inbox card-grid shows all uploads; videos without transcripts fall back to the existing "no transcript" message on open.
- **Vendoring CommonJS into ESM:** importing a bare CommonJS third-party file (e.g., `module.exports`) into this ESM repo (`"type":"module"`) silently yields an empty namespace — `analyzeText()` becomes `undefined` with no error. Fix: create a scoped `package.json` in the vendor dir with `{"type":"commonjs"}` so files load as CJS, then import via `createRequire`. Don't touch the root `package.json` type. See `tools/ai-tell/` and [[echo-digest-ai-tell-eval]].
- **Self-contained CSP pages cannot load external fonts:** referencing web-font family names (e.g. 'Space Grotesk', 'Inter', 'JetBrains Mono') without an inline `@font-face` silently falls back to system fonts and looks generic. Use deliberate system font stacks (e.g. `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`). See `sharepage.js` and [[echo-share-and-claims]].
- **File System Access API is Chromium-only + gated:** `window.showDirectoryPicker()` (used by web vault folder-sync) exists only in Chromium (Chrome/Edge, **not** Firefox/Safari), needs a **secure context** (https or localhost) and a **user gesture** (call it from a click handler — `requestPermission` also needs the gesture, so chain it off the same click). `FileSystemDirectoryHandle`s are **not** serializable to localStorage — persist them in **IndexedDB**. Always feature-detect (`'showDirectoryPicker' in window`) and fall back (Echo falls back to the ZIP export). Headless browsers usually lack the API, so a real E2E folder-write can't be automated — verify everything up to the native picker.
- **`obsidian://new` URI length ceiling:** deep-linking a note into Obsidian via `window.location.href = 'obsidian://new?…&content=…'` fails silently past the OS protocol-handler limit (well under a full transcript on Windows). Send **digest-only** markdown and guard the final URI length (Echo declines >8000 chars, pointing the user to folder-sync/ZIP). Custom-scheme navigation is **not** blocked by this app's CSP — `default-src` doesn't govern navigation and there's no `navigate-to`/`form-action` directive.
- **CSS comments in server-rendered HTML leak to output:** a literal `/* Key claims ... */` comment in a template string gets emitted into the HTML output. Tripped a test like `!output.includes('Key claims')`. Keep comment text generic or use variable names when rendering HTML server-side.

## Key docs
- [`DEPLOY.md`](DEPLOY.md) — Fly.io runbook (+ Railway note).
- [`DESKTOP.md`](DESKTOP.md) — Tauri desktop shell (Linux installers build; macOS/Windows + signing pending).
- [`PLAN.md`](PLAN.md) — feature-cut plan (now completed).
- [`FRAMES.md`](FRAMES.md) — frame-augmented digest (P1+P2 **shipped**): feed on-screen frames into the digest.
- [`P3.md`](P3.md) — proposed next step for frames: transcript↔frame alignment (anchored-slide selection; research-grade, gated on an experiment).
- [`WHISPER.md`](WHISPER.md) — proposed Whisper transcription fallback (not built; fixes bad/missing captions).
