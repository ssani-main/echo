# Frame-augmented digest — spec

**Status:** ✅ **P1 + P2 shipped (2026-07-13).** **Scope:** local/desktop only — never web.
**Evidence base:** three real A/B tests (transcript-only vs +frames), all frame
claims ground-truth-verified. See the findings artifact and
[[echo-frame-augmented-digest-test]]. Read that first — this spec is shaped by what
the tests proved, not by the source repo's design.

## What shipped (P1 + P2)

- **`frames.js`** — `extractFrames()` (yt-dlp ≤480p → ffmpeg scene-detect + `mpdecimate`
  → **content-aware selection**: score each candidate by JPEG byte size as a detail
  proxy, keep the highest-detail frame per temporal bin, drop blanks → cap 24 →
  contiguous renumber with timestamps), `cleanupFrames()`, `mapFramesError()`.
- **Multimodal digest** — `ClaudeCliProvider` spawns `claude -p --allowedTools Read
  --add-dir <dir>` (keyless local, proven) and `ApiKeyProvider` sends base64 image
  blocks (BYOK). `generateDigest` builds the frame prompt on the single-shot path only.
- **`/api/digest`** — `includeVisuals` best-effort (degrades to text on any failure,
  `finally` cleanup, `blockInWeb`-gated, videoId format-guarded), returns `visualFrames`.
- **Frontend** — opt-in "Include visuals" toggle (local/desktop only), `visualFrames`
  provenance badge, persisted in localStorage.
- **The faithfulness clamp (P2 calibration)** — the single most important tuning.
  Evidence across every test: **fabrications are always NAMES** (MNIST, Noom, Hims,
  Cal.com, Yazio); **genuine wins are always NUMBERS**. So the prompt **encourages
  capturing on-screen numbers/prices/%/stats/dates** (read reliably, high value) and is
  **strict on app/company/person names** (only if plainly printed or in the transcript).
  Verified E2E: numeric density ~2× the text-only baseline, real numbers captured,
  name-fabrication eliminated.

**Runtime gotcha found + fixed:** modern ffmpeg (2026 builds) removed `-vsync` → use
`-fps_mode vfr`. The old flag errored on arg-parse and wrote 0 frames; a too-lenient
`catch` swallowed it. Fixed both. **ffmpeg must be on PATH** (or `ECHO_FFMPEG` set).

**Known residual → P3:** selection favors visually-busy B-roll over narration-*anchored*
stat slides; reliably capturing anchored slides needs transcript↔frame semantic
alignment. Also a `hqdn3d` denoise-before-sizing would sharpen the size heuristic
(camera grain currently inflates talking-head scores). Neither is built.

---

_Original spec below (for reference)._

## Why (and why not always)

The transcript is blind to everything on screen. A digest built from it alone renders
a conversion case study with no numbers ("*more* sign-ups, *fewer* complaints") and a
chart as a shrug. Feeding the digest model **still frames** lets it read what the
narration only gestures at.

**What the tests established:**

- **It works on the keyless LOCAL path.** `claude -p --model sonnet --allowedTools
  Read` ingests local frame images via the Read tool with NO API key — verified 15/15,
  17/17, 15/15 frames read, ~35 s, frames read in parallel. So this is a real local
  feature, not BYOK-only.
- **Value scales with how much a video SHOWS vs SAYS.** Mobbin paywall teardown
  (visual, ASR captions): frames recovered a Blinkist slide's exact `+23% / −55% /
  6%→74%` — all absent from the transcript. 3Blue1Brown (fully narrated, manual
  captions): frames added only a formula and **hallucinated "MNIST."** Net negative.
- **The real hazard is confident fabrication, not wasted tokens.** On the onboarding
  video, frames correctly read `Brian Chesky, CEO` and a `21 vs 26.5 screens` chart —
  but also invented three app names (`Noom`, `Hims`, `Cal.com`) that appear on **no
  frame**, dressed up as "(referred to as X in the transcript)." Cause: the naming
  slides weren't among the sampled frames, and a vision-primed model fills gaps with
  plausible real-world names.

These three findings define the whole design: **opt-in for visual videos, scene-aware
selection (not interval), and a hard faithfulness clamp.**

## Non-goals / hard constraints

- **Web mode never runs this.** Downloading full video + sampling + a multi-image
  agentic digest is a cost-sink with a second heavy dependency. Web keeps today's
  transcript-only digest. Guard like `blockInWeb`.
- **Never break local mode** (project hard constraint). Off unless the user opts in
  per digest.
- **ffmpeg is a hard dependency here** (unlike the optional Whisper case) — frame
  extraction needs it, and we download the *video*, not just audio.
- **Faithfulness is the top priority, above completeness.** A vague-but-true digest
  beats a confident-but-fabricated one. The onboarding test is the cautionary tape.

## New module: `frames.js`

```
extractFrames(videoId, opts) -> Promise<{ dir, frames: [{ path, offsetSec }], count }>
mapFramesError(err)          -> { echoCode, message, hint }
```

`extractFrames` steps (reuse the yt-dlp `execFile` pattern from `transcript.js`):

1. **Download video** at capped resolution into `tmpdir()`:
   `yt-dlp -f "bv*[height<=480]/best[height<=480]" -o <tmp>` — 480p keeps on-screen
   text/charts legible (Claude read 640×360 fine in tests) while staying small
   (~10 MB for a 12-min talk). Read a duration cap first
   (`ECHO_FRAMES_MAX_MINUTES`, default 90) → `VIDEO_TOO_LONG`.
2. **Scene-aware selection — the make-or-break step.** NOT fixed-interval (interval
   is what caused the Test-03 misses). Extract on scene change and de-duplicate:
   `ffmpeg -i <vid> -vf "select='gt(scene,0.30)',mpdecimate,scale=640:-1" -vsync vfr
   -q:v 3 frame-%03d.jpg`. `mpdecimate` drops near-identical frames; the scene filter
   targets slide/cut transitions where the informative screens live. If it yields
   fewer than `MIN_FRAMES` (≈6), lower the threshold and retry; hard-cap at
   `MAX_FRAMES` (default **24** — token control) by even down-sampling.
3. **Return** ordered `{ path, offsetSec }` (offset from ffmpeg `showinfo`/segment
   timing, so the digest can place a frame in time). Always `rm -rf` the tmp dir in a
   `finally`.

Guardrails: overall timeout (`ECHO_FRAMES_TIMEOUT_MS`, default 300 s →
`FRAMES_TIMEOUT`); detect missing ffmpeg up front → `FFMPEG_MISSING` with an install
hint.

## Provider seam change (`providers.js`) — the one real architecture touch

The seam is text-in today: `call(prompt, opts) -> { result, usage }`
(`ClaudeCliProvider` :34, `ApiKeyProvider` :81, `getProvider` :204). Multimodal means
carrying images. Add an optional `opts.frames` and let each provider handle it:

- **`ClaudeCliProvider` (local, keyless — proven path, ship first):** when
  `opts.frames` is present, spawn
  `claude -p --model sonnet --output-format json --allowedTools Read --add-dir <dir>`
  with `cwd=<framesDir>` (keeps the existing tmpdir isolation), and a prompt that
  tells it to `Read` `frame-001.jpg … frame-0NN.jpg`. Parse `.result` from the JSON
  envelope exactly as `runClaude` does now. The Read loop is agentic but batched
  (~35 s in tests).
- **`ApiKeyProvider` (BYOK/desktop):** attach base64 image blocks to the Messages
  request (read the frame files, encode, `type:'image'` blocks before the text). One
  call, no agentic loop, but billed to the key.

`getProvider(opts)` selection is unchanged (key → API, else CLI). Error mapping keeps
producing `{ echoCode, message, hint }` so `sendCaughtError` handles both.

## Digest wiring (`digest.js`)

- `generateDigest(transcriptText, opts)` (:542): if `opts.frames?.length`, build the
  **frame-augmented prompt** (below) and route through the multimodal provider call.
  The transcript stays the backbone; frames are grounding, not a replacement.
- **Map-reduce path** (`> LONG_PATH_THRESHOLD_CHARS`, :36): v1 **skips frames on
  long videos** (aligning 24 frames across N chunks is P3). Long-video digests fall
  back to text-only with a logged note. Frames only augment the single-shot path.
- **The frame prompt = current `structureInstructions` + a frame block + a HARD
  faithfulness clamp.** The clamp is the direct fix for the Test-03 fabrications:

  > You also have N still frames from the video (`frame-001.jpg`…). Read all of them
  > first. They show what was on screen — charts, prices, slides, code, UI. Use them
  > to (a) ground vague references and (b) capture on-screen specifics the transcript
  > omits. **Faithfulness rules, absolute:** state an app name, brand, person, or
  > number ONLY if it is legibly visible in a frame OR present in the transcript. If a
  > frame is generic, or a name/number is not clearly readable, keep the transcript's
  > wording (even if it looks garbled) or describe it generally — NEVER substitute a
  > real-world name or figure you infer from outside knowledge. Do not write
  > "(referred to as X in the transcript)" unless X is plainly what the frame shows.

## Server surface (`server.js`)

- `POST /api/digest` (:675): accept `includeVisuals: boolean`. It already receives
  `videoId`. When `includeVisuals` **and not web** and a resolvable provider: call
  `extractFrames(videoId)` → pass `frames` into `generateDigest`. Runs concurrently
  with the existing `suggestTags` best-effort. **In web mode, ignore `includeVisuals`
  and return the normal text digest** (add `visualsSkipped:true` so the UI can note
  it). Frame failure must **degrade to the text digest**, never fail the whole
  request (mirror the tag-timeout pattern — best-effort, can't reject).
- Response adds `visualFrames: number` (0 when unused) for the UI badge.
- New `ECHO_ERROR_STATUS` codes (:207): `FFMPEG_MISSING→503`,
  `VIDEO_TOO_LONG→422`, `FRAMES_FAILED→502`, `FRAMES_TIMEOUT→504` — used only when
  the user explicitly asked for visuals and we want to tell them why it fell back.

## Frontend (`public/index.html`)

- **Opt-in toggle** by the digest action: "Include on-screen visuals (slides,
  charts, demos)" — local/desktop only, hidden in web. Sends `includeVisuals` on the
  `/api/digest` call. Default off. (Auto-detecting visual videos is P3 — v1 is a
  deliberate user choice, matching the evidence that it only helps a subset.)
- **Progress:** heavier than a normal digest (download + extract + agentic read) —
  drive `setTopIndicator('working')` and a sub-status ("Reading N frames…") so the
  ambient background comes alive.
- **Provenance badge:** "Digest read N on-screen frames" on the result, from
  `visualFrames`. Honesty matters given the fabrication risk — the reader should know
  visuals were used.

## Library (data shape — additive)

Persist `visualFrames` (count) and a `digestUsedVisuals` flag on saved entries so a
re-open shows provenance. Non-breaking; old entries default to text-only.

## Tauri (`src-tauri/tauri.conf.json`)

- Register `frames.js` in `bundle.resources` (:42): `"../frames.js": "frames.js"` —
  or the desktop sidecar crashes `ERR_MODULE_NOT_FOUND` at runtime (`node --test` and
  the bundlers won't catch it; `tests/tauri-bundle.test.js` will — update its list).
- **ffmpeg on desktop:** v1 documents it as a required external tool (like yt-dlp);
  P3 bundles a static ffmpeg via `externalBin` (:39). No new npm dep — CLI path uses
  Read; API path uses native `fetch`/base64.

## Testing

- **Unit** (`node --test`, mock yt-dlp/ffmpeg/provider): frame list shape
  `[{path,offsetSec}]`; `MAX_FRAMES` cap enforced; `mpdecimate`/scene args present;
  web mode forces `includeVisuals:false`; frame failure degrades to text digest (does
  NOT reject); each error → correct `echoCode`; the digest prompt contains the
  faithfulness clamp; map-reduce path skips frames.
- **Bundle-drift:** add `frames.js` to `tests/tauri-bundle.test.js`.
- **Runtime (manual):** the scratchpad harness from the experiment *is* this pipeline
  — reuse it. Re-run the three-video A/B after wiring and confirm the clamp kills the
  `Noom`/`Hims`/`Cal.com`-class fabrications while keeping the `Brian Chesky` /
  `21 vs 26.5` / Blinkist wins.

## Phasing

1. **P1 — local, keyless, proven.** `frames.js` (yt-dlp + scene-aware ffmpeg) +
   `ClaudeCliProvider` multimodal Read-loop + `generateDigest` wiring + the opt-in
   toggle + the faithfulness clamp. Serves the core local user with the exact path
   the tests validated.
2. **P2 — BYOK + polish.** `ApiKeyProvider` base64 path for desktop; provenance
   badge; library `visualFrames`; tuned scene threshold / frame budget.
3. **P3 — reach.** Auto-detect visual videos (cheap heuristic or a 1-frame probe);
   ffmpeg bundled for desktop; map-reduce frame alignment for long videos.

## Open decisions (call before building)

1. **ffmpeg on desktop:** require user-installed (low effort, install friction) vs
   bundle a static build from P1 (heavier artifact, zero friction)? Spec assumes
   **require + document** for P1, bundle in P3.
2. **Frame budget:** `MAX_FRAMES` default — **24** (assumed) balances coverage vs
   token cost; lower (16) is cheaper but risks more Test-03-style misses.
3. **Opt-in vs auto-detect for v1:** spec assumes **pure opt-in** (a toggle). The
   evidence says it only helps visual videos, so forcing a choice is defensible for
   v1; auto-detect is the P3 nicety.
4. **Long videos:** skip frames on the map-reduce path (assumed) vs invest in
   per-chunk frame alignment now.
