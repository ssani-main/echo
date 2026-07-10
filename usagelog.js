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

import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, 'data', 'usage-events.jsonl');

// Same mode computation as server.js — read the env directly to avoid a
// circular import with server.js.
const isWeb = process.env.ECHO_MODE === 'web';

/**
 * Append one action event. Local-mode only; fire-and-forget; never throws.
 * @param {string} event   event name, e.g. 'digest', 'save', 'enrich'
 * @param {object} [fields] additional fields (videoId, ok, ms, chars, ...)
 */
export function logEvent(event, fields = {}) {
  if (isWeb) return;
  try {
    const line = JSON.stringify({ event, ts: new Date().toISOString(), ...fields }) + '\n';
    appendFile(LOG_PATH, line).catch(() => {});
  } catch {
    /* logging must never break the request path */
  }
}

/** Short, PII-free label for an error, for the `err` field. */
export function errLabel(err) {
  if (!err) return 'Error';
  return err.code || err.name || 'Error';
}
