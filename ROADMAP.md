# Echo — Feature Roadmap & Bun Evaluation

> Drafted 2026-07-06. This is a **continue-tomorrow** working plan, not a spec set in stone.
> Directions chosen: **ingestion**, **interop/export**, **library-as-knowledge-base**.
> Hard constraint: every feature must work (or gracefully degrade) across **local / desktop / web** modes.
> Anti-goal: don't re-bloat the app. The recent feature cut (embeddings, clips, notes, favorites, highlights)
> was correct. Only ship features that earn their place in the core loop: *paste → transcript → digest → library*.

**Implementation status (2026-07-07):** Features A1, C2, C1, B1, A2 are **implemented and runtime-verified** on the dev tree (tests 204/204 green, security-scanned). B2 (TTS read-aloud) was **intentionally dropped** at user request ("I just want to read it"). See annotations in each section below for key deviations (dedicated endpoint for C2, A2 local/desktop-only, C1's FTS query builder).

## Mode cheat-sheet (the design filter)

| | local (default) | desktop (Tauri) | web (hosted BYOK) |
|---|---|---|---|
| Library store | server SQLite (`store.js`) | server SQLite | **client IndexedDB** (no server store) |
| FTS5 search | server-side | server-side | **not available** — client keyword filter |
| Filesystem | yes | yes | **no** (browser sandbox) |
| Background work / cron | yes | yes | **no** (stateless, per-request) |
| AI key | local `claude` CLI | CLI or optional BYOK | **BYOK required** (`X-Echo-Api-Key`) |
| Rate/payload caps | none | none | yes |

**Rule of thumb:** anything "library-wide" or "background" or "filesystem" needs a web fallback that runs
client-side or degrades to on-demand. Call out the split per feature below rather than pretending it's uniform.

---

## Recommended build order (ROI ÷ effort)

1. **B2 — TTS read-aloud** — trivial, pure client, identical in all 3 modes, dead-on-brand.
2. **A1 — Multi-paste queue** — low effort, reuses `playlistJob.js`, useful everywhere.
3. **C2 — Auto-tagging on save** — low effort, feeds Discovery + C1.
4. **C1 — Ask-across-library** — headline knowledge-base feature; C2 improves its retrieval.
5. **B1 — Markdown vault sync** — high value for local/desktop; web falls back to existing ZIP.
6. **A2 — Channel following** — highest ceiling, most work, only genuinely mode-divergent one. Do it last.

---

# A — Ingestion

## A1. Multi-paste queue  ·  effort: LOW  ·  priority: 2  ·  ✅ Implemented 2026-07-07

**Goal:** paste many URLs/IDs at once → dedupe against library → run transcript→digest as a tracked queue.

**Implementation note:** `startBatchDigest(items, opts, deps)` in `playlistJob.js`; `POST /api/batch/digest` returns `kind:'batch'` job reusing playlist status/cancel routes; frontend "＋ Paste many" overlay; web mode client-drives queue, capped at 5; env `ECHO_MAX_BATCH_ITEMS` (default 50).

**Reuse:** `playlistJob.js` is already exactly this pattern. Generalize it from "playlist videos" to
"arbitrary list of URLs." `transcript.js` already extracts IDs from mixed URL/ID input.

**Cross-mode:**
- local/desktop: unbounded queue, job state server-side, reuse `/api/playlist/digest*` job machinery.
- web: cap queue length (start at 5), drive the queue **client-side** (sequential `fetch` calls) so it
  respects rate limits + BYOK. No server job — the browser owns the loop.

**Backend:**
- [ ] Generalize `playlistJob.js` → accept an explicit `videoIds[]` source, not just a playlist URL.
- [ ] `POST /api/batch/digest` (local/desktop): body `{ items: [url|id...], length, format }` → returns jobId.
      Reuse existing `/api/playlist/digest/status` + `/cancel` (or alias them).
- [ ] Dedupe against library before enqueue (skip already-saved; report as `skipped`).

**Frontend:**
- [ ] Command bar: "＋ paste many" toggle → textarea (newline/comma separated).
- [ ] Reuse the playlist progress panel UI (per-item status: queued / running / saved / skipped / failed).
- [ ] web: same UI, but the progress loop is client-driven and length-capped with a visible cap notice.

**Open questions:**
- Auto-save each digested item, or stage them for review first? (Lean: auto-save in local/desktop, stage in web.)
- Concurrency: keep serial (1 at a time) to stay under CLI/BYOK limits, or small pool? (Lean: serial first.)

## A2. Channel / creator following  ·  effort: MEDIUM–HIGH  ·  priority: 6  ·  ✅ Implemented 2026-07-07 (local/desktop only)

**Goal:** "Follow a channel" → periodically pull latest N uploads → surface *new* ones in an inbox.
This is what turns Echo from a converter into a **replacement for watching**.

**Implementation note:** `follows` + `follow_seen` tables; `GET/POST/DELETE /api/follows`, `GET /api/follows/inbox`, `POST /api/follows/seen`; discovery.js `normalizeChannel()` + `enumerateChannelUploads()` (15-min TTL); Inbox pane with per-channel badges; one-click Follow on Discovery cards + loaded video channel; **web mode hides Inbox/Follow after cost-sink hardening** (keyless yt-dlp discovery no longer available in web); env `ECHO_MAX_FOLLOWS` (25), `ECHO_FOLLOW_UPLOADS` (10).

**Reuse:** yt-dlp already enumerates channel/playlist videos (`discovery.js` / `transcript.js` playlist path).

**Cross-mode — this is the one that genuinely diverges. Decide the split early:**
- local/desktop: persist a `follows` list + a `seen` set server-side. Refresh on app open **and**
  optionally on an interval (local/desktop can run a timer). New-since-last-visit → inbox badge.
- web: **no background, no server persistence.** `follows` + `seen` live in IndexedDB; refresh only
  happens when the user opens the app / clicks "check now." Same feature, degraded to manual pull.
  → **Explicitly accept "web = manual refresh only" before building this.**

**Data model (local/desktop):**
- [ ] `follows(channelId TEXT PK, title, url, addedAt, lastCheckedAt)`
- [ ] `follow_seen(channelId, videoId, seenAt, UNIQUE(channelId, videoId))`
- [ ] web mirror: two IndexedDB stores with the same shape.

**Backend (local/desktop):**
- [ ] `GET/POST/DELETE /api/follows` — manage follow list.
- [ ] `GET /api/follows/inbox` — enumerate each follow's latest uploads via yt-dlp, diff against `follow_seen`,
      return unseen items. Cache per channel (yt-dlp is slow) — reuse the caching pattern in `usage.js`.
- [ ] Optional: interval refresh (setInterval in server, local/desktop only). Keep it opt-in + cheap.

**Frontend:**
- [ ] "Follow" button on Discovery result cards + on a loaded video's channel.
- [ ] New **Inbox** pane (sibling to Library/Discovery): grouped by channel, "new" badges, one-click digest.
- [ ] Mark-as-seen on open; "check now" button everywhere (the only refresh path in web).

**Open questions:**
- yt-dlp channel enumeration cost/rate — how many follows before it's slow? Cap follows (e.g. 25) + stagger checks.
- Do we auto-digest new uploads or just list them? (Lean: list only; digest is a click. Auto-digest burns tokens.)
- Channel ID extraction from arbitrary channel URLs (@handle, /channel/UC..., /c/name) — normalize in `transcript.js`.

---

# B — Interop / Export out

## B1. Markdown vault sync (Obsidian-style)  ·  effort: LOW–MEDIUM  ·  priority: 5  ·  ✅ Implemented 2026-07-07

**Goal:** point Echo at a folder → write one `.md` per saved video (frontmatter + digest + transcript),
tags as `#tags` / backlinks. Turns the library into an Obsidian/Logseq-compatible vault.

**Implementation note:** New module `vault.js` (`syncVault(dir, opts)`, `slugify()`); `POST /api/vault/sync` (blockInWeb); idempotent filenames `<slug>-<videoId>.md`; Settings folder-path field + "Sync to vault" button + last-synced indicator; web degrades to ZIP export; env `ECHO_VAULT_DIR`; `vault.js` added to `src-tauri/tauri.conf.json` `bundle.resources` (guarded by `tests/tauri-bundle.test.js`).

**Reuse:** `markdown.js` already emits YAML-frontmatter Markdown per entry. This is mostly a *destination*.

**Cross-mode:**
- local/desktop: real filesystem write to a user-chosen folder. Desktop can use the Tauri dialog/fs APIs.
- web: **no filesystem** → degrade to the existing JSZip "export vault as ZIP" (already built). Same mental
  model, different transport. Don't try to shim FS access in the browser.

**Backend (local/desktop):**
- [ ] Config: `ECHO_VAULT_DIR` (env) and/or a Settings field storing the path.
- [ ] `POST /api/vault/sync` — write/update `.md` for all (or changed) entries; return counts.
- [ ] Idempotent filenames (`<slug>-<videoId>.md`); overwrite-in-place so re-sync updates, not duplicates.
- [ ] Optional: sync-on-save hook (write the file whenever an entry is saved/updated).

**Frontend:**
- [ ] Settings: vault folder picker (desktop = native dialog; local = text path + validate).
- [ ] Library toolbar: "Sync to vault" button + last-synced indicator.
- [ ] web: the button reads "Download vault (.zip)" — wire to existing ZIP export.

**Open questions:**
- Include full transcript in each note, or digest-only with a link? (Lean: digest + collapsible transcript.)
- One-way (Echo → vault) only for v1. Two-way sync is out of scope (too complex, low value).
- Tag format: `#tag` inline vs YAML `tags: []`. (Lean: YAML frontmatter — Obsidian reads both.)

## B2. Read-aloud / TTS  ·  effort: LOW  ·  priority: 1  ·  ⭐ best cross-mode ROI  ·  🚫 Dropped 2026-07-07

**Goal:** listen to the digest (or transcript) instead of reading. Directly serves the "don't watch video"
audience who'd also rather not stare at text — commuters, accessibility.

**Status:** User explicitly declined this feature ("I just want to read it"). Implementation blocked by user decision, not technical constraint; browser `SpeechSynthesis` API was ready-to-use.

**Reuse:** nothing needed — browser `SpeechSynthesis` (Web Speech API) is client-side, offline, keyless.

**Cross-mode:** **identical in all three modes.** Pure frontend, no server, no API key, no payload cost.
This is why it's #1.

**Frontend only:**
- [ ] Play / pause / stop control on the Digest pane (and optionally Transcript).
- [ ] Speak the rendered digest text (strip Markdown to plain text before speaking).
- [ ] Voice + rate picker (populate from `speechSynthesis.getVoices()`), persist choice in localStorage
      (same pattern as theme + answer-language prefs).
- [ ] Progress/section highlight is a nice-to-have; skip for v1.

**Open questions:**
- Chunk long digests (SpeechSynthesis has per-utterance length limits in some browsers) — split on paragraphs.
- Voice quality varies by OS/browser. Acceptable for v1; a cloud-TTS upgrade is a future, mode-divergent option.

---

# C — Library as knowledge base

## C1. Ask-across-library (RAG over saved videos)  ·  effort: MEDIUM  ·  priority: 4  ·  ✅ Implemented 2026-07-07

**Goal:** "What has my library said about X?" → retrieve candidate saved videos → synthesize one answer
with per-video citations. Extends single-video `ask` and manual `cross-digest` into a real second-brain query.

**Implementation note:** `POST /api/library/ask`; digest.js `askLibrary(question, candidates, opts)` synthesizes answer + citations with context budgeting; store.js `buildLibraryFtsQuery()` converts natural-language question to OR-of-quoted-terms FTS5 MATCH (raw questions ANDed stopwords → zero recall); frontend "Ask your library" bar with answer card + clickable citation chips; env `ECHO_LIBRARY_ASK_K` (default 5).

**Reuse:** FTS5 retrieval (`store.js`), retrieval-lite scoring (`digest.js`), synthesis prompt shape
(cross-digest in `digest.js`). All primitives exist — this is glue.

**Cross-mode:**
- local/desktop: query server FTS5 for top-K matching videos → feed their digests/snippets into one
  synthesis call → return answer + citations linking to library entries.
- web: no server FTS5. Client runs a lightweight keyword filter over IndexedDB, picks top candidates,
  and **sends those candidates** (digests/snippets, budget-capped) with the request. Same feature, retrieval
  moves client-side. Watch payload caps.

**Backend:**
- [ ] `POST /api/library/ask` (local/desktop): body `{ question }` → FTS5 top-K → synthesize → `{ answer, citations[] }`.
- [ ] Budget the context (reuse map-reduce chunking if candidates exceed token budget).
- [ ] web variant: accept client-supplied candidate set in the body (retrieval already done client-side).

**Frontend:**
- [ ] Library pane: an "Ask your library" bar (distinct from per-video Ask).
- [ ] Answer card with inline citations → click a citation to open that library entry.
- [ ] Reuse the QA thread UI from the Digest→Ask panel.

**Open questions:**
- Retrieval quality depends on good tags/digests → **C2 (auto-tagging) should land first.**
- How many candidate videos to feed? Start K=5, cap total context, note truncation in the UI (no silent caps).
- Cite by video title + timestamp if we can locate the supporting segment; else video-level citation.

## C2. Auto-tagging on save  ·  effort: LOW  ·  priority: 3  ·  ✅ Implemented 2026-07-07

**Goal:** generate 3–5 tags automatically from the digest at save time. Today tags are manual, so most
saves have none — which starves Discovery and any future clustering (and C1's retrieval).

**Implementation note:** Dedicated `POST /api/tags/suggest` endpoint (webLimit + requireWebKey) to avoid coupling to generateDigest output contract; digest.js `suggestTags(material, opts)` returns 3–5 normalized lowercase tags; frontend best-effort auto-suggest after save + Settings toggle "Auto-suggest tags on save" (localStorage `echo-auto-tags`; default ON local/desktop, OFF web).

**Reuse:** tags plumbing exists (`tags` table, `PATCH /api/saved/:id/tags`). Just need generation.

**Cross-mode:**
- local/desktop: on save, one cheap model call (or piggyback the digest call) → tag suggestions → store.
- web: same call, but it costs BYOK tokens → make it **opt-in** (a checkbox / toggle), don't spend the
  user's key silently.

**Backend:**
- [ ] `POST /api/tags/suggest` — body `{ digest | transcriptExcerpt }` → `{ tags: [...] }` (3–5, sanitized,
      reuse the existing tag cap/dedup logic).
- [ ] Wire into the save flow (local/desktop: auto; web: only if opt-in flag set).

**Frontend:**
- [ ] On save: show suggested tags as removable chips the user can accept/edit before commit.
- [ ] Settings toggle: "auto-suggest tags" (default on for local/desktop, off for web).

**Open questions:**
- Piggyback on the digest generation (ask it to emit tags in the same call → cheaper) vs a separate call.
  (Lean: piggyback when a digest is generated; separate call only when saving a transcript with no digest.)
- Normalize/canonicalize tags (lowercase, singularize) to avoid "AI"/"ai"/"artificial-intelligence" splinter.

---

# Bun vs npm — evaluation (researched 2026-07-06)

**Verdict: stay on npm for now. A Bun _runtime_ switch is a hard no. `bun install` (package-manager-only)
is safe but low-reward.**

### Why runtime switch is blocked
Echo's library layer is built on the **built-in `node:sqlite`** module (`DatabaseSync` / `StatementSync`),
a deliberate "no native DB deps" choice. **Bun does not implement `node:sqlite`** as of Bun 1.3.14 (May 2026)
— it's marked 🔴 Not implemented on Bun's Node-compat page, tracked in open issue
[oven-sh/bun#31402](https://github.com/oven-sh/bun/issues/31402). Bun only offers its own incompatible
`bun:sqlite` (`Database` / `query()`), so `bun run server.js` would throw `ERR_MODULE_NOT_FOUND` at startup.
Switching would require **rewriting the entire DB layer + all SQLite tests** for zero user-facing benefit.

Secondary risks even if that were solved:
- `node:test` is only 🟡 partial on Bun (no mocks/snapshots) — Echo's `node --test` suite would need review/migration.
- `child_process.spawn` is 🟡 partial (had a stdout memory leak fixed only in v1.3.14); Echo spawns
  `claude` / `yt-dlp` / `ccusage`, and the Windows `.cmd` gotcha (already documented in CLAUDE.md) has no
  guarantee of matching under Bun.
- Tauri has **no official Bun-sidecar guide** — only Node. A `bun build --compile` single-binary sidecar
  would elegantly kill the `bundle.resources` drift problem, but it's blocked by the same `node:sqlite` wall.

### `bun install` only (keep Node runtime) — safe but marginal
- Node still runs everything, so `node:sqlite` / `node:test` are unaffected.
- Bun 1.2+ uses a diffable text `bun.lock` (not the old binary `bun.lockb`); auto-migrates from `package-lock.json`.
- Costs: must install Bun in **every** environment incl. CI; drop `package-lock.json` to avoid drift; Bun
  **skips dependency lifecycle scripts** (audit deps first). For Echo's small dep tree the install-time saving
  is seconds — not worth the ceremony right now.

### Action
- [ ] **Do nothing** — stay on npm.
- [ ] **Watch** [oven-sh/bun#31402](https://github.com/oven-sh/bun/issues/31402). If/when Bun ships
      `node:sqlite`, re-evaluate: at that point the `bun build --compile` **single-binary Tauri sidecar**
      becomes genuinely attractive (no `bundle.resources` drift, cross-compilation, smaller bundle) and is
      worth a spike.

Sources: bun.sh/docs/runtime/nodejs-apis · bun.sh/blog/bun-v1.2 · bun.sh/blog/bun-v1.3.14 ·
bun.sh/docs/bundler/executables · github.com/oven-sh/bun/issues/31402 · tauri.app/learn/sidecar

---

# Start-here checklist for tomorrow

1. **B2 TTS** — smallest win, ship it first to build momentum. Pure frontend in `public/index.html`.
2. **A1 multi-paste** — generalize `playlistJob.js`; reuse the playlist progress UI.
3. **C2 auto-tagging** — piggyback tags on digest generation; opt-in in web.
4. Then **C1**, **B1**, and finally **A2** (decide the "web = manual refresh" split before starting A2).

Reminder from CLAUDE.md gotchas: server **caches index.html at boot** (restart to see frontend edits);
`node --test` **doesn't** exercise the real CLI or CSP-loaded page — do a real digest + light/dark/mobile
screenshot pass before calling any UI work done; new backend `.js` modules must be added to
`tauri.conf.json` `bundle.resources` (guarded by `tests/tauri-bundle.test.js`).
