// Cross-platform replacement for the old POSIX-only `pkg:stage-deps` shell
// one-liner (`rm -rf … && mkdir -p … && cp … && npm install … && rm -f …`).
// `rm -rf`, `mkdir -p`, `cp` and inline `VAR=1 cmd` env prefixes are all
// POSIX-shell-only and fail on Windows, where npm runs package.json scripts
// through cmd.exe — see CLAUDE.md "Windows `.cmd` spawns" for the sibling
// trap this script deliberately avoids (spawning npm's `.cmd` directly with
// `shell:false` throws EINVAL synchronously on Windows).
//
// Behaviour is intentionally IDENTICAL to the old shell command: stage
// package.json + package-lock.json into src-tauri/dist-deps/, install
// production-only deps there, then remove the copied manifests so only
// node_modules/ is left behind for Tauri's bundle.resources to pick up.
import { existsSync, rmSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = join(repoRoot, 'src-tauri', 'dist-deps');

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

copyFileSync(join(repoRoot, 'package.json'), join(stageDir, 'package.json'));
copyFileSync(join(repoRoot, 'package-lock.json'), join(stageDir, 'package-lock.json'));

// npm's own .cmd shim on Windows can't be spawned with shell:false (EINVAL,
// CVE-2024-27980 mitigation) — shell:true with a fixed command STRING (not an
// args array, which Node warns is unescaped under shell:true) is the
// documented-safe route in this repo. Every argument here is a constant, not
// user input, so there is nothing to inject.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const command = `${npmCmd} install --omit=dev --ignore-scripts --no-audit --no-fund --prefix "${stageDir}"`;
const result = spawnSync(command, { stdio: 'inherit', shell: true });

if (result.error) {
  console.error('Failed to run npm install for dependency staging:', result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const f of ['package.json', 'package-lock.json']) {
  const p = join(stageDir, f);
  if (existsSync(p)) unlinkSync(p);
}
