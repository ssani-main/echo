# Echo — Feature Audit & Cut Plan

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
