// Gap 53: node:fs/promises has no mkdtemp (T0107). Node prints true.
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = await mkdtemp(join(tmpdir(), 'gap-'));
console.log(existsSync(dir));
await rm(dir, { recursive: true, force: true });
