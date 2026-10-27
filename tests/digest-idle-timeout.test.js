import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI timeout is an IDLE timeout: it fires when the process goes quiet, not
// when a digest that is still writing runs long. Opus writes conversation
// digests of 10k+ tokens at ~70 tok/s, which crossed a fixed 180 s wall clock
// and threw away a digest that was nearly done (2026-10-16, usage log).
//
// A fake `claude` on PATH (plus a .cmd shim, since Windows spawns via cmd.exe).

const BIN_DIR = mkdtempSync(join(tmpdir(), 'echo-fake-claude-idle-'));
const FAKE = join(BIN_DIR, 'fake.mjs');
const originalPath = process.env.PATH;
process.env.PATH = `${BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
writeFileSync(join(BIN_DIR, 'claude.cmd'), `@node "${FAKE}"\r\n`);
writeFileSync(join(BIN_DIR, 'claude'), `#!/bin/sh\nexec node "${FAKE}"\n`);
chmodSync(join(BIN_DIR, 'claude'), 0o755);

const { runClaudeStream } = await import('../digest.js');

test.after(() => {
  process.env.PATH = originalPath;
  try { rmSync(BIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Fake CLI: `deltas` text deltas, one every `gapMs`, then a result line. */
function installFake({ deltas, gapMs }) {
  writeFileSync(FAKE, `
const delta = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
process.stdin.resume(); process.stdin.on('end', () => {});
let i = 0;
(function tick() {
  if (i === ${deltas}) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x'.repeat(${deltas}), usage: {} }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(delta('x') + '\\n');
  i++;
  setTimeout(tick, ${gapMs});
})();
`);
}

test('a CLI that keeps writing past the timeout is not killed', async () => {
  installFake({ deltas: 12, gapMs: 150 }); // ~1.8 s total, never quiet for 1 s
  const { result } = await runClaudeStream('p', { timeoutMs: 1000 });
  assert.equal(result, 'x'.repeat(12));
});

test('a CLI that goes quiet is still killed', async () => {
  installFake({ deltas: 2, gapMs: 3000 }); // silent for 3 s after the first delta
  await assert.rejects(runClaudeStream('p', { timeoutMs: 1000 }), /no output for 1s/);
});
