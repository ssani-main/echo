// Node prints renamed. Seshat on Windows: error: npm packages need JavaScriptCore: install WebKitGTK's (on
// Debian and Ubuntu, libjavascriptcoregtk-4.1-dev; pkg-config finds it). `rename` isn't one of Seshat's own
// node:fs/promises calls, so the import goes to Node's JavaScript module, and the other names in it become
// `Js` too (a `stat` result's `st.size >= 1` is T0501: can't compare `Js` with `f64`).
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const from = join(tmpdir(), `gap-rename-${process.pid}-a`);
await writeFile(from, 'x');
await rename(from, from.replace(/-a$/, '-b'));
console.log('renamed');
