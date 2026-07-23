# Whisper transcription — spec

**Status:** P1 + P2 + P3 built & verified (2026-07-19) — local Whisper is turnkey on Linux x64 (vendored binary, no env var). **Windows x64 binary vendored + verified E2E 2026-07-23** (`vendor/whisper/win32-x64/`, no env var). Remaining: macOS (no upstream CLI). **Scope:** local/desktop only — never web.
**This is a rewrite.** The previous spec proposed **hosted** Whisper (Groq/OpenAI,
BYO key). That is **rejected**. The decision is **local whisper.cpp via a vendored
prebuilt binary**. Rationale below — read "The decision" before implementing, because
the load-bearing reason is not the one you'd guess.

## Why the feature at all

Two problems, one mechanism.

1. **Dead-end today.** When a video has no captions, `fetchTranscript` throws
   `TRANSCRIPT_UNAVAILABLE` (`transcript.js:390–397`) and the flow stops. Whisper
   gives us a transcript where none existed.
2. **ASR captions are low quality.** YouTube auto-generated captions have no
   punctuation, no capitalization, homophone errors, and run-on structure.
   Whisper produces clean, punctuated text.
   **Better transcript → better digest → more accurate "what's being discussed."**

The transcript is the raw material for *every* downstream feature (digest, tags,
enrich, find-in-transcript, share). Improving it improves all of them at once.
Digest quality rises with **zero digest code change** — the win is entirely in the
input text. Bonus: clean sentence boundaries make `chunkText` (`digest.js`,
newline-based) split map-reduce chunks more cleanly on long videos.

## The decision

**Local whisper.cpp, vendored prebuilt binary. No hosted STT. No Node bindings.**

### What was rejected, and why

**Hosted STT (Groq / OpenAI) — rejected.** Not on cost. Groq
`whisper-large-v3-turbo` is ~**$0.04/hr** of audio with an 8 hrs/day free tier —
too cheap to be worth monetizing. It was rejected on two other grounds:

- **It forces a second API key.** **Anthropic has no audio input at all** —
  verified: their OpenAI-compatibility layer explicitly strips audio, and their own
  cookbook routes STT through a third party. So there is no "reuse the key the user
  already has" path. A second key is real onboarding friction and a **different
  privacy posture**: it means uploading the user's audio to a third party, which is
  not what a local-first tool should do by default.
- **It wouldn't work on the server anyway.** See the web-mode gate below — this is
  the load-bearing constraint, not a policy preference.

**Node bindings — all rejected.** Every one needs a C++ toolchain at install time,
violating the repo's no-native-deps constraint (the same constraint that put us on
`node:sqlite` instead of `better-sqlite3` — the user has no C++ build tools).

| Package | Verdict |
|---|---|
| `nodejs-whisper` (0.3.0, 6.9k DL/wk) | runs cmake at first use; 2.5-year Windows scar trail, issue #178 open since 2025-03-13 |
| `smart-whisper` (0.8.1) | unmaintained since Oct 2024. README claims Windows "without external tools"; the manifest runs `node-gyp rebuild`. **The claim is false.** |
| `whisper-node` (1.1.1, 2023) | abandoned |
| `@lumen-labs-dev/whisper-node` | **do not use.** All 15 versions published in one 24-hour burst 2025-09-28, solo maintainer, executes downloaded `.exe`s at install. Wrong supply-chain shape. |
| whisper.cpp `examples/addon.node` | a cmake-js demo, not a product |
| `@remotion/install-whisper-cpp` | **reference implementation only, not a dependency.** Windows-only prebuilt; macOS/Linux paths `git clone` + `make`; CJS with React peer deps. Read it for the download/verify flow, don't install it. |

### What we chose

**whisper.cpp v1.9.1** (2026-06-19, repo `ggml-org/whisper.cpp`). Repo is healthy:
51.8k stars, last commit 2026-07-11. Every release attaches
**`whisper-bin-x64.zip`** (7.6 MB, 34.6k downloads) containing a **real `.exe` with
no toolchain required**:

- `Release/whisper-cli.exe` (0.46 MB)
- `Release/whisper.dll`
- 9 × `ggml-cpu-*.dll` (microarch dispatch variants — ship all of them)

> ⚠️ **Path contradiction — verify on implement.** The zip lays the binary out at
> `Release/whisper-cli.exe`. Remotion's installer expects `build/bin/whisper-cli.exe`.
> We could not resolve which is authoritative across versions. **Unzip v1.9.1 and look**
> before hard-coding either path; probe both.

This is free, matches the local-first ethos, adds **no npm dependency**, and keeps
the user's audio on the user's machine.

## Non-goals / hard constraints

- **Web mode never runs Whisper** — and the reason is technical, not policy. See below.
- **No new npm dependency.** Spawn the binary with the existing `execFile` pattern.
- **Never break local mode** (project hard constraint). Strictly additive, off unless
  the binary + model are present.
- **Transcript shape is sacred.** Whisper must return the exact existing shape —
  `[{ text, offset }]` (offset = **seconds**) with a **non-enumerable `langUsed`**
  stamped via `Object.defineProperty` — so chunking (`digest.js`), the web-mode char
  cap (`server.js:520`), find-in-transcript, jump-to-time, and library save all keep
  working untouched. Copy the stamping idiom from `fetchViaPackage`
  (`transcript.js:138`).
- **ffmpeg becomes a hard requirement for this feature.** Today it's only needed by
  `frames.js`. whisper.cpp requires 16 kHz mono 16-bit WAV *specifically*
  (whisper.cpp issue #909), and only ffmpeg gets us there.

## Web-mode gate — the real reason

Guard with `blockInWeb` (`server.js:448`), **but the reason is not cost or policy:**

**yt-dlp's PO tokens are bound to the originating IP/network, and audio streams
(`gvs` tokens) are gated harder than captions (`subs`).** Audio downloads break from
a datacenter IP. **Hosted Whisper wouldn't work even if we paid for it, because the
server can't reliably get the audio bytes in the first place.** This is the
load-bearing constraint. Web keeps today's behaviour: captions, or the dead-end.

Do not "fix" this by re-litigating the hosted-STT decision — the blocker is upstream
of the STT provider.

## Model choice

Models live at HF repo **`ggerganov/whisper.cpp`** — **not** `ggml-org/*`, which
404s on HF despite being the GitHub org. Easy mistake; it will waste an hour.

| model | f16 | q5 | RAM |
|---|---|---|---|
| base | 141 MB | **57 MB** | ~388 MB |
| small | 465 MB | **181 MB** | ~852 MB |
| medium | 1463 MB | 514 MB | ~2.1 GB |
| large-v3 | 2952 MB | 1031 MB | ~3.9 GB |
| large-v3-turbo | 1549 MB | 547 MB | *never published* |

**Default: `small` q5 (181 MB). Fast tier: `base` q5 (57 MB).**

### Speed (CPU, i7-11800H 8-core, per hour of audio)

| model | realistic end-to-end |
|---|---|
| base | ~2–3 min |
| small | ~6–9 min |
| medium | ~17–27 min |
| large | ~32–52 min |

⚠️ **These numbers are DERIVED, not measured**: the repo's encoder-only benchmark
(issue #89) × 1.5–2.5. The official whisper.cpp table is **encoder-only, 30-second
window, with no realtime multiples** — it does not tell you how long an hour of audio
takes, and people misread it constantly. Stated here so nobody re-misreads it.

📏 **MEASURED (2026-07-18) — the derived table is badly optimistic.** `small` q5 on a 12-core box transcribed the 26:23 test video (`GRzaq5AHiV8`, Indonesian) in **23m 01s** — i.e. **~52 min per hour of audio (~0.87× realtime)**, roughly **6–8× slower** than the ~6–9 min/hr derived above. Implications: (1) `small` in `always` mode means a ~23-min wait on a half-hour video — impractical; (2) this argues for **`base` q5 as the sensible default**, not `small`; (3) derive the op timeout from duration, never a fixed value. `base`/`medium`/`large` on this box remain unmeasured.

### ⚠️ The turbo trap — the single biggest gotcha

`large-v3-turbo`'s famous **"8× faster" is a GPU result.** Turbo is large-v3's
encoder **unchanged** (32 layers) with the decoder cut 32→4. **On CPU the encoder
dominates** — so turbo should land near large-v3 (**~30–50 min/hr**), roughly **5×
worse than `small`**, for marginal accuracy gain.

**It is the obvious pick and it is wrong here.** Nobody has published a turbo CPU
benchmark (repo search: zero results), so this is reasoning, not measurement. If
turbo-on-CPU ever becomes load-bearing, **benchmark it** — `whisper-bench.exe` ships
inside the same zip.

## Three transcript tiers (one setting)

`whisperMode`, threaded through `/api/transcript` as `transcribe`. There is no key to
configure any more, so **the gate is "is the binary + model present?"** — not "is a
key set?".

| mode | behaviour | default |
|---|---|---|
| `off` | never use Whisper — today's behaviour | when the binary/model is **absent** |
| `fallback` | Whisper **only** when captions are missing (fills the dead-end) | when the binary/model is **present** |
| `always` | Whisper even when captions exist — the accuracy upgrade | opt-in |

**Why `fallback` and not `always` by default:** the cost is no longer money, it's
**wall-clock**. `always` turns a sub-second caption fetch into ~6–9 min for a 1-hour
video on the default `small` model. That is a bad default surprise. `always` is the
quality play and stays an explicit opt-in.

## New module: `whisper.js`

```
transcribeViaWhisper(videoId, opts) -> Promise<[{text, offset}]>   // + langUsed stamped
resolveWhisper(opts)                -> { binPath, modelPath } | null
mapWhisperError(err)                -> { echoCode, message, hint }
```

**Binary discovery follows the existing `frames.js` convention** (`frames.js:31–32`,
`opts.ffmpegPath || process.env.ECHO_FFMPEG || 'ffmpeg'`). Mirror it exactly:

```
opts.whisperPath || process.env.ECHO_WHISPER || <vendored path> || 'whisper-cli'
opts.modelPath   || process.env.ECHO_WHISPER_MODEL || <cache path>
```

### Pipeline

1. **Duration guard** — cheap `yt-dlp --print '%(duration)s'` probe first (copy
   `frames.js:41–61`). Over `ECHO_WHISPER_MAX_MINUTES` (default 180) →
   `WHISPER_AUDIO_TOO_LONG`. Given the speed table, consider surfacing the estimate
   to the UI rather than only rejecting.

2. **Download + convert audio** in one yt-dlp call into an `fs.mkdtemp` dir:

   ```
   yt-dlp -f "wa/ba[abr<50]/ba" -x --audio-format wav \
     --postprocessor-args "ExtractAudio:-ar 16000 -ac 1 -c:a pcm_s16le" \
     -o "audio.%(ext)s" URL
   ```

   **Measured against the project's own test video `GRzaq5AHiV8` (26:23):**
   - Smallest useful format is **139 m4a, 49k AAC-HE 22 kHz ≈ 22 MB/hour**.
   - Plain `-f ba` picks format 251 — **2.4× the bytes for zero Whisper benefit**
     (everything above ~48k is discarded at 16 kHz anyway).
   - `-f "wa"` selects the same as `ba[abr<50]`; the chain is belt-and-braces.
   - Download of 1 hr ≈ **5 seconds** on a residential connection.

   **Gotcha:** `-x` does **not** work with `-o -` — postprocessors need a real file
   on disk. You cannot stream this leg.

   **The WAV is the expensive artifact: 16 kHz mono 16-bit = ~115 MB/hour, ~5× the
   download.** Feed it to whisper-cli and delete it. **Never cache it.** `rm -rf` the
   temp dir in a `finally` (copy `cleanupFrames`, `frames.js:383`).

3. **Transcribe** — spawn `whisper-cli` with JSON output and segment timestamps
   (the whisper.cpp equivalent of `response_format=verbose_json`). Point it at the
   model file and the WAV.

4. **Map to Echo's shape** — `segments[] → { text: seg.text.trim(), offset: startSec }`.
   whisper.cpp's `-oj` JSON gives per-segment `offsets.{from,to}` in **milliseconds**
   (confirmed 2026-07-18), so `offset = seg.offsets.from / 1000`. Then stamp `langUsed`
   non-enumerably.

Guardrails: overall op timeout `ECHO_WHISPER_TIMEOUT_MS` — **default it generously
(≥30 min) and derive it from duration**, because unlike the frames path the work here
is legitimately minutes-long → `WHISPER_TIMEOUT`.

## Integration point — the exact hook site

**One hook only**, in `fetchTranscript` (`transcript.js:359`), in the `catch (ytDlpErr)`
block, **immediately before the `TRANSCRIPT_UNAVAILABLE` throw** — i.e. after *both*
the package fetcher and the yt-dlp caption fallback have failed. The real code today:

```js
    // Both methods failed — video likely has no captions or is inaccessible
    const e = new Error(
      `Could not fetch transcript. ` +
      `Primary: ${primaryError.message}. ` +
      `Fallback (yt-dlp): ${ytDlpErr.message}`
    );
    e.echoCode = 'TRANSCRIPT_UNAVAILABLE';
    e.hint = 'The video may have captions disabled, be private, age-restricted, or unavailable in your region.';
    throw e;
```

Insert before that: if `opts.transcribe !== 'off'`, `resolveWhisper()` returns
non-null, and we're not in web mode → `return await transcribeViaWhisper(videoId, opts)`.
On Whisper failure, **fall through to the original `TRANSCRIPT_UNAVAILABLE`** with an
appended hint — never replace the user-meaningful error with an internal one.

**`always` mode** hooks at the **top** of `fetchTranscript`: if
`opts.transcribe === 'always'` and Whisper resolves and not web → go straight to
Whisper, skipping the caption fetch entirely.

## Binary + model acquisition and caching

This is the part with real product surface, and it needs a decision, not a shrug.

**The binary** (7.6 MB) is small enough to **vendor** — ship it in the repo /
Tauri bundle. No first-run step.

**The model is the problem.** `small` q5 is **181 MB**. Shipping it inside the
installer bloats the artifact ~180 MB for a feature most users may never trigger.

**IMPLEMENTED (P2, 2026-07-19): download on first use, not at install.**

- First-run shows an **explicit consent step** when the feature is triggered.
- Downloads to a **stable per-user cache dir** (overridable via `ECHO_WHISPER_MODEL_DIR`; survives reboots and app updates).
- **Shows progress** via sub-status indicator during download.
- **Verifies downloads** (size + sha256 checksum) before first use; partial/corrupt files are re-downloadable.
- **Default: `base` q5** (57 MB, ~3× faster than `small`) as the sensible default; `small` q5 (181 MB, better accuracy) available as a settings option.

**The binary** (whisper-cli, ~0.5 MB) is now **VENDORED in-repo** (`vendor/whisper/<platform>-<arch>/`) for **Linux x64 and Windows x64** and discovered module-relative via `vendoredBin()` — **no env var needed when the prebuilt exists**. Override via `process.env.ECHO_WHISPER` (checked first) or platform/arch probe. macOS remains env-configured only (no CLI upstream).

## Server surface (`server.js`)

- `POST /api/transcript` (`:497`): accept `transcribe` in the body; pass
  `{ transcribe }` into `fetchTranscript`. **In web mode, force `transcribe:'off'`**
  regardless of body. Add `transcriptSource: 'captions'|'whisper'` to the response.
  **No key header** — there is no key. (The old spec's `readWhisperKey` /
  `X-Echo-Whisper-Key` / `/api/validate-whisper-key` are all deleted with the hosted
  decision. Good riddance: the frontend transcript fetch stays a plain `fetch`.)
- New `ECHO_ERROR_STATUS` codes (`:208`): `WHISPER_MISSING→503`,
  `WHISPER_MODEL_MISSING→503`, `WHISPER_FAILED→502`, `WHISPER_AUDIO_TOO_LONG→422`,
  `WHISPER_TIMEOUT→504`. **`FFMPEG_MISSING→503` and `YTDLP_MISSING→503` already
  exist** (`:214`, `:221`) — reuse them, don't add duplicates.
- `mapWhisperError` follows `mapFramesError` (`frames.js:396`) exactly: `err.echoCode`
  passthrough, then **`ENOENT` + binary-name detection** (`err.code === 'ENOENT' &&
  /whisper/i.test((err.path || '') + message)`) → `{ echoCode, message, hint }`, so
  `sendCaughtError` (`:250`) handles them unchanged.

## Frontend (`public/index.html`)

- **Settings → "Transcription (advanced)"** (local/desktop only, hidden in web): mode
  select (Off / Fallback / High-accuracy), model select (small / base), model
  download+status affordance. No key input.
- **Source badge** on reader + digest: "Transcript: Whisper" vs "YouTube captions",
  from `transcriptSource`.
- **Progress is not optional here.** This is minutes, not the sub-second caption
  fetch. `setTopIndicator('working')` plus a real sub-status (model download %,
  then "Transcribing…"). A silent multi-minute wait will read as a crash.

## Library (data shape — additive)

Persist `transcriptSource` (and optionally `whisperModel`) on saved entries so a
re-open knows the transcript's provenance. Non-breaking; old entries default to
`'captions'`.

## Platform support matrix

| platform | whisper.cpp prebuilt CLI | status |
|---|---|---|
| Windows x64 | ✅ **VENDORED** (`vendor/whisper/win32-x64/` — same lean subset: whisper-cli.exe + whisper/ggml/ggml-base DLLs + x64 baseline + haswell AVX2 backends, from `whisper-bin-x64.zip`) | **turnkey** (no env var; DLLs resolve from the .exe's own dir — no PATH shim). Verified E2E 2026-07-23 |
| macOS | ❌ **not published** — releases ship an **xcframework only**, not a CLI binary | **OPEN** |
| Linux x64 | ✅ **VENDORED** (`vendor/whisper/linux-x64/` — lean 4.3 MB subset: whisper-cli + libwhisper/libggml/libggml-base + x64 baseline + haswell AVX2 backends) | **turnkey** (no env var needed; module-relative + per-platform/arch resolution via `vendoredBin()`) |
| Linux arm64 | ✅ `whisper-bin-ubuntu-arm64.tar.gz` (4.6 MB) — published, untested | published |

✅ **Linux x64 is DONE (P3, 2026-07-19).** Prebuilt `whisper-cli` + `.so` libs are **vendored in-repo** (`vendor/whisper/linux-x64/`) as a lean ~4.3 MB subset of upstream's ~17 MB (x64 baseline + haswell AVX2, ggml falls back automatically on unsupported micros). Binary is discovered **module-relative** (works under `npm start` and Tauri sidecar) and **per platform+arch** via `vendoredBin()`, gated by `existsSync` — no env var needed when present. Bundled into Tauri via `bundle.resources` (6 files). Verified end-to-end: zero env vars → `/api/whisper/status` binaryPresent=true → download model → transcribe → transcriptSource=whisper.

✅ **Windows x64 is DONE (2026-07-23).** Prebuilt `whisper-cli.exe` + DLLs (whisper, ggml, ggml-base + x64/haswell backends, 6 files) are **vendored in-repo** (`vendor/whisper/win32-x64/`), extracted from upstream's plain **CPU** `whisper-bin-x64.zip` (not the CUDA builds). Discovered module-relative + per-platform/arch via `vendoredBin()`, gated by `existsSync` — no env var needed. Windows loads the DLLs from the `.exe`'s own directory automatically (no `PATH`/`LD_LIBRARY_PATH` shim). Verified end-to-end: `binaryPresent=true` → download model → transcribe → `transcriptSource=whisper` on both `base` and `small`. **ffmpeg must be on PATH** (same requirement as every platform — yt-dlp needs it for audio extraction).

🚩 **macOS remains open.** **macOS publishes no CLI binary** — only xcframework. The honest options: build+host our own binary, or **degrade cleanly to `off`** on macOS (the feature is additive; absent binary → today's behaviour, which is a correct outcome, not a bug).

## Tauri (`src-tauri/tauri.conf.json`)

- **Register `whisper.js` in `bundle.resources`** (`:42`): `"../whisper.js": "whisper.js"`.
  Miss this and the desktop sidecar crashes at runtime with `ERR_MODULE_NOT_FOUND` —
  and neither `node --test` nor the `.deb`/`.rpm` bundlers catch it (they don't start
  the backend). `tests/tauri-bundle.test.js` **does** guard it, and it derives the
  expected list by walking `server.js`'s import graph — so it needs **no manual list
  update**, it will simply fail until you add the conf entry.
- **The binary + libs** are **IMPLEMENTED for linux-x64:** `vendor/whisper/linux-x64/whisper-cli` + 4 `.so` files (libwhisper, libggml, libggml-base + x64/haswell backends) registered in `bundle.resources` (6 files total). The **win32-x64 binary is vendored in-repo** and works under `npm start`, but is **not yet wired into a Windows Tauri bundle** (`bundle.resources` lists only the linux `.so` set, and there is no Windows installer yet — see DESKTOP.md). Adding a Windows desktop build later must register `vendor/whisper/win32-x64/*` in `bundle.resources`. macOS remains per-platform as described above.
- **The model does not ship** (see acquisition, above) — that's the whole point of the
  first-run download.
- Still **no new npm dep** to add to `dist-deps`.

## Testing

**`node --test` never spawns real binaries** (project gotcha) — so **unit tests must
not depend on whisper-cli, yt-dlp, ffmpeg, or a downloaded model existing.** Mock the
spawns.

- **Unit:** output shape `[{text,offset}]`; offsets in **seconds**; `langUsed` stamped
  and **non-enumerable**; web mode forces `off`; `resolveWhisper` returns null → mode
  degrades to `off`; each error → correct `echoCode` (incl. `ENOENT`+`whisper` →
  `WHISPER_MISSING`); `always` skips the caption fetch; `fallback` fires **only** after
  both caption paths fail; temp dir removed on both success and failure paths.
- **Bundle-drift:** `tests/tauri-bundle.test.js` covers it automatically once
  `whisper.js` is imported by the backend — just make sure it's green.
- **Runtime (manual, external-dep-blocked — the tests above prove nothing about
  this):**
  1. Unzip v1.9.1, resolve the `Release/` vs `build/bin/` path question, run
     `whisper-cli.exe` by hand on a real WAV.
  2. `GRzaq5AHiV8` end-to-end: yt-dlp → WAV → whisper-cli → transcript → digest.
     **Time it** and check the derived speed table against reality.
  3. A no-caption video → confirms the dead-end is actually filled.
  4. An `always` A/B on a video with bad ASR captions → confirm the digest sharpens.
     **This is the whole thesis of the accuracy tier — verify it, don't assume it.**

## Phasing

1. ✅ **DONE (2026-07-19)** — **P1 — fill the dead-end.** `whisper.js` + `fallback`/`always`
   hooks + env-configured binary and model (`ECHO_WHISPER`, `ECHO_WHISPER_MODEL`), no UI,
   no auto-download. Implemented: `whisper.js` module + `fetchTranscript` fallback/always
   hooks + `/api/transcript` `transcribe` param + `transcriptSource` in response + 23 unit
   tests, E2E verified (315/315 tests green). Smallest slice that proves the pipeline.
2. ✅ **DONE (2026-07-19)** — **P2 — make it a product.** Model auto-download + consent + progress + cache; Settings UI; `always` mode; source badge; `transcriptSource` in the library. Implemented: `whisperModel.js` model download+cache+sha256 verify+atomic rename to per-user cache dir, Settings "Transcription" panel (Off/Fallback/High-accuracy + base/small model + Download button + progress), transcript source badge ("Whisper"/"YouTube captions"), library persistence of `transcriptSource`/`whisperModel`; base q5 default. Tests 332/332 green, E2E verified (status → 57 MB download → sha256 verified → transcribe → transcriptSource=whisper).
3. ✅ **DONE (2026-07-19)** — **P3 — reach.** Binary vendoring + Tauri bundling (Linux x64). Implemented: prebuilt `whisper-cli` + 4 lean `.so` libs vendored in `vendor/whisper/linux-x64/` (4.3 MB, whisper.cpp v1.9.1 x64 baseline + haswell AVX2 backends), module-relative discovery via `vendoredBin()` per platform+arch, 6 files bundled into Tauri via `bundle.resources`, turnkey verified (no env var). **Remaining:** Windows binary vendoring (mechanical, not yet done) + macOS (no upstream CLI, degrades to off).

## Open questions / verify-on-implement

1. 🚩 **macOS binary.** macOS publishes **no CLI binary** (xcframework only). **Linux is RESOLVED (2026-07-18):** `whisper-bin-ubuntu-x64.tar.gz` ships a real `whisper-cli` + `.so` libs that runs on Arch out of the box (glibc floor 2.34; host 2.43). Only macOS remains — build our own, or degrade to `off`. Blocks macOS ship only.
2. 🚩 **The zip's binary path.** `Release/whisper-cli.exe` (what the zip contains) vs
   `build/bin/whisper-cli.exe` (what Remotion's installer expects). Unresolved.
   **Unzip v1.9.1 and look.** Probe both paths.
3. ✅ **Model acquisition — DECIDED (P2, 2026-07-19).** Download on first use with explicit consent. **Default: `base` q5** (57 MB, ~3× faster than `small`); `small` q5 (181 MB, better accuracy) available as a settings option. Implemented in `whisperModel.js` with sha256 verification, atomic rename, and per-user cache dir overridable via `ECHO_WHISPER_MODEL_DIR`.
4. **Turbo on CPU is unbenchmarked.** The ~30–50 min/hr figure is *reasoning from
   architecture* (encoder unchanged, decoder cut, encoder dominates on CPU), not
   measurement — nobody has published one. If it ever matters, run `whisper-bench.exe`
   from the same zip. Don't let "8× faster" back into the conversation unmeasured.
5. **The speed table is mostly derived** (issue #89 encoder-only × 1.5–2.5). **`small` q5 is now MEASURED (2026-07-18): ~52 min/hr (~0.87× realtime) on a 12-core box — 6–8× slower than derived, so reconsider `base` as default.** `base`/`medium`/`large` remain derived; measure them the same way.
6. **whisper.cpp timestamp units — RESOLVED (2026-07-18): MILLISECONDS.** The `-oj` JSON emits `transcription[].offsets.{from,to}` in **ms** (e.g. `4380` ↔ `00:00:04,380`). Echo's shape needs **seconds**, so map `offset = seg.offsets.from / 1000`.
7. **Default model.** Spec assumes `small` q5 (best accuracy/speed/size balance).
   `base` q5 is 3× faster and 3× smaller with worse accuracy. Only real usage decides.
8. **Timeout policy.** A fixed `ECHO_WHISPER_TIMEOUT_MS` will be wrong at both ends
   (a 5-min video and a 3-hr video). Spec suggests deriving from duration. Unvalidated.
9. **`ffmpeg` now hard-required** for a *transcript* — previously only a *digest*
   nicety. Does that change the install story enough to justify bundling ffmpeg for
   desktop (deferred to P3 in [`FRAMES.md`](FRAMES.md))? Two features now want it.
