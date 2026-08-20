import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The map phase of digestMapReduce() used a bare `Promise.all` over every
// chunk, so a transcript past LONG_PATH_THRESHOLD_CHARS spawned one provider
// call per chunk at once. Harmless on the keyless CLI path, but desktop mode
// supports BYOK, so a long transcript meant ~10 simultaneous calls against the
// user's own key and a fistful of 429s. It is a bounded worker pool now.
//
// Three properties have to hold and none is visible to a contract test: the
// pool must never exceed the cap; results must stay in CHUNK ORDER (the
// summaries are concatenated into the reduce prompt, so a shuffle silently
// scrambles the digest's narrative rather than failing); and an abort must
// still reject instead of draining the queue.
//
// Every existing test over this path is marked POSIX-only and SKIPS on Windows
// — 15 of them, i.e. all of the abort and streaming coverage — so this file
// drives the real spawn path on BOTH platforms by putting a fake `claude`
// earlier on PATH. On Windows digest.js spawns `cmd.exe /c claude`, which
// resolves `claude.cmd`; elsewhere it spawns `claude` directly.
// ---------------------------------------------------------------------------

const isWin = process.platform === 'win32';

// The fake CLI, as a standalone module. It reads the prompt digest.js writes to
// stdin, records its own lifetime so the test can reconstruct overlap, waits
// for the rest of its wave to be in flight so that overlap is a fact rather
// than a race, then emits the same success envelope the real CLI emits under
// `--output-format json`.
//
// Kept as a plain string rather than a template literal so the regex below is
// not fighting two levels of escaping.
const FAKE_RUNNER = [
  "import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';",
  "const LOG = process.env.FAKE_CLAUDE_LOG;",
  "const PROMPTS = process.env.FAKE_CLAUDE_PROMPTS;",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (d) => { input += d; });",
  "process.stdin.on('end', async () => {",
  // digest.js's map prompt says "chunk N of M" — recover N so the test can
  // check the summaries come back in the order the chunks went in. The reduce
  // prompt has no such marker, so it lands as 'reduce'.
  "  const m = input.match(/chunk (\\d+) of (\\d+)/);",
  "  const n = m ? m[1] : 'reduce';",
  "  const total = m ? Number(m[2]) : 1;",
  "  if (n === 'reduce') writeFileSync(PROMPTS, input);",
  "  appendFileSync(LOG, 'start ' + n + ' ' + Date.now() + '\\n');",
  // Hold until the rest of this chunk's wave is live, THEN sleep. A fixed
  // sleep alone measured how fast this machine spawns processes, not the
  // pool: under full-suite load a Windows `cmd.exe /c node` bootstrap costs
  // more than 150 ms, so early calls had already exited before later ones
  // logged their start and the observed peak collapsed to 2 at a cap of 6.
  // With the barrier, every wave is a wave by construction and the peak is a
  // property of runWithConcurrency. The pool dispatches in order and each
  // wave releases together, so chunk n sits in wave floor((n-1)/cap) and the
  // final short wave waits for nobody. The deadline only exists so a
  // pathological host degrades to the old timing instead of hanging.
  "  const cap = Number(process.env.ECHO_DIGEST_MAP_CONCURRENCY) || 3;",
  "  const wave = n === 'reduce' ? 0 : Math.floor((Number(n) - 1) / cap);",
  "  const target = n === 'reduce' ? 1 : Math.min(cap, total - wave * cap);",
  "  const deadline = Date.now() + 5000;",
  "  for (;;) {",
  "    let live = 0;",
  "    try {",
  "      for (const line of readFileSync(LOG, 'utf8').split('\\n')) {",
  "        if (line.startsWith('start')) live++;",
  "        else if (line.startsWith('end')) live--;",
  "      }",
  "    } catch (_) { live = 0; }",
  "    if (live >= target || Date.now() > deadline) break;",
  "    await new Promise((r) => setTimeout(r, 10));",
  "  }",
  // Kept on top of the barrier: the abort test needs the first wave to still
  // be in flight when it fires, and a barrier that released instantly would
  // let the pool race on to the next wave first.
  "  await new Promise((r) => setTimeout(r, 150));",
  "  appendFileSync(LOG, 'end ' + n + ' ' + Date.now() + '\\n');",
  "  process.stdout.write(JSON.stringify({",
  "    subtype: 'success',",
  "    is_error: false,",
  "    result: n === 'reduce' ? 'FINAL DIGEST' : 'SUMMARY_OF_CHUNK_' + n,",
  "    usage: { input_tokens: 1, output_tokens: 1 },",
  "    total_cost_usd: 0,",
  "    duration_ms: 150,",
  "  }));",
  "});",
].join('\n');

function installFakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'echo-fakeclaude-'));
  const logPath = join(dir, 'calls.log');
  const promptPath = join(dir, 'reduce-prompt.txt');
  const runner = join(dir, 'fake.mjs');
  writeFileSync(runner, FAKE_RUNNER, 'utf8');

  // The shim passes the log/prompt paths through the environment rather than
  // argv, because digest.js owns the argv it spawns with.
  if (isWin) {
    writeFileSync(
      join(dir, 'claude.cmd'),
      '@echo off\r\n' +
      'set "FAKE_CLAUDE_LOG=' + logPath + '"\r\n' +
      'set "FAKE_CLAUDE_PROMPTS=' + promptPath + '"\r\n' +
      '"' + process.execPath + '" "' + runner + '" %*\r\n',
      'utf8'
    );
  } else {
    writeFileSync(
      join(dir, 'claude'),
      '#!/bin/sh\n' +
      'FAKE_CLAUDE_LOG="' + logPath + '"\n' +
      'FAKE_CLAUDE_PROMPTS="' + promptPath + '"\n' +
      'export FAKE_CLAUDE_LOG FAKE_CLAUDE_PROMPTS\n' +
      'exec "' + process.execPath + '" "' + runner + '" "$@"\n',
      { mode: 0o755 }
    );
  }
  return { dir, logPath, promptPath };
}

/** Peak simultaneous calls, reconstructed from the fake's start/end log. */
function peakConcurrency(logPath) {
  if (!existsSync(logPath)) return 0;
  const events = readFileSync(logPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => {
      const [kind, n, ts] = line.trim().split(/\s+/);
      return { kind, n, ts: Number(ts) };
    })
    // On a tie, close before opening — otherwise two adjacent calls that
    // happen to share a millisecond read as an overlap that never happened.
    .sort((a, b) => (a.ts - b.ts) || (a.kind === 'end' ? -1 : 1));
  let live = 0;
  let peak = 0;
  for (const e of events) {
    if (e.kind === 'start') { live++; peak = Math.max(peak, live); } else { live--; }
  }
  return peak;
}

function startedChunks(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n')
    .filter((l) => l.startsWith('start'))
    .map((l) => l.trim().split(/\s+/)[1]);
}

/** A transcript comfortably past LONG_PATH_THRESHOLD_CHARS (480k). */
function longTranscript(chars = 1_500_000) {
  // Word soup rather than one repeated character, so the chunker's boundary
  // finding behaves the way it does on a real transcript.
  const unit = 'the quick brown fox jumps over the lazy dog and keeps talking ';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

async function withFakeClaude(concurrency, fn) {
  const { dir, logPath, promptPath } = installFakeClaude();
  const prevPath = process.env.PATH;
  const prevConc = process.env.ECHO_DIGEST_MAP_CONCURRENCY;
  process.env.PATH = dir + (isWin ? ';' : ':') + prevPath;
  process.env.ECHO_DIGEST_MAP_CONCURRENCY = String(concurrency);
  try {
    // digest.js reads MAP_CONCURRENCY once at module load, so the env var must
    // be set before the first import — hence a cache-busting query per case.
    const digest = await import('../digest.js?conc=' + concurrency);
    return await fn(digest, logPath, promptPath);
  } finally {
    process.env.PATH = prevPath;
    if (prevConc === undefined) delete process.env.ECHO_DIGEST_MAP_CONCURRENCY;
    else process.env.ECHO_DIGEST_MAP_CONCURRENCY = prevConc;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the map phase never runs more chunks at once than the cap allows', async () => {
  await withFakeClaude(2, async (digest, logPath) => {
    const out = await digest.generateDigest(longTranscript(), { language: 'English' });
    assert.ok(out.digest, 'a digest came back');

    const peak = peakConcurrency(logPath);
    assert.ok(peak > 0, 'the fake CLI actually ran — the PATH shim resolved');
    assert.ok(startedChunks(logPath).length > 2,
      'the transcript was long enough to actually fan out');
    assert.ok(peak <= 2, 'peak concurrency was ' + peak + ', expected <= 2');
  });
});

test('raising the cap raises the ceiling, so the cap is read and not ignored', async () => {
  // Without this, a cap that silently defaulted would still pass the test
  // above — the run would just look identical.
  await withFakeClaude(6, async (digest, logPath) => {
    await digest.generateDigest(longTranscript(), { language: 'English' });
    const peak = peakConcurrency(logPath);
    assert.ok(peak > 2, 'peak concurrency was ' + peak + ', expected > 2 at a cap of 6');
    assert.ok(peak <= 6, 'peak concurrency was ' + peak + ', expected <= 6');
  });
});

test('chunk summaries reach the reduce prompt in chunk order, not completion order', async () => {
  await withFakeClaude(4, async (digest, logPath, promptPath) => {
    await digest.generateDigest(longTranscript(), { language: 'English' });

    assert.ok(existsSync(promptPath), 'the reduce phase ran and captured its prompt');
    const reducePrompt = readFileSync(promptPath, 'utf8');
    const order = [...reducePrompt.matchAll(/SUMMARY_OF_CHUNK_(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(order.length > 2, 'several chunk summaries reached the reduce prompt');

    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted,
      'summaries appear in completion order, not chunk order — the pool lost ordering');
  });
});

test('an abort mid-map rejects instead of draining the queue', async () => {
  await withFakeClaude(2, async (digest, logPath) => {
    const ac = new AbortController();
    const p = digest.generateDigest(longTranscript(), {
      language: 'English',
      signal: ac.signal,
    });
    // Abort once the first wave is OBSERVED to be in flight, rather than after
    // a fixed delay. A timer raced the process spawn: it passed in isolation
    // and failed under full-suite load, where spawning is slower than the
    // timeout. Poll the fake's log instead, so the trigger is the thing the
    // test actually depends on.
    const deadline = Date.now() + 10_000;
    while (startedChunks(logPath).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(startedChunks(logPath).length >= 1,
      'no chunk started within 10s — the fan-out never began, so this run ' +
      'cannot say anything about abort behaviour');
    ac.abort();
    await assert.rejects(p, 'aborting the signal rejects the digest');

    // The real claim: the chunks queued behind the cap were never dispatched.
    // (That the fan-out actually began is already asserted above, before the
    // abort — so this cannot pass vacuously.)
    const started = startedChunks(logPath).length;
    assert.ok(started <= 2,
      started + ' chunks started after an abort during the first wave; the pool kept dispatching');
  });
});
