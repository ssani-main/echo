// Port of usagelog.js: local-only, fire-and-forget action logging, one JSON line per user action to
// data/usage-events.jsonl.
//
// Guarantees:
//   - NEVER logs in web mode (multi-tenant privacy).
//   - NEVER blocks the request path (no await) and NEVER throws.
//   - NEVER records raw transcript / selection / answer / query text — only
//     lengths, counts, enums, ids, and outcomes.

import { appendFile, stat, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The repo root, so the default file is the one usagelog.js writes.
// shortcut: the working directory (the service is started from the repo root), because `import.meta.url`
// doesn't parse in Seshat (gap: import-meta); one up from this file's folder once it does.
const root = process.cwd();
// Overridable the same way ECHO_DB_PATH/ECHO_SYNC_DB_PATH are, so tests can
// point this at an isolated file instead of the real local usage history.
const LOG_PATH = process.env.ECHO_USAGE_LOG_PATH || join(root, 'data', 'usage-events.jsonl');
const ROTATED_PATH = LOG_PATH.replace(/\.jsonl$/, '.1.jsonl');

const isWeb = process.env.ECHO_MODE === 'web';

// Set by scale-sweep / benchmark scripts that seed synthetic entries; every event
// logged while it is set is stamped `synthetic:true` so usage_stats.mjs can exclude it.
const isSynthetic = !!process.env.ECHO_USAGE_SYNTHETIC;

// Roll the current file to a single `.1.jsonl` backup once it crosses this size.
const ROTATE_BYTES = Number(process.env.ECHO_USAGE_ROTATE_BYTES) || 10 * 1024 * 1024;

/** Best-effort: any failure (missing file, a race, permissions) is swallowed. */
async function rotateIfNeeded(): Promise<void> {
  try {
    const st = await stat(LOG_PATH);
    if (st.size >= ROTATE_BYTES) {
      // shortcut: copy then unlink, because Seshat has no rename (gap: fs-rename); an append landing between
      // the two is lost, where rename moves it along. `await rename(LOG_PATH, ROTATED_PATH)` once it has.
      await writeFile(ROTATED_PATH, await readFile(LOG_PATH, 'utf8'));
      await unlink(LOG_PATH);
    }
  } catch {
    // No file yet, or rotation failed: appendFile creates/continues the file as normal.
  }
}

/** Append one action event. Local-mode only; fire-and-forget; never throws. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (isWeb) return;
  try {
    const record: Record<string, unknown> = { event, ts: new Date().toISOString(), ...fields };
    if (isSynthetic) record.synthetic = true;
    const line = JSON.stringify(record) + '\n';
    rotateIfNeeded()
      .then(() => appendFile(LOG_PATH, line))
      .catch(() => {});
  } catch {
    /* logging must never break the request path */
  }
}

/** Short, PII-free label for an error, for the `err` field. */
export function errLabel(err: any): string {
  if (!err) return 'Error';
  return err.code || err.name || 'Error';
}
