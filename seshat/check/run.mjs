// Runs each case file three ways and compares the output byte for byte:
//   original     node + the original module (original.mjs redirects the import)
//   port@node    node + the port: tells a porting mistake from a Seshat gap
//   port@seshat  seshat run + the port: the target
// Usage: node seshat/check/run.mjs [name ...]   (default: every *.cases.ts here)
// SESHAT names the compiler (default: ../Seshat/target/release/seshat.exe).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESHAT = process.env.SESHAT || join(HERE, '..', '..', '..', 'Seshat', 'target', 'release', 'seshat.exe');
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(HERE).filter((f) => f.endsWith('.cases.ts')).map((f) => f.replace('.cases.ts', ''));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: HERE, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : ''), code: r.status };
}

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n    original: ${la[i]}\n    other:    ${lb[i]}`;
  }
  return '';
}

let failed = 0;
for (const name of names) {
  const file = `${name}.cases.ts`;
  const original = run(process.execPath, ['--no-warnings', '--import', './original.mjs', file]);
  if (original.code !== 0 || !original.out) {
    failed++;
    console.log(`FAIL ${name}: the original did not run\n${original.err}`);
    continue;
  }
  const cases = original.out.trimEnd().split('\n').length;
  const ports = [
    ['port@node', run(process.execPath, ['--no-warnings', file])],
    ['port@seshat', run(SESHAT, ['run', file])],
  ];
  for (const [label, r] of ports) {
    if (r.out === original.out && r.code === 0) {
      console.log(`ok   ${name} ${label}: ${cases} cases, identical`);
    } else {
      failed++;
      console.log(`FAIL ${name} ${label} (exit ${r.code}): ${firstDiff(original.out, r.out)}`);
      if (r.err.trim()) console.log(r.err.trim().split('\n').slice(0, 20).map((l) => `    ${l}`).join('\n'));
    }
  }
}
process.exit(failed ? 1 : 0);
