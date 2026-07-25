// Local-only, fire-and-forget action logging.
//
// This module
// records one JSON line per user action to data/usage-events.jsonl so we can
// measure the real product loop (paste -> digest -> save), spot digest-quality
// signals (re-digest, ask-after-digest, save-after-digest), and decide feature
// cuts on data instead of inference.
//
// Guarantees:
//   - NEVER logs in web mode (multi-tenant privacy).
//   - NEVER blocks the request path (no await) and NEVER throws.
//   - NEVER records raw transcript / selection / answer / query text — only
//     lengths, counts, enums, ids, and outcomes.

import { appendFile, stat, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable the same way ECHO_DB_PATH/ECHO_SYNC_DB_PATH are, so tests can
// point this at an isolated file instead of the real local usage history.
const LOG_PATH = process.env.ECHO_USAGE_LOG_PATH || join(__dirname, 'data', 'usage-events.jsonl');
const ROTATED_PATH = LOG_PATH.replace(/\.jsonl$/, '.1.jsonl');

// Same mode computation as server.js — read the env directly to avoid a
// circular import with server.js.
const isWeb = process.env.ECHO_MODE === 'web';

// Set by scale-sweep / benchmark scripts that seed synthetic library entries
// straight into the usage log (e.g. to test paged reads at 500/2000 rows).
// Every event logged while this is set is stamped `synthetic:true` so
// usage_stats.mjs can exclude it — real usage must never be diluted by
// seeded data. See CLAUDE.md "the local usage meter ... is reporting
// fiction" for why this exists.
const isSynthetic = !!process.env.ECHO_USAGE_SYNTHETIC;

// Size-based rotation: the log is append-only forever otherwise. Roll the
// current file to a single `.1.jsonl` backup once it crosses the threshold,
// keeping at most two generations on disk. Threshold is overridable for
// tests; default is generous since events are small (~150 bytes) and this
// is a fire-and-forget local telemetry file, not a request-critical log.
const ROTATE_BYTES = Number(process.env.ECHO_USAGE_ROTATE_BYTES) || 10 * 1024 * 1024;

/**
 * Roll usage-events.jsonl -> usage-events.1.jsonl if the current file is at
 * or past the size threshold. Best-effort: any failure (missing file, race
 * with another process, permissions) is swallowed so it can never surface
 * into the caller — rotation is a nice-to-have, not a correctness guarantee.
 */
async function rotateIfNeeded() {
  try {
    const st = await stat(LOG_PATH);
    if (st.size >= ROTATE_BYTES) {
      await rename(LOG_PATH, ROTATED_PATH);
    }
  } catch {
    // No file yet, or rotation failed for any reason — fall through and let
    // appendFile create/continue the file as normal.
  }
}

/**
 * Append one action event. Local-mode only; fire-and-forget; never throws.
 * @param {string} event   event name, e.g. 'digest', 'save', 'transcript'
 * @param {object} [fields] additional fields (videoId, ok, ms, chars, ...)
 */
export function logEvent(event, fields = {}) {
  if (isWeb) return;
  try {
    const record = { event, ts: new Date().toISOString(), ...fields };
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
export function errLabel(err) {
  if (!err) return 'Error';
  return err.code || err.name || 'Error';
}
