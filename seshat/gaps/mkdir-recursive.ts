// Gap 34: mkdirSync(p, { recursive: true }) doesn't make missing parents (Windows). Node prints true.
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const top = join(tmpdir(), `echo-gap-mkdir-${process.pid}`);
mkdirSync(join(top, 'a', 'b'), { recursive: true });
console.log(existsSync(join(top, 'a', 'b')));
rmSync(top, { recursive: true, force: true });
