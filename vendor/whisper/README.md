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

### Other platforms (not yet populated)

- `win32-x64` — upstream `whisper-bin-x64.zip` ships a real `.exe` (droppable here later)
- `darwin-*` — upstream publishes **no** CLI binary, only an xcframework (stays "off" until we build our own)

## Updating

To bump the version:

1. Download the matching release asset from `ggml-org/whisper.cpp`
2. Copy `whisper-cli` + the same lib set into the platform dir
3. Deref symlinks to real SONAME-named files (e.g. `cp -L libwhisper.so.1`)
4. `chmod +x whisper-cli`
5. Re-verify: `LD_LIBRARY_PATH=<dir> ./whisper-cli --help`
