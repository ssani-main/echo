// The module reads its environment when it loads, so run.mjs sets it (ECHO_USAGE_LOG_PATH, a 400-byte
// rotation, no ECHO_MODE/ECHO_USAGE_SYNTHETIC).
// shortcut: set by run.mjs, because `await import()` after setting it here doesn't parse in Seshat (gap:
// dynamic-import) and side-effect imports aren't Seshat's; move it here once dynamic import works.
import { logEvent, errLabel } from '../usagelog.ts';
import { readFileSync, rmSync } from 'node:fs';
import { out } from './out.ts';

const log = process.env.ECHO_USAGE_LOG_PATH!;
const rotated = log.replace(/\.jsonl$/, '.1.jsonl');

// --- errLabel
const enoent = new Error('nope') as Error & { code?: string };
enoent.code = 'ENOENT';
const typeError = new TypeError('x');
const named = new Error('y');
named.name = 'AbortError';
const errs: unknown[] = [null, undefined, '', 0, false, 'a string', enoent, typeError, named, new Error('z'), {}, { code: 'E1' }, { name: 'N' }, { code: '', name: '' }, { code: 'C', name: 'N' }];
errs.forEach((e, i) => out(`errLabel#${i}`, errLabel(e)));

// --- logEvent: the lines it writes, with ts masked, rotation at 400 bytes included
rmSync(log, { force: true });
rmSync(rotated, { force: true });
const events: [string, Record<string, unknown>][] = [
  ['digest-copy', { videoId: 'GRzaq5AHiV8', ok: true }],
  ['digest', { videoId: null, chars: 0, length: 'short', format: 'article', ok: false, err: 'client_aborted', ms: 12 }],
  ['save', { videoId: 'x', hadDigest: true, auto: false, ok: true, ms: 3 }],
  ['entry-export', { videoId: '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'.slice(0, 31), ok: true }],
  ['search', { qLen: 4, results: 0, ok: true, nested: { a: [1, 'b', null] }, skipped: undefined }],
  ['event', { event: 'overridden', ts: 'overridden too' }],
  ['digest-print', {}],
];
// shortcut: the loop is in a function, because an `await` in a top-level loop next to a top-level regex
// literal makes Seshat's generated C fail to compile (gap: top-level-await-loop-regex). Inline it once fixed.
async function logAll(): Promise<void> {
  for (const [name, fields] of events) {
    logEvent(name, fields);
    await new Promise((r) => setTimeout(r, 30)); // fire-and-forget: let the append land, in order
  }
}
await logAll();
logEvent('web-check');
await new Promise((r) => setTimeout(r, 30));
const mask = (text: string): string => text.replace(/"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g, '"ts":"<iso>"');
out('logEvent/rotated', mask(readFileSync(rotated, 'utf8')));
out('logEvent/current', mask(readFileSync(log, 'utf8')));
rmSync(log, { force: true });
rmSync(rotated, { force: true });
