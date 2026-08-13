// Keeping someone's repository in step with their library.
//
// pds.js is the transport; this is the policy. It owns three things the
// transport deliberately does not: where an access token comes from, when a
// write is worth doing, and what happens when one fails.
//
// Every dependency is injected. That is not ceremony — this module reads and
// writes other people's Bluesky accounts, and a unit test must be able to
// exercise every path (including the failures) without any possibility of
// touching a real one.

import { refreshSession } from './atproto.js';
import {
  COLLECTION, uploadBlob, putRecord, deleteRecord, listRecords, fetchBlob,
  entryToRecord, recordToEntry, withTranscriptBlob, transcriptCid, isValidRkey,
} from './pds.js';

// Access tokens are short-lived by spec — under 30 minutes, often 5. Refreshing
// on every write would double the request count of a sync and burn the shared
// per-IP budget for nothing, so they are cached just inside the shortest
// documented lifetime.
const ACCESS_TTL_MS = 4 * 60_000;

/**
 * Build a sync bound to one instance's storage.
 *
 * @param {object} deps
 * @param {(userId: string) => {did: string, pdsUrl: string, refreshJwt: string}|null} deps.getTokens
 * @param {(spec: {userId: string, did: string, pdsUrl: string, refreshJwt: string}) => void} deps.saveTokens
 * @param {(plain: string) => string} deps.seal
 * @param {(blob: string) => string|null} deps.open
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export function createPdsSync({ getTokens, saveTokens, seal, open, fetchImpl, now = () => Date.now() }) {
  /** @type {Map<string, {did: string, pdsUrl: string, accessJwt: string, expiresAt: number}>} */
  const sessions = new Map();

  /**
   * A usable session for this user, or null if they have no stored credentials.
   *
   * The ordering here is load-bearing. Refresh tokens ROTATE: the stored one
   * stops working the instant the refresh succeeds, so the new one is persisted
   * BEFORE the access token is handed out. Crash in between and the user is
   * signed out of Bluesky; do it the other way round and a crash loses the
   * session permanently instead.
   */
  async function sessionFor(userId) {
    const cached = sessions.get(userId);
    if (cached && cached.expiresAt > now()) return cached;

    const stored = getTokens(userId);
    if (!stored) return null;

    const refreshJwt = open(stored.refreshJwt);
    if (!refreshJwt) {
      // Sealed under a different key, or tampered with. Treated as "no
      // credentials" rather than an error: there is nothing the user can do
      // about it except sign in again, and sync is not the place to say so.
      return null;
    }

    const fresh = await refreshSession({ pdsUrl: stored.pdsUrl, refreshJwt }, fetchImpl);
    saveTokens({
      userId,
      did: fresh.did || stored.did,
      pdsUrl: stored.pdsUrl,
      refreshJwt: seal(fresh.refreshJwt),
    });

    const session = {
      did: fresh.did || stored.did,
      pdsUrl: stored.pdsUrl,
      accessJwt: fresh.accessJwt,
      expiresAt: now() + ACCESS_TTL_MS,
    };
    sessions.set(userId, session);
    return session;
  }

  /** Drop a cached access token — after a 401, or when someone signs out. */
  function forget(userId) {
    sessions.delete(userId);
  }

  /**
   * Write one entry into the owner's repository.
   *
   * Blob first, then record. A record written before its blob would point at
   * nothing, and a blob with no record is merely garbage the PDS collects —
   * so the order is chosen to make the failure the harmless one.
   *
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function pushEntry(userId, entry) {
    if (!isValidRkey(entry?.videoId)) return { ok: false, reason: 'invalid_key' };

    const session = await sessionFor(userId);
    if (!session) return { ok: false, reason: 'no_credentials' };

    const { record, transcript } = entryToRecord(entry);
    const blob = await uploadBlob({
      pdsUrl: session.pdsUrl,
      accessJwt: session.accessJwt,
      bytes: transcript,
      mimeType: 'application/json',
    }, fetchImpl);

    await putRecord({
      pdsUrl: session.pdsUrl,
      accessJwt: session.accessJwt,
      did: session.did,
      rkey: entry.videoId,
      record: withTranscriptBlob(record, blob),
    }, fetchImpl);

    return { ok: true };
  }

  /**
   * Remove one entry from the owner's repository.
   *
   * A missing record is success: the caller wanted it gone and it is gone.
   */
  async function removeEntry(userId, videoId) {
    if (!isValidRkey(videoId)) return { ok: false, reason: 'invalid_key' };
    const session = await sessionFor(userId);
    if (!session) return { ok: false, reason: 'no_credentials' };

    await deleteRecord({
      pdsUrl: session.pdsUrl,
      accessJwt: session.accessJwt,
      did: session.did,
      rkey: videoId,
    }, fetchImpl);
    return { ok: true };
  }

  /**
   * Read a whole repository back, page by page, into a caller-supplied sink.
   *
   * Streamed rather than collected: a library is the biggest thing in this app,
   * and returning an array of every entry WITH transcripts is the unbounded
   * read this codebase has got wrong seven times. The caller writes each entry
   * as it arrives and never holds more than one.
   *
   * @param {string} userId
   * @param {{onEntry: (entry: object) => Promise<void>|void, withTranscripts?: boolean}} opts
   * @returns {Promise<{restored: number, skipped: number}>}
   */
  async function pullAll(userId, { onEntry, withTranscripts = true } = {}) {
    const session = await sessionFor(userId);
    if (!session) return { restored: 0, skipped: 0, reason: 'no_credentials' };

    let cursor = null;
    let restored = 0;
    let skipped = 0;

    do {
      const page = await listRecords({
        pdsUrl: session.pdsUrl,
        accessJwt: session.accessJwt,
        did: session.did,
        cursor,
        limit: 50,
      }, fetchImpl);

      for (const item of page.records) {
        const value = item?.value;
        if (!value?.videoId) { skipped += 1; continue; }

        let bytes;
        const cid = withTranscripts ? transcriptCid(value) : null;
        if (cid) {
          try {
            bytes = await fetchBlob({
              pdsUrl: session.pdsUrl,
              accessJwt: session.accessJwt,
              did: session.did,
              cid,
            }, fetchImpl);
          } catch {
            // One unreadable blob must not end the restore. The entry comes
            // back without its transcript, which is far better than stopping
            // at video 40 of 300.
            bytes = undefined;
          }
        }

        await onEntry(recordToEntry(value, bytes));
        restored += 1;
      }

      cursor = page.cursor;
    } while (cursor);

    return { restored, skipped };
  }

  return { sessionFor, forget, pushEntry, removeEntry, pullAll, COLLECTION };
}
