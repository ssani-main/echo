# Vendored whisper.cpp binaries

These are **prebuilt** `whisper-cli` binaries + their shared libraries, shipped in the repo and bundled into the Tauri desktop app so local Whisper transcription works turnkey (no `ECHO_WHISPER` env var needed). They are resolved by `whisper.js` `vendoredBin()` as `vendor/whisper/<platform>-<arch>/whisper-cli` (module-relative), gated by `existsSync` — an absent platform degrades cleanly to "off".

## Source

- **Upstream:** whisper.cpp v1.9.1 (repo `ggml-org/whisper.cpp`, release asset `whisper-bin-ubuntu-x64.tar.gz`). Free/open-source (MIT).
- **Verified 2026-07-19:** runs on Arch (glibc floor 2.34); the binary is data-only, no toolchain needed.

## Layout

### linux-x64/ (populated)

- `whisper-cli` — the CLI (the only entrypoint Echo spawns)
- `libwhisper.so.1`, `libggml.so.0`, `libggml-base.so.0` — the binary's direct shared-lib deps
- `libggml-cpu-x64.so` — universal x86-64 baseline CPU backend (runs on any x86-64)
- `libggml-cpu-haswell.so` — AVX2 CPU backend (auto-preferred on any CPU since ~2013 for performance)

**Note:** upstream ships ~16 per-microarch CPU backends (~17 MB total). We ship only the baseline + AVX2 (~4.3 MB): ggml loads the best-scoring backend whose CPU features are present and falls back to `x64` otherwise (verified — with only `x64` present it still loads and runs). `LD_LIBRARY_PATH` is set to this dir at spawn so the `.so` files resolve.

⚠️ **The lean subset has a cost: an AVX-512 machine runs the AVX2 backend**, because the better variant simply isn't shipped. Each backend `.so` carries its own `ggml_backend_score` and the registry (`ggml_backend_load_best`) picks the highest scorer present, so adding `libggml-cpu-skylakex.so` / `icelake` / `alderlake` needs **no code change at all** — the files just have to be in this directory and in `tauri.conf.json` `bundle.resources`. See "Adding the AVX-512 backends" below.

### win32-x64/ (populated)

- `whisper-cli.exe` — the CLI (the only entrypoint Echo spawns)
- `whisper.dll`, `ggml.dll`, `ggml-base.dll` — the binary's direct DLL deps
- `ggml-cpu-x64.dll` — universal x86-64 baseline CPU backend (runs on any x86-64)
- `ggml-cpu-haswell.dll` — AVX2 CPU backend (auto-preferred on any CPU since ~2013 for performance)

**Note:** same lean subset as linux-x64 (baseline + AVX2), extracted from upstream `whisper-bin-x64.zip` (the plain **CPU** build, not the multi-hundred-MB CUDA variants). Windows resolves DLLs from the `.exe`'s own directory by default, so no `LD_LIBRARY_PATH`/`PATH` shim is needed — the DLLs sitting next to `whisper-cli.exe` here just work. **Verified end-to-end 2026-07-23** on win32-x64: `binaryPresent=true` → download model → transcribe → `transcriptSource=whisper` (ggml auto-loaded the haswell/AVX2 backend). Like all platforms, Whisper still needs **ffmpeg on PATH** (yt-dlp extracts the audio to 16 kHz mono WAV before whisper-cli runs).

### Other platforms (not yet populated)

- `darwin-*` — upstream publishes **no** CLI binary, only an xcframework (stays "off" until we build our own)

## Adding the AVX-512 backends

Wider-register backends are the only **lossless** Whisper speedup available — same
model, same decoding parameters, same output, just wider vectors. Everything else
that is faster (smaller beam, fewer candidates, parallel chunks) decodes worse.

```bash
# 1. Fetch the asset MATCHING the vendored version — v1.9.1, per "Source" above.
#    A different build will be refused in step 3, on purpose.
tar xf whisper-bin-ubuntu-x64.tar.gz -C /tmp/whisper-upstream

# 2. Copy in every backend variant not already vendored, and register them
#    with the Tauri bundle.
node tools/vendor-whisper-backends.mjs /tmp/whisper-upstream

# 3. Confirm the dispatch changed on an AVX-512 host:
LD_LIBRARY_PATH=vendor/whisper/linux-x64 ./vendor/whisper/linux-x64/whisper-cli --help | head -2
#    → "load_backend: loaded CPU backend from .../libggml-cpu-skylakex.so"
#      (on an AVX2-only host it will still say haswell — that is correct)
```

**Why the script and not a `cp`.** A backend `.so` is only loadable by the
`libggml.so.0` it was built with. Take one from a different release or a local
build and the mismatch is invisible on an AVX2 machine — the file is never scored
highest, so never loaded — and fails only on the AVX-512 machines you added it
for. The script therefore requires every file the archive shares with this
directory to be **byte-identical** before it copies anything, which is what proves
the archive is the same build. One differing byte and it stops without touching
the vendor dir or `tauri.conf.json`.

Size: the four extra x86-64 variants add ~3.5 MB to the bundle.

## Updating

To bump the version:

1. Download the matching release asset from `ggml-org/whisper.cpp`
2. Copy `whisper-cli` + the same lib set into the platform dir
3. Deref symlinks to real SONAME-named files (e.g. `cp -L libwhisper.so.1`)
4. `chmod +x whisper-cli`
5. Re-verify: `LD_LIBRARY_PATH=<dir> ./whisper-cli --help`
