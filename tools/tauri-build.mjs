// Cross-platform wrapper for `npm run tauri:build`.
//
// The old script (`NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1 tauri build`) used an
// inline `VAR=1 cmd` env prefix, which is POSIX-shell syntax and is not
// understood by cmd.exe/PowerShell on Windows. It also set two env vars that
// are AppImage/Linux-only (see DESKTOP.md "AppImage bundling also requires
// two env vars…") on every platform, which is harmless on Linux but wrong in
// spirit anywhere else.
//
// This script stages production deps (tools/stage-deps.mjs), then spawns
// `tauri build`, setting NO_STRIP/APPIMAGE_EXTRACT_AND_RUN only when actually
// building on Linux.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const stage = spawnSync(process.execPath, [join(repoRoot, 'tools', 'stage-deps.mjs')], {
  stdio: 'inherit',
});
if (stage.error) {
  console.error('Failed to stage production dependencies:', stage.error);
  process.exit(1);
}
if (stage.status !== 0) {
  process.exit(stage.status ?? 1);
}

const env = { ...process.env };
if (process.platform === 'linux') {
  // linuxdeploy is itself an AppImage (needs APPIMAGE_EXTRACT_AND_RUN where
  // FUSE is unavailable, e.g. CI/containers) and ships an old `strip` that
  // fails on modern .relr.dyn sections (needs NO_STRIP). Neither applies to
  // the .msi/.exe or .dmg/.app bundlers on other platforms.
  env.NO_STRIP = '1';
  env.APPIMAGE_EXTRACT_AND_RUN = '1';
}

// `tauri` resolves to the local @tauri-apps/cli bin via npx-style shell
// resolution; shell:true with a fixed command string (not an args array,
// which Node warns is unescaped under shell:true) keeps this working with
// the platform's .cmd/.ps1 shim on Windows without hitting the
// spawn('*.cmd', {shell:false}) EINVAL trap documented in CLAUDE.md.
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const build = spawnSync(`${npxCmd} tauri build`, { stdio: 'inherit', shell: true, env, cwd: repoRoot });
if (build.error) {
  console.error('Failed to run tauri build:', build.error);
  process.exit(1);
}
process.exit(build.status ?? 1);
