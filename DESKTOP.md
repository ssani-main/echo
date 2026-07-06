# Echo Desktop (Tauri v2)

Echo can be packaged as a native Windows desktop app using Tauri v2. The
desktop shell does **not** reimplement anything — it spawns the existing
Node/Express backend (`server.js`) as a sidecar process and shows its UI in
a native WebView2 window.

## Architecture

```
┌─────────────────────────────┐
│  Tauri window (WebView2)    │
│  loads dist-shell/loading.html
│  → then http://127.0.0.1:<port>/
└──────────────┬──────────────┘
               │ Rust setup() in src-tauri/src/lib.rs
               ▼
    1. find_free_port()            — scans 127.0.0.1 starting at 8737
    2. spawn Node sidecar          — bundled node.exe runs server.js
       env: PORT, ECHO_DB_PATH, ECHO_MODELS_DIR
    3. poll 127.0.0.1:<port>       — until TCP connect succeeds (30s budget)
    4. window.navigate(url)        — swap loading page for the live app
    5. on window close / app exit  — kill the sidecar child process
```

The backend code is completely unmodified except for one additive,
backward-compatible line in `embeddings.js` (see below). The frontend
(`public/`) is untouched — the desktop window simply loads it over HTTP
from the local Node server, exactly like a browser tab does today.

## What was added

- `src-tauri/` — Tauri v2 project (`tauri.conf.json`, `Cargo.toml`,
  `src/main.rs`, `src/lib.rs`, `capabilities/default.json`, `icons/`).
- `src-tauri/dist-shell/loading.html` — the only page ever loaded via
  the `tauri://` asset protocol; a lightweight spinner shown while the
  Node sidecar starts. Everything else in the app is served by the real
  Express server, unchanged.
- `src-tauri/binaries/` — **not committed** (see `.gitignore`). Before
  building, copy your local Node runtime here as
  `node-x86_64-pc-windows-msvc.exe` (Tauri's sidecar naming convention:
  `<name>-<target-triple>.exe`). This was done once during scaffolding
  from `C:\node\node.exe`; re-copy it if that directory is cleaned.
- `package.json` — added `@tauri-apps/cli` / `@tauri-apps/api`
  devDependencies and `tauri:dev` / `tauri:build` npm scripts.
- `embeddings.js` — one additive line: the model cache directory now
  reads `process.env.ECHO_MODELS_DIR` first, falling back to the
  existing `data/models` path when unset (so `npm start` behavior is
  unchanged). The Tauri launcher sets `ECHO_MODELS_DIR` to a writable
  app-data directory, because the bundled resource folder is read-only
  once packaged.

  ```diff
  - const MODEL_CACHE = join(__dirname, 'data', 'models');
  + const MODEL_CACHE = process.env.ECHO_MODELS_DIR || join(__dirname, 'data', 'models');
  ```

## Writable paths at runtime

| Data              | Env var           | Set by Tauri launcher to                          |
|-------------------|--------------------|----------------------------------------------------|
| SQLite library DB | `ECHO_DB_PATH`     | `<app-data dir>/library.db` (already supported by `store.js`) |
| Embedding model cache | `ECHO_MODELS_DIR` | `<app-data dir>/models` |

`<app-data dir>` is resolved via Tauri's `app.path().app_data_dir()`
(Windows: `%APPDATA%/com.echo.reader`, per the `identifier` in
`tauri.conf.json`). Both directories are created on startup if missing.

## LLM provider

The Tauri launcher now sets `ECHO_MODE=desktop` when spawning the sidecar.
The default provider is still the local `claude` CLI (`providers.js` →
`ClaudeCliProvider`) — if it's installed and authenticated on the machine
the app runs on (resolvable on `PATH` from the sidecar's process
environment), AI features (digest, ask, fact-check) work for free with no
extra setup, exactly as before.

Desktop mode additionally enables **optional** bring-your-own-key (BYOK):
a user without the `claude` CLI can add their own Anthropic API key in
Settings, and the frontend sends it as the `X-Echo-Api-Key` header on AI
requests. The server honors that header in desktop mode (see
`readApiKey()` in `server.js`) and uses `ApiKeyProvider` for that request;
keyless requests keep falling through to the CLI provider unchanged. This
mirrors hosted web mode's BYOK support but, unlike web mode, is never
required — desktop keeps full server-side SQLite library access, no rate
limits, and no payload caps regardless of whether a key is set.

`POST /api/validate-key` (Settings' "test key" button) also works in
desktop mode now, not just web mode.

## Build prerequisites

1. **Rust** via [rustup](https://rustup.rs) (stable toolchain,
   `x86_64-pc-windows-msvc` target).
2. **Visual Studio C++ Build Tools 2022** (Desktop development with C++
   workload) — required by the MSVC Rust toolchain on Windows.
3. **WebView2 Runtime** — usually already present on Windows 11; the
   bundle is configured with `webviewInstallMode: downloadBootstrapper`
   so end users without it get prompted to install it automatically.
4. Node.js (already required for the backend itself).
5. `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe` present locally
   (copy your Node runtime there — not committed to git).

None of steps 1–3 are installed on this scaffolding machine, so
`cargo`/`tauri dev`/`tauri build` could not be run or verified here. The
Rust source was written against the documented Tauri v2.11 /
tauri-plugin-shell 2.x APIs but is **unverified until first build** —
see the "Unverified APIs" section below.

## Commands

```bash
npm install                # installs @tauri-apps/cli / @tauri-apps/api (already devDependencies)
npm run tauri:dev          # cargo tauri dev — hot-reload desktop window
npm run tauri:build        # cargo tauri build — produces installer(s) in src-tauri/target/release/bundle/
```

`tauri:dev` uses `devUrl: http://localhost:8000` in `tauri.conf.json`, so
for the dev workflow, run `npm start` in a separate terminal first (or
extend `beforeDevCommand` in `tauri.conf.json` to launch it
automatically) so something is listening on port 8000 when the Tauri
window opens. `tauri:build` does not depend on this — the packaged app
always spawns its own sidecar and picks a free port at runtime.

## Unverified APIs (double-check on first `cargo tauri dev`)

Rust/MSVC is not installed on this machine, so `src-tauri/src/lib.rs`
could not be compiled. Please verify on first build:

- `tauri_plugin_shell::ShellExt::sidecar()` / `.spawn()` return type —
  written as `(Receiver<CommandEvent>, CommandChild)`, matching
  tauri-plugin-shell 2.x docs.
- `CommandChild::kill()` signature/return type.
- `WebviewWindow::navigate(Url)` — written assuming this method exists
  on `tauri::WebviewWindow` in Tauri 2.11; if renamed, the fallback is
  `window.eval(&format!("window.location.replace('{url}')"))`.
- `tauri::Url` re-export — if `tauri::Url` doesn't resolve, add
  `url = "2"` to `Cargo.toml` and use `url::Url::parse` instead.
- The `shell:allow-spawn` permission shape in
  `src-tauri/capabilities/default.json` (sidecar name + `sidecar: true`)
  — confirm this matches the tauri-plugin-shell 2.x permission schema;
  the CLI's `tauri dev`/`tauri build` will fail fast with a clear error
  if the capability shape is wrong.
- Cargo package name was changed from the scaffolded default `app` to
  `echo-desktop` in `Cargo.toml`; confirm the Tauri CLI still resolves
  the correct binary name from this (no `mainBinaryName` override was
  added to `tauri.conf.json`, so Tauri should read it from
  `Cargo.toml`'s `[package] name`).

## Target triple note

The bundled binary was copied as
`node-x86_64-pc-windows-msvc.exe`, matching a standard 64-bit Windows
install. If building on Windows on ARM, re-copy the Node binary as
`node-aarch64-pc-windows-msvc.exe` instead and update
`tauri.conf.json`'s `externalBin` naming expectations accordingly (the
config entry itself, `binaries/node`, does not change — only the
suffixed file on disk does).
