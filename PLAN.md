# Echo — Feature Audit & Cut Plan

> Status: **IN PROGRESS 2026-07-10.** Second audit (public-launch scoping) below. The prior
> 2026-07-06 cut plan is COMPLETED and preserved further down.

---

## Public-Launch Feature Audit (2026-07-10, grilling outcome)

Outcome of a `/grill-me` session scoping Echo for a public launch. Root question: for a
public launch / general users, which current features earn their place?

### Foundation (root decisions)
1. **Launch product = a stranger's first _single-video_ web read.** BYOK, stateless, free,
   no account. The differentiated thing (digest quality) and the only thing launch must prove.
2. **Library = free browser-local (IndexedDB) at launch.** Accounts + a paid server-saved
   library are **Phase 2** (deferred). Keep digest/entry data shapes clean so accounts can
   hang off them later without a rewrite.

### Feature verdicts

| Feature | Verdict | In web launch? | Notes |
| --- | --- | --- | --- |
| Digest (incl. map-reduce fallback) | **Keep — the product** | ✅ | The core read |
| Transcript / languages / video-meta | Keep (infra) | ✅ | Required for the read |
| Find-in-transcript | Keep | ✅ | Free, client-side, on-mission |
| Enrich popover | Keep **trimmed** | ✅ | Ship Explain/Background/Ask; **drop "Verify"** in web |
| Verify-claims | **Flag-off, keep code** | ❌ | Cost/latency/reputational sink on first read; power tier only |
| Chat / ask-about-video | **Cut** | ❌ | Unused — full-removal candidate |
| Playlist (+ cross-digest) | Out of web launch, keep code | ❌ | Contradicts single-video scope; local/desktop only |
| Library save/CRUD | Keep (core intent: "save what I read") | ❌ (local) | Point of the library tier |
| Extract (vault sync + markdown export) | Keep (core intent: "extract it") | ❌ (local) | Other half of the intent |
| FTS5 keyword search | **Keep, unconditional** | ❌ (local) | Now load-bearing library navigation |
| Tags (manual + AI auto-tag) | Keep **both**, redesigned | ❌ (local) | **Auto-tag moves into the digest pass**, shown only at save |
| Ask-across-library (RAG) | **Cut** | ❌ | Unused — full-removal candidate (check `buildLibraryFtsQuery` shared with FTS5 search first) |
| Batch / multi-paste queue | **Cut** | ❌ | Unused; OAuth feed supersedes it |
| Discovery + Follows/Inbox | **Keep + expand** | ❌ | Becomes the YouTube reading front-end |
| Share pages (`/s/:id`) | Keep → **first Phase-2 add** | ❌ now, ✅ soon | Main growth loop; needs a minimal store |
| Usage action meter | Keep | ❌ | Post-launch validation of these cuts |
| ccusage cost-display | **Drop** | ❌ | Flaky Windows-`.cmd` half |

### What web launch v1 ships
Stranger pastes one link → transcript → **digest** → reads → **find-in-transcript** + optional
**highlight → Explain/Background/Ask** (ephemeral popover). Free, stateless, BYOK. Nothing else.

### Phase-2 backlog (ordered)
1. **Web share** (`/s/:id` via a minimal TTL'd store) — first add after launch; unlocks the growth loop.
2. **Accounts + server-saved library** (+ a web/IndexedDB search story).
3. **Discovery-via-YouTube-OAuth** — subscriptions/Liked/playlists feed → auto-populates
   Follows → Inbox is the feed → one-click digest. **Reality check:** the true algorithmic
   "For You" feed is NOT available via YouTube's official API, so the shippable feed is
   subscriptions-based; the real home feed stays a **personal desktop-only** logged-in scrape.

### Codebase actions (this audit → code)
- **Full-removal candidates:** chat/ask, ask-across-library (verify `buildLibraryFtsQuery` first), batch digest.
- **Flag-off, keep code:** verify-claims, playlist, `/api/claims`, share (already `requireSharesEnabled`).
- **Web-trim:** drop "Verify" from the enrich popover in web mode.
- **Redesign:** fold auto-tagging into the digest pass, surface tags at save.
- **Drop:** ccusage cost-display; keep the JSONL action meter.

### Open sub-decisions (surfaced, not fully pinned)
- **Removal degree** for chat + ask-across-library: full code removal vs flag-off (leaning full
  removal; confirm per-file because they touch shared helpers).
- **Web/IndexedDB library search** in Phase 2: reuse server FTS5 behind auth vs a client-side index.

---

## Prior audit (2026-07-06) — feature cut

> Status: **COMPLETED 2026-07-06.** Five confirmed-dead features removed (highlights, clips, notes, favorites, embeddings/semantic search). FTS5 keyword search kept. Map-reduce digest retained as correctness fallback for >480k-char transcripts.

## Evidence

From `data/library.db` (16 saved videos) + legacy `data/library.json` (10 videos), both
starting 2026-07-01 — total persisted history is only ~2–3 days / 26 videos:

| Feature      | Usage                                          | Read |
| ------------ | ---------------------------------------------- | ---- |
| Digest       | 26 / 26 (100%)                                 | Core |
| Highlights   | **0 rows**                                      | Dead |
| Notes        | **0 rows**                                      | Dead |
| Favorites ★  | **0**                                           | Dead (but rare-by-nature) |
| Tags         | 4 rows, one tag ("Indonesia"), most untagged   | Barely used |
| Embeddings   | 9/16 populated — hybrid search running half-blind | Over-built |
| Video length | 255–10,481 segments                            | Long videos real |

Key gap: **the DB only records _saved_ videos.** Digest-without-save and every AI-tool run
on a throwaway video are invisible. Digest usage is undercounted; per-tool usage is unknown.

## Confirmed cuts — ✅ DONE 2026-07-06

1. **Highlights** — 0 rows. ✅ Removed `highlights` table + PUT/POST/DELETE `/highlights` routes + highlight UI.
2. **Clips reel** — built from highlights (=0), always empty. ✅ Removed `clips.js` + `/api/clips`.
3. **Notes** — 0 rows. ✅ Removed `notes` table + notes routes + notes UI.
4. **Favorites** — 0. ✅ Removed favorite column use + `/favorite` route + ★ UI.
5. **Semantic/embeddings search** — 9/16 embedded, trivially keyword-searchable library.
   ✅ Removed `embeddings.js`, `@xenova/transformers` dep, `data/models/` (~23MB), reindex route.
   **FTS5 keyword search retained.**

Soft cut: **tags** (one tag, ~25% coverage — not a tagger). **Kept** — cheap to maintain.
Deliberate keep: **map-reduce digest** (threshold ~480k chars) — no user-facing surface, correctness fallback for edge-case long transcripts.

## Measure before cutting (no DB trace today)

fact-check, Ask, quotes, chapters, cross-digest, playlist-batch leave no trace. Strong
inference they're unused, but decide on real numbers — see action logging below.

## Action logging (do first) — ✅ SHIPPED 2026-07-06

Implemented in `usagelog.js` (local-only, fire-and-forget) + `usage_stats.mjs` analyzer;
`logEvent` wired into `server.js` (transcript, digest, ask, enrich, cross-digest,
playlist-digest, save, unsave, search). `digest.js` now surfaces `strategy`
(single/mapreduce) and enrich `results` (web-hit count). Frontend sends `videoId` with
digest/chat/enrich so the funnel correlates. Writes `data/usage-events.jsonl` (gitignored).
Runtime-verified end-to-end. **Run ~1 week, then `node usage_stats.mjs` and finalize cuts.**

Original design (for reference):

Add fire-and-forget action telemetry so decisions rest on data, not inference:

- Append one JSONL line per action to `data/usage-events.jsonl`. Non-blocking; must never break the request path.
- **Log even when the video is NOT saved** — that's the whole point.
- Events (`server.js` routes): `transcript`, `digest`, `chat`/ask, `factcheck`, `chapters`,
  `quotes`, `cross-digest`, `playlist-digest`, `save`, `search`. Also `highlight-created` /
  `note-created` (same save blind spot as digest — log the action, don't infer from DB).
- Fields: `{ event, ts, videoId?, chars?, model? }`. No PII beyond videoId.
- **Local mode only** — do not log server-side in web mode (multi-tenant privacy).
- Add a small analyzer script (see `usage_stats.mjs` pattern) to tally by type.
- Run ~1 week, then finalize AI-tool cuts.

## Blind spots (weigh before acting)

- **Thin base:** ~2–3 days / 26 videos. Strong for per-read habits (highlights); weak for
  rare-by-nature features (favorites = the 1-in-50 gem; cross-digest = occasional). Give
  those two extra patience.
- **Frequency ≠ value:** count-based cutting is biased against rare-but-high-value tools.
- **Discoverability:** "0 highlights" could be a UX failure, not a preference.
- **Survivorship bias:** "digests feel right" — we only remember the saved/good ones.
- **Kept on assumption, not data:** FTS5 search (no evidence it's used on a 16-item list),
  reading modes / find-in-transcript / font+language (client-side, invisible to server log).
- **Unexamined candidate:** map-reduce chunking (threshold ~480k chars, `digest.js`). Verify
  it ever fires for real videos; if not, it's dead complexity too.
- **Biggest dead weight is structural:** web mode + Tauri desktop are fully maintained but
  unused by a local tool-for-one. Bigger than any single feature — but cutting kills future
  optionality, so decide separately, don't lump into feature cuts.
- **Asymmetric cut-risk:** backend deletes (clips.js, embeddings.js) are safe; ripping UI out
  of the ~9,500-line `index.html` monolith risks the core reading loop. Backend first.

## Execution log

1. ✅ SHIPPED 2026-07-06 — Action logging (`usagelog.js` + `usage_stats.mjs`). Local-only telemetry, wired into `server.js`.
2. ✅ COMPLETED 2026-07-06 — Five confirmed-dead features removed:
   - Backend: `embeddings.js`, `clips.js` deleted; `@xenova/transformers` dep removed; `data/models/` excluded.
   - Database: `highlights`, `notes`, `embeddings` tables pruned; `favorites` column removed.
   - Routes: removed `/api/clips`, `/api/saved/:videoId/highlights/*`, `/api/saved/:videoId/notes/*`, `/api/saved/:videoId/favorite`, `/api/search/*`.
   - Frontend: removed highlight/note/favorite UI from `index.html`; docs updated (README, .env.example, this file).
   - Verified: FTS5 keyword search + usage logging still active.
   - Kept: map-reduce digest (correctness safety net, user-invisible).

## Deferred decisions

- AI tools (Ask, Fact-check, etc.) — wait on usage log data (~1 week) before deciding.
- Web mode + Tauri — separate deliberate decision; not lumped into feature cuts.
