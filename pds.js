// Writing a library into its owner's own atproto repository.
//
// Phase 5 of ATPROTO.md. The point is portability, not isolation — isolation is
// already a file boundary (see store.js). This is what makes a library survive
// leaving this instance: the records live in the person's own PDS, readable by
// any atproto client, and Echo becomes a cache in front of them rather than the
// only place they exist.
//
// Shape, and why:
//   - ONE record per saved video, at dev.ssani.echo.entry, keyed by the video id.
//   - The transcript is a BLOB, not a record field. The spec's guidance is that
//     anything past a few dozen KB belongs in a blob, and Echo's entries average
//     ~45 KB of which almost all is transcript. Putting it inline would push
//     every record past the limit.
//   - The record holds what a list row and a reader need without the blob:
//     title, digest, tags, counts. So a library list costs one listRecords call
//     and no blob fetches at all.
//
// No SDK. This is six XRPC calls and a JSON mapping; the official client exists
// to carry OAuth's DPoP machinery, which this path does not use.

import { refreshSession } from './atproto.js';

/** The collection every Echo entry lives in. */
export const COLLECTION = 'dev.ssani.echo.entry';

const FETCH_TIMEOUT_MS = 30_000;

// A PDS allows 3,000 requests per 5 minutes PER IP, and this instance writes to
// many people's PDSes from one address. A whole-library sync is the one thing
// here that can produce hundreds of calls in a burst, so it is paced well under
// the ceiling rather than discovering it.
const MAX_REQUESTS_PER_WINDOW = 1_500;
const WINDOW_MS = 5 * 60_000;

export { MAX_REQUESTS_PER_WINDOW, WINDOW_MS, FETCH_TIMEOUT_MS };

let windowStart = 0;
let windowCount = 0;

/**
 * Wait, if this instance has spent too much of the shared per-IP budget.
 *
 * Deliberately a module-level counter rather than per-user: the limit is per
 * IP, and every user's sync leaves from the same one. Counting per user would
 * measure the wrong thing entirely.
 *
 * @param {(ms: number) => Promise<void>} [sleep] test seam
 */
export async function pace(sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now()) {
  const t = now();
  if (t - windowStart > WINDOW_MS) {
    windowStart = t;
    windowCount = 0;
  }
  windowCount += 1;
  if (windowCount > MAX_REQUESTS_PER_WINDOW) {
    const wait = WINDOW_MS - (t - windowStart);
    await sleep(Math.max(wait, 0));
    windowStart = now();
    windowCount = 1;
  }
}

/** Reset the pacing counter. Test seam. */
export function resetPacing() {
  windowStart = 0;
  windowCount = 0;
}

function fail(message, { status = 502, detail = '', hint = '' } = {}) {
  const err = new Error(message);
  err.echoCode = 'PDS_FAILED';
  err.status = status;
  err.hint = hint;
  if (detail) err.detail = String(detail).slice(0, 500);
  return err;
}

async function xrpc(url, init, fetchImpl) {
  const f = fetchImpl || fetch;
  let res;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw fail('Could not reach the Bluesky server.', { detail: `${url}: ${err?.message || err}` });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let name = '';
    try { name = String(JSON.parse(text)?.error || ''); } catch { /* not JSON */ }

    if (res.status === 401) {
      throw fail('Your Bluesky session has expired.', { status: 401, detail: text });
    }
    if (res.status === 429) {
      throw fail('Bluesky is rate-limiting this server.', {
        status: 429,
        hint: 'Sync will pick up where it left off. Try again in a few minutes.',
        detail: text,
      });
    }
    throw fail(`Bluesky rejected the request${name ? ` (${name})` : ''}.`, { detail: text });
  }
  return res;
}

/**
 * Turn a stored refresh token into a usable access token.
 *
 * Refresh tokens ROTATE: the one passed in stops working the moment this
 * succeeds. The caller must persist `refreshJwt` from the result before using
 * `accessJwt` for anything, or a crash in between loses the session — which is
 * why this returns both rather than caching internally.
 *
 * @param {{pdsUrl: string, refreshJwt: string}} spec
 * @param {typeof fetch} [fetchImpl]
 */
export async function accessTokenFor({ pdsUrl, refreshJwt }, fetchImpl) {
  return refreshSession({ pdsUrl, refreshJwt }, fetchImpl);
}

/**
 * Upload bytes and get back a blob reference to put in a record.
 *
 * @param {{pdsUrl: string, accessJwt: string, bytes: Uint8Array, mimeType?: string}} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object>} the blob ref, verbatim, for embedding in a record
 */
export async function uploadBlob({ pdsUrl, accessJwt, bytes, mimeType = 'application/json' }, fetchImpl) {
  await pace();
  const res = await xrpc(`${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': mimeType },
    body: bytes,
  }, fetchImpl);

  const body = await res.json().catch(() => null);
  if (!body?.blob) throw fail('Bluesky did not return a blob reference.');
  return body.blob;
}

/**
 * Fetch a blob's bytes back.
 *
 * @param {{pdsUrl: string, accessJwt: string, did: string, cid: string}} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBlob({ pdsUrl, accessJwt, did, cid }, fetchImpl) {
  await pace();
  const url = `${pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  const res = await xrpc(url, { headers: { Authorization: `Bearer ${accessJwt}` } }, fetchImpl);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Create or replace one record.
 *
 * @param {{pdsUrl: string, accessJwt: string, did: string, rkey: string, record: object}} spec
 * @param {typeof fetch} [fetchImpl]
 */
export async function putRecord({ pdsUrl, accessJwt, did, rkey, record }, fetchImpl) {
  await pace();
  const res = await xrpc(`${pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: did, collection: COLLECTION, rkey, record }),
  }, fetchImpl);
  return res.json();
}

/**
 * One page of a repo's Echo entries.
 *
 * Paged from the start and never "fetch them all": a library is the biggest
 * thing in this app, and an unpaged read of one is the bug this codebase has
 * recorded seven times.
 *
 * @param {{pdsUrl: string, accessJwt: string, did: string, cursor?: string, limit?: number}} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{records: object[], cursor: string|null}>}
 */
export async function listRecords({ pdsUrl, accessJwt, did, cursor, limit = 50 }, fetchImpl) {
  await pace();
  const params = new URLSearchParams({
    repo: did,
    collection: COLLECTION,
    limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)),
  });
  if (cursor) params.set('cursor', cursor);

  const res = await xrpc(
    `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    { headers: { Authorization: `Bearer ${accessJwt}` } },
    fetchImpl
  );
  const body = await res.json().catch(() => null);
  return {
    records: Array.isArray(body?.records) ? body.records : [],
    cursor: body?.cursor || null,
  };
}

/**
 * Remove one record. Missing is success — the caller wanted it gone.
 *
 * @param {{pdsUrl: string, accessJwt: string, did: string, rkey: string}} spec
 * @param {typeof fetch} [fetchImpl]
 */
export async function deleteRecord({ pdsUrl, accessJwt, did, rkey }, fetchImpl) {
  await pace();
  await xrpc(`${pdsUrl}/xrpc/com.atproto.repo.deleteRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: did, collection: COLLECTION, rkey }),
  }, fetchImpl);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The record shape
// ---------------------------------------------------------------------------

/**
 * Is this usable as a record key?
 *
 * Record keys allow a restricted character set, and `.` and `..` are reserved.
 * YouTube ids and Echo's synthetic `file_<hash>` ids both satisfy it, but the
 * id reaches here from a client, so it is checked rather than assumed.
 *
 * @param {string} videoId
 */
export function isValidRkey(videoId) {
  const s = String(videoId || '');
  if (s === '.' || s === '..') return false;
  return /^[A-Za-z0-9._~:-]{1,512}$/.test(s);
}

/** Digest text is capped so a record cannot grow past what a record should be. */
export const MAX_DIGEST_IN_RECORD = 40_000;

/**
 * Map a stored entry to the record that represents it, plus the bytes that
 * belong in its blob.
 *
 * The split is the whole design: everything a list row or a reader header needs
 * stays in the record, so opening a library costs one listRecords call and zero
 * blob fetches. Only the transcript — the part that is big and that nobody
 * reads until they open the entry — becomes a blob.
 *
 * @param {object} entry a full entry from store.js
 * @returns {{record: object, transcript: Uint8Array}}
 */
export function entryToRecord(entry) {
  if (!isValidRkey(entry?.videoId)) {
    throw fail('That entry cannot be stored in a repository.', {
      status: 400,
      detail: `invalid record key: ${String(entry?.videoId).slice(0, 60)}`,
    });
  }

  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  const transcript = new TextEncoder().encode(JSON.stringify(segments));

  const record = {
    $type: COLLECTION,
    videoId: String(entry.videoId),
    url: String(entry.url || ''),
    title: String(entry.title || ''),
    savedAt: String(entry.savedAt || new Date().toISOString()),
    updatedAt: String(entry.updatedAt || entry.savedAt || new Date().toISOString()),
    segmentCount: segments.length,
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 20).map((t) => String(t).slice(0, 40)) : [],
  };

  // Optional fields are OMITTED when empty rather than written as null: a
  // record is someone else's data in their own repo, and empty keys there are
  // litter.
  if (entry.digest) record.digest = String(entry.digest).slice(0, MAX_DIGEST_IN_RECORD);
  if (entry.channel) record.channel = String(entry.channel);
  if (entry.channelUrl) record.channelUrl = String(entry.channelUrl);
  if (entry.transcriptSource) record.transcriptSource = String(entry.transcriptSource);
  if (entry.whisperModel) record.whisperModel = String(entry.whisperModel);

  return { record, transcript };
}

/**
 * Map a record (and its transcript bytes, if fetched) back to a store entry.
 *
 * `transcript` is optional on purpose: a library LIST needs none of it, so the
 * common path never fetches a blob at all.
 *
 * @param {object} record
 * @param {Uint8Array} [transcriptBytes]
 */
export function recordToEntry(record, transcriptBytes) {
  let segments = [];
  if (transcriptBytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(transcriptBytes));
      if (Array.isArray(parsed)) segments = parsed;
    } catch {
      // A corrupt or foreign blob costs the transcript, not the entry. Losing
      // the title and digest too would turn one bad blob into a missing row.
      segments = [];
    }
  }

  return {
    videoId: String(record?.videoId || ''),
    url: String(record?.url || ''),
    title: String(record?.title || ''),
    savedAt: String(record?.savedAt || ''),
    updatedAt: String(record?.updatedAt || record?.savedAt || ''),
    segments,
    digest: record?.digest ?? null,
    tags: Array.isArray(record?.tags) ? record.tags.map(String) : [],
    channel: record?.channel ?? null,
    channelUrl: record?.channelUrl ?? null,
    transcriptSource: record?.transcriptSource ?? null,
    whisperModel: record?.whisperModel ?? null,
    segmentCount: Number(record?.segmentCount) || 0,
  };
}

/**
 * Attach an uploaded blob to a record.
 *
 * Separate from entryToRecord because the upload has to happen first — the blob
 * ref does not exist until the bytes are on the server — and because that order
 * matters: a record written before its blob would point at nothing.
 *
 * @param {object} record
 * @param {object} blobRef the ref returned by uploadBlob
 */
export function withTranscriptBlob(record, blobRef) {
  return blobRef ? { ...record, transcript: blobRef } : record;
}

/** The blob CID a record's transcript lives at, or null. */
export function transcriptCid(record) {
  const ref = record?.transcript?.ref;
  return ref?.$link || ref?.toString?.() || null;
}
