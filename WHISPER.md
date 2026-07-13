# Whisper transcription — spec

**Status:** proposed (not built). **Scope:** local/desktop only — never web.

## Why

Two problems, one mechanism.

1. **Dead-end today.** When a video has no captions, `fetchTranscript` throws
   `TRANSCRIPT_UNAVAILABLE` (`transcript.js:374–398`) and the flow stops. Whisper
   gives us a transcript where none existed.
2. **ASR captions are low quality.** YouTube auto-generated captions have no
   punctuation, no capitalization, homophone errors, and run-on structure.
   Whisper `large-v3` produces clean, punctuated, correctly-spelled text.
   **Better transcript → better digest → more accurate "what's being discussed."**
   This is the accuracy upgrade the feature is really about — not just filling a gap.

The transcript is the raw material for *every* downstream feature (digest, tags,
enrich, find-in-transcript, share). Improving it improves all of them at once.

## Non-goals / hard constraints

- **Web mode never runs Whisper.** Web is stateless, BYOK-Anthropic-only, and a
  quick single-video read; downloading full audio + uploading to a third API is a
  cost-sink and a second-provider-key we won't put in the stateless path. Web keeps
  today's behaviour (captions or the dead-end). Guard it like `blockInWeb`.
- **No new npm dependency.** Whisper (Groq + OpenAI) are OpenAI-compatible
  multipart endpoints; use native `fetch` + `FormData` + `Blob` (Node ≥22.5).
  Do **not** add `groq-sdk`/`openai`.
- **Never break local mode** (project hard constraint). Whisper is strictly
  additive and off unless a key is configured.
- **Transcript shape is sacred.** Whisper must return the exact existing shape —
  `[{ text, offset }]` (offset = seconds) with a non-enumerable `langUsed` — so
  chunking (`digest.js`), the web-mode char cap (`server.js:512`), find-in-transcript,
  jump-to-time, and library save all keep working untouched.

## Provider model

- Default provider **Groq** (`whisper-large-v3`) — cheaper/faster, generous free
  tier. Fallback **OpenAI** (`whisper-1`). Both hit
  `POST .../audio/transcriptions` with `response_format=verbose_json` (returns
  `segments:[{start,end,text}]` → maps straight to `{text, offset}` with real
  timestamps).
- **Key sourcing** mirrors the Anthropic BYOK pattern (`server.js:284` `readApiKey`):
  - **local:** env `GROQ_API_KEY` / `OPENAI_API_KEY` (add to `.env.example` AI section).
  - **desktop:** per-request header `X-Echo-Whisper-Key` ← `localStorage['echo-whisper-key']`,
    read by a new `readWhisperKey(req)` sibling of `readApiKey`. Provider chosen by a
    `whisperProvider` setting (`groq`|`openai`) or `ECHO_TRANSCRIBE` env.
  - **web:** ignored/blocked.

## Three transcript tiers (one setting)

`whisperMode` (setting, threaded through `/api/transcript` as `transcribe`):

| mode | behaviour | default |
|---|---|---|
| `off` | never use Whisper — today's behaviour | when **no** key configured |
| `fallback` | Whisper **only** when captions are missing (fills the dead-end) | when a key **is** configured |
| `always` | Whisper even when captions exist — the accuracy upgrade | opt-in |

## New module: `whisper.js`

```
transcribeViaWhisper(videoId, opts) -> Promise<[{text, offset}]>  // + langUsed stamped
getWhisperProvider(opts)            -> { name, url, model, apiKey } | null
mapWhisperError(err)                -> { echoCode, message, hint }
```

`transcribeViaWhisper` steps:

1. **Download audio** — reuse the existing yt-dlp `execFile` pattern
   (`transcript.js:153`) into `tmpdir()`:
   `yt-dlp -f bestaudio -x --audio-format mp3 --audio-quality 32K -o <tmp> <url>`.
   - **ffmpeg is optional, not required.** yt-dlp's `-x` postprocessor uses ffmpeg
     *if present* to re-encode small (≈0.5 MB/min → ~50 min fits the 25 MB API cap).
     If ffmpeg is absent, fall back to raw `yt-dlp -f bestaudio -o <tmp>` (no
     re-encode) and upload the native container (m4a/webm — both APIs accept them).
     Only fail with `FFMPEG_MISSING` hint if the raw file exceeds the API limit and
     we can't split it.
2. **Split if oversize** — Whisper upload cap is 25 MB. If the audio exceeds
   ~24 MB, split with ffmpeg (`-f segment -segment_time 1200`, 20-min chunks) and
   transcribe segments with **bounded concurrency (≤4)**, adding each segment's
   cumulative start offset to its returned timestamps so `offset` stays global.
3. **Transcribe** — multipart POST per file:
   `FormData{ file: Blob, model, response_format:'verbose_json', language? }`
   → parse `segments[]` → `{ text: seg.text.trim(), offset: baseOffset + seg.start }`.
4. **Stamp** non-enumerable `langUsed` on the array; **always** `rm -rf` the tmp
   dir in a `finally`.

Guardrails: overall op timeout (`ECHO_WHISPER_TIMEOUT_MS`, default 300 s →
`WHISPER_TIMEOUT`); max-duration reject (`ECHO_WHISPER_MAX_MINUTES`, default 180 →
`WHISPER_AUDIO_TOO_LONG`) checked from yt-dlp metadata before download.

## Integration points

**A. Fallback** — in `fetchTranscript` (`transcript.js:359`), before throwing
`TRANSCRIPT_UNAVAILABLE` at `:374–398`: if `opts.transcribe !== 'off'`, a whisper
key resolves, and not web mode → `return await transcribeViaWhisper(videoId, opts)`.
On Whisper failure, fall through to the original error (append a hint).

**B. Accuracy upgrade (`always`)** — at the **top** of `fetchTranscript`, if
`opts.transcribe === 'always'` and a key resolves and not web → go straight to
Whisper, skipping the caption fetch entirely.

**C. Digest improvement** — *automatic*. The digest consumes the transcript string
(`generateDigest(transcriptText)`, `digest.js:542`); once that text is Whisper-sourced
it is punctuated and accurate, so digest/tags/enrich quality rise with **zero digest
code change**. Bonus: clean sentence boundaries make `chunkText` (`digest.js:392`,
newline-based) split map-reduce chunks more cleanly on long videos. No flag to the
digest is needed — the win is entirely in the input text.

## Server surface (`server.js`)

- `POST /api/transcript` (`:492`): accept `transcribe` in the body; add
  `readWhisperKey(req)` (`X-Echo-Whisper-Key`, honored in local+desktop only, like
  `readApiKey`); pass `{ transcribe, whisperKey, whisperProvider }` into
  `fetchTranscript`. **In web mode, force `transcribe:'off'`** regardless of body.
  Add `transcriptSource: 'captions'|'whisper'` to the response.
- New `ECHO_ERROR_STATUS` codes (`:207`): `WHISPER_NOT_AUTHED→401`,
  `WHISPER_FAILED→502`, `WHISPER_AUDIO_TOO_LONG→422`, `WHISPER_TIMEOUT→504`,
  `FFMPEG_MISSING→503`. `mapWhisperError` produces the `{echoCode,message,hint}`
  envelope so `sendCaughtError` (`:245`) handles them unchanged.
- Optional `POST /api/validate-whisper-key` (parallels `/api/validate-key`): a
  1-second no-op transcription or a models-list ping.
- **Note:** the transcript fetch on the frontend (`public/index.html:6994`) uses
  raw `fetch` with no key header. To bill Whisper to a desktop user's key it must
  send `X-Echo-Whisper-Key` — either switch that call to a keyed helper or add the
  header inline (mirror `aiFetch` at `:9170`).

## Frontend (`public/index.html`)

- **Settings → new "Transcription (advanced)" section** (local/desktop only, hidden
  in web): provider radio (Groq/OpenAI), `#whisperKeyInput`
  (`localStorage['echo-whisper-key']`), mode select (Off / Fallback / High-accuracy),
  optional Validate button.
- **Source badge** on the reader + digest: "Transcript: Whisper (high-accuracy)" vs
  "YouTube captions", from `transcriptSource`.
- **Progress affordance:** Whisper (download + upload + transcribe) is tens of
  seconds, not the sub-second caption fetch — reuse the existing top-indicator
  (`setTopIndicator('working')`) so the ambient background comes alive during it.

## Library (data shape — Phase-2-clean)

Persist `transcriptSource` (and optionally `whisperModel`) on saved entries so a
re-open knows the transcript's provenance. Additive/non-breaking; old entries
default to `'captions'`.

## Tauri (`src-tauri/tauri.conf.json`)

- Register the new module in `bundle.resources` (`:42`): `"../whisper.js": "whisper.js"`
  — or the desktop sidecar crashes `ERR_MODULE_NOT_FOUND` at runtime (unit tests +
  `.deb`/`.rpm` bundlers won't catch it; `tests/tauri-bundle.test.js` will — update
  its expected list too).
- No new npm dep to add to `dist-deps` (native fetch). **ffmpeg** for
  desktop: document as an optional external requirement (the no-ffmpeg raw-audio
  path still works for short videos); bundling ffmpeg via `externalBin` is a later
  polish, not launch-blocking.

## Testing

- **Unit** (`node --test`): mock the Whisper HTTP call (`fetch`) and the
  yt-dlp/ffmpeg spawns. Assert: output shape `[{text,offset}]`; **offset stitching**
  across multiple audio segments; `langUsed` stamped; web-mode guard forces `off`;
  each error → correct `echoCode`; `always` skips caption fetch; `fallback` only
  fires after captions fail.
- **Bundle-drift:** add `whisper.js` to `tests/tauri-bundle.test.js`.
- **Runtime (external-dep-blocked, manual):** a no-caption video + a real Groq key →
  transcript + digest end-to-end; and an `always` A/B on a video with bad ASR
  captions to confirm the digest sharpens (this is the whole thesis — verify it).

## Phasing

1. **P1 — fill the dead-end.** `whisper.js` + `fallback` path + env key (local).
   No UI. Smallest useful slice; proves the pipeline.
2. **P2 — accuracy upgrade.** Settings UI + desktop `X-Echo-Whisper-Key` + `always`
   mode + source badge. This is the digest-quality win the user asked for.
3. **P3 — polish.** `transcriptSource` in library, chunked long-audio hardening,
   `/api/validate-whisper-key`, optional ffmpeg bundling for desktop.

## Open decisions (need a call before building)

1. **ffmpeg posture:** require it (clean 0.5 MB/min, always fits) vs keep it optional
   (lower install friction, raw-audio upload, fails on long videos without it)?
   Spec assumes **optional**.
2. **Default mode when a key is set:** `fallback` (conservative, spend only when
   needed) vs `always` (max accuracy, spends every video)? Spec assumes **`fallback`**.
3. **Provider default:** Groq (free tier, fast) — assumed. Any reason to prefer OpenAI?
