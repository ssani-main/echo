#!/usr/bin/env node
// Expose a locally-running Echo on the public internet via Holesail + Janus.
//
// WHY THIS EXISTS
// ----------------
// Echo's hosted VPS story is dead: transcript fetches are server-side, and
// YouTube bot-blocks the datacenter IP ranges every VPS/Fly/Railway box lives
// on (see CLAUDE.md "Deploy parked"). A residential IP still works, and so
// does the local `claude` CLI (keyless, no BYOK needed) — so the fix is to
// run Echo on a machine that already has both, and tunnel it out. Janus
// (a separate project, live at janus.ssani.dev) turns a Holesail P2P key
// into a public HTTPS URL; this script is the "one command" that starts
// Echo, opens that tunnel, and prints the URL.
//
// WHY tools/, NOT THE REPO ROOT
// ------------------------------
// tests/tauri-bundle.test.js walks the import graph starting at server.js to
// make sure every backend module the desktop sidecar needs is listed in
// src-tauri/tauri.conf.json's bundle.resources. A new root-level module would
// have to join that list or the sidecar would crash looking for it. This
// script is never imported by server.js — it's a standalone dev/self-hosting
// convenience — so living in tools/ keeps it out of that graph entirely.
//
// THE SEED IS A SECRET
// ---------------------
// Holesail derives this tunnel's public key from a seed (see .holesail-seed,
// generated on first run). Anyone holding that seed can regenerate the exact
// same keypair and either impersonate this tunnel or hijack it if it's ever
// reused elsewhere — it is the serving capability, not a cosmetic id.  It's
// written mode 0600 and gitignored; treat it like an API key.
//
// WHY secure:false
// -----------------
// holesail-server's "secure" mode returns a different key form (the seed
// itself, z32-encoded) meant for private, invite-only tunnels. Janus
// deliberately refuses that form — accepting it would mean a public HTTPS
// URL leaks the very secret that lets someone else claim to *be* this
// server. Public mode's key is the DHT public key, safe to hand out.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_PATH = join(REPO_ROOT, '.holesail-seed');
const JANUS_HOST = 'janus.ssani.dev';

/** Read the persisted seed, or mint one so the URL is stable across runs. */
export function getOrCreateSeed(seedPath = SEED_PATH) {
  if (existsSync(seedPath)) {
    return readFileSync(seedPath, 'utf8').trim();
  }
  const seed = randomBytes(32).toString('hex');
  writeFileSync(seedPath, seed, { mode: 0o600 });
  return seed;
}

/** The Janus URL form: literal "0000" prefixed to the key as the leftmost subdomain label. */
export function buildJanusUrl(key) {
  return `https://0000${key}.${JANUS_HOST}/`;
}

/**
 * True unless the mode is exactly "web" — the only mode that both requires
 * BYOK and 503s the server-side library routes.
 *
 * Deliberately fail-SAFE: anything that isn't exactly "web" gets the warning,
 * including "desktop" (full server library, BYOK merely optional) and typos
 * like "Local". server.js:57-58 resolves ECHO_MODE by exact string match and
 * falls back to local for anything unrecognised, so a mode this function
 * didn't recognise is precisely a mode that IS exposing the library.
 */
export function needsSecurityBanner(echoMode) {
  return echoMode !== 'web';
}

/** Poll a TCP connect until something answers, or give up after timeoutMs. */
export function waitForPort(port, host, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port} to accept connections`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}

function spawnEcho(port) {
  console.log(`Starting Echo on port ${port}...`);
  // Ambient env passes ECHO_MODE/ECHO_GOOGLE_*/etc through untouched; only
  // PORT is pinned so the child and the tunnel agree on the same port.
  // ECHO_HOST is deliberately left alone (never forced to 0.0.0.0) — the
  // tunnel connects to 127.0.0.1 itself, so binding wider would needlessly
  // expose Echo on the LAN too.
  return spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  });
}

async function startTunnel({ port, host, seed }) {
  const { default: HolesailServer } = await import('holesail-server');
  const server = new HolesailServer();
  await new Promise((resolve, reject) => {
    server.start({ port, host, udp: false, seed, secure: false }, resolve).catch(reject);
  });
  return server;
}

function printSecurityBanner(echoMode) {
  console.log('\n⚠️  SECURITY WARNING');
  console.log(`   ECHO_MODE is "${echoMode || 'unset (defaults to local)'}" — the URL below has no BYOK`);
  console.log('   requirement and a full server-side library. Anyone who gets this link can');
  console.log("   spend your Claude CLI quota and read/write your entire saved library.");
  console.log('   Mitigate with EITHER of:');
  console.log('     - a per-key password on this tunnel in the Janus admin dashboard, or');
  console.log('     - ECHO_MODE=web (requires visitors to bring their own Anthropic key and');
  console.log('       disables the server-side library routes).');
}

function printUsage() {
  console.log(`Usage: node tools/holesail-serve.mjs [--attach]

Starts Echo (unless --attach) and tunnels it out through Holesail + Janus, so
a link works from a residential IP even though the box running Echo lives on
one — this is the fix for YouTube bot-blocking datacenter IPs on a hosted VPS.

  --attach   Don't spawn Echo — tunnel an instance that's already running.
             Same as setting ECHO_HOLESAIL_ATTACH=1.
  --help     Show this message and exit.

Env:
  PORT                    Port Echo listens on / gets tunnelled to. Default 8000.
  ECHO_MODE               Passed through to the spawned Echo as-is. Unset or
                           "local" prints a security warning before the URL.
  ECHO_HOLESAIL_ATTACH=1  Same as --attach.

The public URL's key comes from a seed persisted at .holesail-seed in the
repo root, so it's stable across runs. That file is a secret (it's the
serving capability for this tunnel) — it's gitignored and written mode 0600.
Delete it to rotate to a fresh, unguessable URL.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const attach = args.includes('--attach') || process.env.ECHO_HOLESAIL_ATTACH === '1';
  const port = Number(process.env.PORT) || 8000;
  const host = '127.0.0.1';
  const echoMode = process.env.ECHO_MODE;

  let child = null;
  let server = null;
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      if (server) await server.destroy();
    } catch (err) {
      console.error(`Error closing the tunnel: ${err.message}`);
    }
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  if (attach) {
    console.log(`--attach: expecting Echo already listening on ${host}:${port}...`);
    try {
      await waitForPort(port, host);
    } catch {
      console.error(`\n✗ Nothing is listening on ${host}:${port} after 30s. Start Echo first, or drop --attach.`);
      process.exitCode = 1;
      return;
    }
  } else {
    child = spawnEcho(port);
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ exited: true, code, signal }));
    });
    const listening = waitForPort(port, host).then(() => ({ exited: false }));
    const result = await Promise.race([listening, exited]);
    if (result.exited) {
      console.error(`\n✗ Echo exited before it started listening (code ${result.code}, signal ${result.signal}). Not opening a tunnel.`);
      process.exitCode = 1;
      return;
    }
  }

  const seed = getOrCreateSeed();
  console.log('Opening Holesail tunnel...');
  try {
    server = await startTunnel({ port, host, seed });
  } catch (err) {
    console.error(`\n✗ Failed to start the Holesail tunnel: ${err.message}`);
    if (child && child.exitCode === null) child.kill('SIGTERM');
    process.exitCode = 1;
    return;
  }

  const key = server.key;
  const url = buildJanusUrl(key);

  if (needsSecurityBanner(echoMode)) printSecurityBanner(echoMode);

  console.log('\n✓ Tunnel established — this URL is stable across restarts (same .holesail-seed):\n');
  console.log(`  key:  ${key}`);
  console.log(`  url:  ${url}`);
  console.log(`  mode: ECHO_MODE=${echoMode || 'local (default)'}\n`);
  console.log('Press Ctrl+C to stop the tunnel' + (attach ? '.' : ' and Echo.'));
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && basename(process.argv[1]) === 'holesail-serve.mjs') {
  main();
}
