// Gap 33: writeFileSync(path, string, 'utf8') is refused (T0201: takes 2 arguments). Node prints héllo.
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const f = join(tmpdir(), `echo-gap-wfs-${process.pid}.txt`);
writeFileSync(f, 'héllo', 'utf8');
console.log(readFileSync(f, 'utf8'));
rmSync(f, { force: true });
