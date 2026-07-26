<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/echo-logo-dark.png">
  <img alt="Echo" src="public/echo-logo-light.png" width="210">
</picture>

### Paste a YouTube link. Read what was actually said.

Echo pulls the transcript out of a video, reflows the two-second caption fragments
into paragraphs you'd actually read, and hands it to AI for a digest.
Runs on your machine. No API key needed.

![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-3c873a?style=flat-square&logo=node.js&logoColor=white)
![Runs locally](https://img.shields.io/badge/runs-100%25%20local-0B6B4F?style=flat-square)
![No API key](https://img.shields.io/badge/AI%20digest-no%20API%20key%20needed-0B6B4F?style=flat-square)
![No build step](https://img.shields.io/badge/build%20step-none-0B6B4F?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-16181D?style=flat-square)

</div>

---

## Quickstart

```bash
git clone https://github.com/ssani-main/echo.git
cd echo
npm install
npm start
```

Open **http://localhost:8000**, paste a link. That's it — the transcript loads the
moment a valid URL hits the field.

**Node ≥ 22.5** is the only hard requirement (Echo uses the built-in `node:sqlite`,
so there is nothing to compile). Three optional extras, each unlocking one thing:

| Install | Unlocks |
|---|---|
| [Claude Code](https://claude.com/claude-code) | the AI digest, using your existing login — **no API key, no billing setup** |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | the caption-fetch fallback when YouTube shifts its internals |
| [ffmpeg](https://ffmpeg.org/) | Whisper transcription for videos with no captions, and local audio/video files |

> On Windows PowerShell, if `npm start` trips the execution policy, use `npm.cmd start`.

---

## What it does

```
   paste a link
        │
        ▼
   fetch captions ─────────► youtube-transcript → yt-dlp → Whisper
        │
        ▼
   reflow into paragraphs ──► sentence- and pause-aware, not fixed-width
        │
        ▼
   AI digest ──────────────► streams as it is written
        │
        ▼
   save to your library ───► searchable, taggable, exportable
```

Four things carry the product, and everything else is in service of them.

**Readable transcripts.** YouTube has the captions; it just chops them into
fragments and hides them behind the player. Echo glues them back into sentences and
paragraphs. Toggle to **Timecoded** for a subtitle-editor view where every timestamp
deep-links back into the video. Find-in-transcript with a live match count, and the
header states the trade you came for: `~26m watch · 23 min read`.

**A digest, not a summary.** Three levels of fidelity, from a TL;DR to a rewrite that
drops nothing but the noise of speech. It streams, so you start reading in about a
second. See [below](#the-digest).

**A library that stays yours.** Save a video and it's searchable full-text (SQLite
FTS5 over transcripts *and* digests), taggable with AI-suggested tags, and exportable
as Markdown — or synced straight into an Obsidian vault. It lives in `data/library.db`,
gitignored, on your disk.

**Whisper when there are no captions.** Local speech-to-text via whisper.cpp fills the
dead end, either as a **Fallback** (only when captions are missing) or **High-accuracy**
(always). Off by default; the binary ships with Echo on Linux x64 and Windows x64. It
also means Echo reads things that were never on YouTube — a podcast download, a lecture
recording, a meeting capture.

<details>
<summary><b>Everything else it does</b></summary>

- **Paste-to-fetch** — no button; a valid URL in the field starts the fetch. Accepts
  `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, or a bare video ID.
- **Reading controls** — font size (A−/A+) and column width (Narrow / Medium / Wide,
  ~620 / 760 / 940px). One control for both lenses, one saved preference.
- **Session restore** — refresh and the transcript, digest, view mode and lens all
  come back from sessionStorage. No re-fetch.
- **Plain-language failures** — a scheduled premiere, a live stream, a private or
  age-restricted or region-blocked video, a datacenter IP bot-block, or genuinely no
  captions: Echo names which one, with the raw error one click away under *Show
  technical details*.
- **Keyboard** — `?` for the overlay, `/` to search, `1` / `2` for the Transcript and
  Digest lenses, `3` for the Library, `t` for dark mode, `Esc` to close. All paused
  while you're typing.
- **Light and dark** — the "Plaintext" theme: one system monospace family, no
  webfonts, no accent hue, hierarchy carried by weight rather than size. Respects
  `prefers-reduced-motion`.
- **Nothing from a third party** — the CSP allows no inline script, no inline style,
  and no external script, style or font origin. JSZip is vendored. The only outbound
  requests are YouTube's thumbnails.
- **Accounts and cross-device sync** _(hosted, optional)_ — Google sign-in so a
  library follows a visitor between devices. Off unless the operator sets three env
  vars, and it never changes where an API key lives.

</details>

---

## The digest

**No Anthropic API key and no billing setup** when running locally: Echo shells out to
your installed [Claude Code](https://claude.com/claude-code) CLI in headless mode and
reuses your existing login and quota.

One dial, ordered by how much of the video survives:

| | What you get |
|---|---|
| **Gist** | A short TL;DR plus the key takeaways. |
| **Digest** _(default)_ | The real substance, reorganised by idea rather than in the order it was said. Not a summary of what the video "covers" — the point itself. |
| **Everything** | A full-fidelity rewrite you read *instead of* watching. Nothing substantive is dropped, only the noise of speech. |

Pick an output language too. Transcripts past ~120k tokens are chunked, digested in
parallel and synthesised in a final pass automatically — while that happens the pane
reports which part it is reading, because no digest text exists yet.

The digest **streams** — text appears as the model writes it. If streaming is
unavailable for any reason Echo falls back to the single-response call it used before,
so the worst case is the wait you already had.

Prompts live in [`digest.js`](./digest.js). Change the tone, the model, the whole
approach.

---

## Ways to run it

### Local — the default

```bash
npm start
```

Your machine, your browser, your Claude CLI. No environment configuration at all.
**This is the way Echo is meant to be run**, and the one that never breaks.

### Public tunnel — share your local Echo

```bash
npm run serve:public
```

Hosting Echo on a VPS **does not work**: transcript fetches happen server-side and
YouTube bot-blocks datacenter IP ranges outright. A residential connection doesn't
have that problem — so rather than deploy, run Echo where you already are and tunnel
it out. Verified end to end: a video that failed on a VPS returned 1077 caption
segments through the tunnel.

One command starts Echo, opens a [Holesail](https://holesail.io) tunnel through a
[Janus](https://janus.ssani.dev) gateway, and prints a stable public URL. The key is
derived from a seed at `.holesail-seed` (created on first run, gitignored, mode `0600`)
so the URL survives restarts. **That file is a secret** — it is the serving capability
for the tunnel. `--attach` tunnels an Echo you already started; `-- --help` lists every
flag. Requires a running Janus gateway (a separate project).

> **This makes Echo reachable by anyone with the link.** In `local` mode that means
> anyone with the URL can spend your Claude quota and read or write your library.
> Set a per-key password in the Janus dashboard, or run with `ECHO_MODE=web` so
> visitors bring their own key and the server-side library routes switch off.

### Hosted web — bring your own key

```bash
ECHO_MODE=web PORT=8080 node server.js
```

Stateless and multi-visitor. Each visitor supplies their own Anthropic key in Settings
(validated on save, kept in their browser's localStorage, sent per-request as
`X-Echo-Api-Key`, **never stored server-side**) and gets a library in their own
IndexedDB. Server-side library routes and Whisper return 503; there are per-IP rate
limits and payload caps; nothing is persisted, so there is no volume to provision.

Add `ECHO_GOOGLE_CLIENT_ID`, `ECHO_GOOGLE_CLIENT_SECRET` and `ECHO_SESSION_SECRET` to
offer **Sign in with Google** and cross-device library sync — two tables, no passwords,
no sessions table, and no API keys. Leave them unset and none of it exists: no sign-in
UI, no database, no volume. See [`DEPLOY.md`](DEPLOY.md).

### Desktop app

A native window running the same Node backend as a sidecar, via Tauri v2. Linux
installers (AppImage / `.deb` / `.rpm`) build today; see [`DESKTOP.md`](DESKTOP.md).

### Docker

```bash
cp .env.example .env
docker build -t echo .
docker run -p 8080:8080 echo
```

Runs web mode on `0.0.0.0:8080` behind a reverse proxy, with yt-dlp preinstalled and a
`HEALTHCHECK` on `/api/health`. Self-hosting on your own box is covered in
[`VPS.md`](VPS.md) — including why transcripts won't work from a datacenter.

---

## Companions

Both talk to a running Echo over HTTP. **Neither holds an API key or does any AI of its
own** — that stays in Echo, so there is one implementation of the part that matters.

**Browser extension** ([`extension/`](extension/)) — a **Read in Echo** button on
YouTube watch pages, a toolbar button, and a right-click item for links. It also tries
to fetch the transcript on *your* tab, with your IP and session, and hand it to Echo in
the URL fragment — which sidesteps the datacenter bot-block; if that fails, the server
fetches as before. Chromium only: Firefox needs `background.scripts` rather than an MV3
service worker. Load unpacked from `chrome://extensions` → Developer mode.

**Obsidian plugin** ([`obsidian-plugin/`](obsidian-plugin/)) — two commands, and a note
lands in your vault with the transcript, the digest and frontmatter. Filename and format
match `/api/vault/sync` exactly, so a vault fed by both the plugin and folder-sync gets
one consistent set of notes.

> Two caveats worth stating plainly: the extension's own scrape path has **not** been
> confirmed against a real signed-in browser (headless Chrome can't verify it — see
> [`CLAUDE.md`](CLAUDE.md)), and the Obsidian plugin has **not** yet been run inside
> Obsidian by its author. The logic is tested; the app integration is not.

---

## Reference

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Server port |
| `ECHO_HOST` | `127.0.0.1` | Interface to bind. Localhost-only by default; `0.0.0.0` to expose |
| `ECHO_MODE` | `local` | `local` (Claude CLI), `desktop` (CLI + optional BYOK), `web` (visitor keys) |
| `ECHO_PROVIDER` | _(CLI)_ | `api` to use the Anthropic API instead of the CLI |
| `ANTHROPIC_API_KEY` | _(unset)_ | Key used when no per-request key is supplied |
| `ECHO_DB_PATH` | `data/library.db` | SQLite library path (local/desktop) |
| `ECHO_VAULT_DIR` | _(unset)_ | Default Obsidian vault folder for `/api/vault/sync` |
| `ECHO_MAX_TRANSCRIPT_CHARS` | `200000` | Web-mode transcript cap |
| `ECHO_MAX_AI_PAYLOAD_CHARS` | `200000` | Web-mode AI payload cap |
| `ECHO_YTDLP_JS_RUNTIME` | `node` | JS runtime for yt-dlp; empty string omits the flag (older yt-dlp) |
| `ECHO_WHISPER_DEFAULT_MODEL` | `base` | `base` or `small` |
| `ECHO_WHISPER_THREADS` | _(75% of cores)_ | Lower it to keep the machine responsive |
| `ECHO_WHISPER_MAX_MINUTES` | `180` | Reject audio longer than this |
| `ECHO_WHISPER_VAD_MODEL` | _(unset)_ | Silero VAD model path — skips non-speech. Opt-in, see [`WHISPER.md`](./WHISPER.md) |
| `ECHO_GOOGLE_CLIENT_ID` | _(unset)_ | With the two below, enables accounts + sync. Unset = no accounts, no database |
| `ECHO_GOOGLE_CLIENT_SECRET` | _(unset)_ | Google OAuth client secret |
| `ECHO_SESSION_SECRET` | _(unset)_ | Signs session cookies. Changing it signs everyone out |
| `ECHO_PUBLIC_URL` | _(request origin)_ | Public origin, used to build the OAuth redirect URI |
| `ECHO_SYNC_DB_PATH` | `/data/echo-sync.db` | Accounts + synced libraries — the only server-side state |
| `ECHO_MAX_SYNC_BYTES` | `100000000` | Per-account synced-library size cap |

[`.env.example`](./.env.example) documents the common ones in more detail.

</details>

<details>
<summary><b>HTTP API</b></summary>

| Method | Route | Body | Returns |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ status, mode }` |
| `POST` | `/api/validate-key` | _(key in `X-Echo-Api-Key`)_ | `{ valid }` or an error envelope (web/desktop) |
| `POST` | `/api/transcript` | `{ url, lang?, transcribe?, whisperModel?, jobId? }` | `{ videoId, url, title, channel, channelUrl, segments, langCode, transcriptSource }` |
| `POST` | `/api/transcript/file` | raw bytes, `?name=&jobId=` | same envelope, for a local file (local/desktop) |
| `GET` | `/api/transcript/progress` | `?jobId=` | SSE — live Whisper progress |
| `GET` | `/api/whisper/status` | — | `{ binaryPresent, defaultModel, cacheDir, models }` (local/desktop) |
| `POST` | `/api/whisper/model` | `{ model }` | download state for that model (local/desktop) |
| `GET` | `/api/languages` | `?videoId=` | `{ tracks: [{ code, name, auto }] }` |
| `GET` | `/api/video-meta` | `?videoId=` | `{ videoId, title, channel, channelUrl }` |
| `POST` | `/api/digest` | `{ text, format?, language?, title?, videoId? }` | `{ digest, usage, strategy, suggestedTags }` |
| `POST` | `/api/digest?stream=1` | _(same)_ | `text/event-stream` — `phase` / `token` / `done` / `error`; `done` carries the payload above |
| `GET` | `/api/saved` | — | every saved entry's metadata |
| `GET` | `/api/saved?limit=&offset=` | — | `{ entries, total, hasMore }` |
| `GET` | `/api/saved/export` | — | `{ entries: [ ...full entries... ] }` |
| `GET` | `/api/saved/:videoId` | — | one full entry |
| `GET` | `/api/saved/:videoId/export.md` | — | Markdown export |
| `POST` | `/api/saved` | `{ url, videoId, title, segments, digest, tags? }` | saved metadata (upsert by `videoId`) |
| `DELETE` | `/api/saved/:videoId` | — | `{ ok }` |
| `PATCH` | `/api/saved/:videoId/tags` | `{ tags }` | updated entry |
| `GET` | `/api/search` | `?q=` | FTS5 keyword search (local/desktop) |
| `POST` | `/api/vault/sync` | `{ dir?, includeTranscript? }` | `{ dir, total, written, unchanged, failed, index }` (local/desktop) |
| `GET` | `/api/auth/me` | — | `{ enabled, user }` |
| `GET` | `/api/auth/google` · `/api/auth/callback` | — | Google sign-in redirect chain (accounts only) |
| `POST` | `/api/auth/logout` · `/api/auth/signout-everywhere` | — | end this session, or every session |
| `DELETE` | `/api/auth/account` | — | delete the account and its synced library |
| `GET` | `/api/sync/pull` | `?since=` | entries changed since a timestamp, incl. tombstones |
| `POST` | `/api/sync/push` | `{ entries }` | `{ applied, skipped, serverTime }` — last write wins |

Web mode returns 503 for every library, search, vault and Whisper route.

</details>

<details>
<summary><b>Project layout</b></summary>

```
echo/
├── server.js         # Express: every route, and serves the UI
├── transcript.js     # video-ID parsing, caption fetch, failure classification
├── whisper.js        # local whisper.cpp speech-to-text (local/desktop)
├── whisperModel.js   # model registry + on-demand download/cache
├── digest.js         # digest generation (incl. map-reduce) + auto-tagging
├── providers.js      # provider seam: local `claude` CLI vs Anthropic API
├── common/text.js    # shared with the page, the extension AND the plugin
├── store.js          # SQLite library (local/desktop); web uses IndexedDB
├── auth.js           # Google sign-in, stateless signed-cookie sessions
├── syncStore.js      # accounts + synced libraries
├── markdown.js       # Markdown export + Obsidian index note
├── vault.js          # Obsidian vault folder sync
├── public/
│   ├── index.html    # markup only
│   ├── app.css       # the Plaintext theme, fully tokenised
│   ├── app.js        # the whole client — a classic script, no build step
│   └── vendor/       # JSZip, vendored — no CDN, no external origin
├── extension/        # Chrome MV3 extension
├── obsidian-plugin/  # a vault note per video
├── vendor/whisper/   # prebuilt whisper-cli (linux-x64, win32-x64)
├── tools/            # public tunnel, digest evals, vendoring helpers
└── data/library.db   # gitignored — your library never leaves the machine
```

</details>

<details>
<summary><b>Send to Echo (bookmarklet)</b></summary>

The [extension](extension/) does this better — a real button, and it follows YouTube's
in-app navigation. The bookmarklet stays for browsers where an extension isn't an option.

```
javascript:(function(){var u=location.href;var m=u.match(/[?&]v=([\w-]{11})/)||u.match(/youtu\.be\/([\w-]{11})/)||u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);var t=m?('http://localhost:8000/?v='+m[1]):('http://localhost:8000/?url='+encodeURIComponent(u));window.open(t,'_blank');})();
```

Most browsers block dragging a code block into the bookmarks bar, so create a bookmark
manually and paste the code into its URL field. Or just open
`http://localhost:8000/?v=VIDEO_ID` directly.

</details>

---

## Development

```bash
npm test                  # 511 tests, no dependencies, ~4s
npm run test:page         # renders the real page in Chrome and asserts layout invariants
npm run digest:fidelity   # how faithfully digests carry the transcript's specifics
npm run digest:aitell     # score digests for AI-writing tells
```

Two harnesses need Playwright, which is deliberately **not** a dependency:

```bash
npm i --no-save playwright && npx playwright install chromium
node tests/e2e/oauth-flow.mjs    # the whole Google sign-in flow, against a mock provider
node extension/test/e2e.mjs      # the extension in a real browser, incl. SPA navigation
```

CI runs the suite plus a boot job checking that every module parses and the server
starts in all three modes.

**Three things to know before changing the frontend.**

1. **Restart the server.** `index.html`, `app.css` and `app.js` are read and compressed
   at boot. Editing without restarting shows you the old page and sends you chasing a
   bug you already fixed.
2. **The CSP forbids inline everything** — `<script>`, `<style>`, `style=""` and event
   handler attributes like `onerror=`. All fail *silently* in a browser and are
   invisible to `node --test`. Put code in `app.js`, CSS in `app.css`, and use a class
   or a real listener. Not theoretical: two thumbnail fallbacks used `onerror=""` and
   had quietly not worked for months.
3. **A screenshot is not proof.** Headless Chrome reports `hover: none`, matches neither
   `pointer: fine` nor `pointer: coarse`, and never loads `loading="lazy"` images below
   the fold — so hover styles, touch sizing and thumbnails all look broken when they
   aren't. [`CLAUDE.md`](CLAUDE.md) collects these traps; read it before trusting an
   instrument.

**And one about the library.** Anything touching "the whole library" needs bounding, and
ten test entries will never show you the problem — seven bugs of that shape have been
found so far, every one with a green suite. **Seed a few hundred entries before
believing a library-wide path is fine.** The list renders a window at a time with
delegated listeners, so never add a per-card `addEventListener` in the render path.

---

## Built with

**Node.js** · **Express** · **`node:sqlite`** ·
[youtube-transcript](https://www.npmjs.com/package/youtube-transcript) ·
[yt-dlp](https://github.com/yt-dlp/yt-dlp) ·
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) ·
[Claude Code](https://claude.com/claude-code) ·
[Tauri](https://tauri.app/) · plain HTML/CSS/JS on a system monospace stack — no
webfonts, no build step

## License

[MIT](LICENSE) © 2026 ssani-main.

---

<div align="center">

_Made for reading, not scrubbing._

</div>
