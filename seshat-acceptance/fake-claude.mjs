// A stand-in for the `claude` CLI, run by Node (never by Seshat): it is the
// program under spawn, not the program doing the spawning. Mode is the first
// argument; the rest mimic Echo's real flags and are ignored.
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'stream';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Write in 7-byte slices so NDJSON lines (and UTF-8 characters) split across chunks.
async function slowWrite(text) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 7) {
    process.stdout.write(bytes.subarray(i, i + 7));
    await sleep(1);
  }
}

const delta = (text) => JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
}) + '\n';

async function readStdinBytes() {
  let n = 0;
  for await (const chunk of process.stdin) n += chunk.length;
  return n;
}

if (mode === 'stream') {
  const promptBytes = await readStdinBytes();
  const parts = ['## TL;DR\n\n', 'Résumé — ', 'done ✓ ', '🎧 end.'];
  await slowWrite(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }) + '\n');
  for (const p of parts) await slowWrite(delta(p));
  await sleep(300); // the test checks it saw output before this gap ended
  await slowWrite(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: parts.join(''), prompt_bytes: promptBytes }) + '\n');
  process.exit(0);
}

if (mode === 'flood') {
  // whisper-cli echoes every line to stderr; 80 MiB overflowed execFile's 64 MB buffer once.
  const block = new Uint8Array(64 * 1024).fill(0x61);
  for (let i = 0; i < 1280; i++) {
    if (!process.stderr.write(block)) await new Promise((r) => process.stderr.once('drain', r));
  }
  process.stdout.write('done\n');
  process.exit(0);
}

if (mode === 'fail') {
  process.stderr.write('boom: not logged in\n');
  process.exit(3);
}

if (mode === 'sleep') {
  process.stdout.write('started\n');
  setInterval(() => {}, 1000);
}

if (mode === 'hang') {
  // Never reads stdin, so a large prompt write stays pending (Echo's EPIPE case).
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ type: 'pids', fake: process.pid, grandchild: grandchild.pid }) + '\n');
  setInterval(() => process.stdout.write(delta('tick ')), 50);
}
