import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTION, uploadBlob, fetchBlob, putRecord, listRecords, deleteRecord,
  entryToRecord, recordToEntry, withTranscriptBlob, transcriptCid, isValidRkey,
  MAX_DIGEST_IN_RECORD, MAX_REQUESTS_PER_WINDOW, WINDOW_MS, pace, resetPacing,
} from '../pds.js';

// ---------------------------------------------------------------------------
// Writing a library into its owner's own repository.
//
// Never touches the network: every call takes an injected fetch. What is worth
// testing is the SHAPE — that a list costs no blob fetches, that a big
// transcript cannot end up inline, and that a corrupt blob costs the transcript
// rather than the whole entry.
// ---------------------------------------------------------------------------

const PDS = 'https://pds.example.com';
const DID = 'did:plc:alice';
const AUTH = { pdsUrl: PDS, accessJwt: 'access', did: DID };

function mockFetch(handler, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const spec = handler(String(url), init) || {};
    const body = spec.body === undefined ? {} : spec.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      json: async () => JSON.parse(text),
      text: async () => text,
      arrayBuffer: async () => (spec.bytes ?? new TextEncoder().encode(text)).buffer,
    };
  };
}

const entry = (over = {}) => ({
  videoId: 'GRzaq5AHiV8',
  url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8',
  title: 'A talk',
  savedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  segments: [{ start: 0, text: 'hello' }, { start: 5, text: 'world' }],
  digest: '# A talk\n\nSomething.',
  tags: ['talks'],
  ...over,
});

// ---------------------------------------------------------------------------
// The record/blob split
// ---------------------------------------------------------------------------

test('the transcript goes in the blob and NOT in the record', () => {
  const { record, transcript } = entryToRecord(entry());

  assert.equal(record.$type, COLLECTION);
  assert.equal(record.videoId, 'GRzaq5AHiV8');
  assert.equal(record.segmentCount, 2);
  assert.equal(record.segments, undefined, 'segments must never be inline');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(transcript)), entry().segments);
});

test('a list row needs the record only — no blob fetch', () => {
  const { record } = entryToRecord(entry());
  // Everything a library card shows must survive without touching the blob.
  for (const field of ['title', 'url', 'savedAt', 'segmentCount', 'tags']) {
    assert.ok(record[field] !== undefined, `${field} must be in the record`);
  }
  const restored = recordToEntry(record);
  assert.equal(restored.title, 'A talk');
  assert.equal(restored.segmentCount, 2);
  assert.deepEqual(restored.segments, [], 'no blob fetched means no segments, not a broken entry');
});

test('a big transcript stays out of the record however big it gets', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ start: i, text: `segment ${i} of a long talk` }));
  const { record, transcript } = entryToRecord(entry({ segments: many }));
  assert.ok(transcript.byteLength > 100_000, 'the blob is the big part');
  assert.ok(JSON.stringify(record).length < 20_000, `record was ${JSON.stringify(record).length} bytes`);
});

test('an oversized digest is capped rather than blowing the record limit', () => {
  const { record } = entryToRecord(entry({ digest: 'x'.repeat(MAX_DIGEST_IN_RECORD + 10_000) }));
  assert.equal(record.digest.length, MAX_DIGEST_IN_RECORD);
});

test('empty optional fields are omitted, not written as null', () => {
  const { record } = entryToRecord(entry({ digest: null, channel: null, whisperModel: null, tags: [] }));
  // A record is someone else's data in their own repo; empty keys there are litter.
  for (const k of ['digest', 'channel', 'channelUrl', 'transcriptSource', 'whisperModel']) {
    assert.ok(!(k in record), `${k} should be absent`);
  }
  assert.deepEqual(record.tags, [], 'but tags stays, because an empty list is a real answer');
});

test('a round trip preserves what matters', () => {
  const original = entry();
  const { record, transcript } = entryToRecord(original);
  const back = recordToEntry(record, transcript);

  assert.equal(back.videoId, original.videoId);
  assert.equal(back.title, original.title);
  assert.equal(back.digest, original.digest);
  assert.deepEqual(back.tags, original.tags);
  assert.deepEqual(back.segments, original.segments);
  assert.equal(back.updatedAt, original.updatedAt);
});

test('a corrupt blob costs the transcript, not the entry', () => {
  const { record } = entryToRecord(entry());
  const back = recordToEntry(record, new TextEncoder().encode('{not json'));
  assert.deepEqual(back.segments, []);
  assert.equal(back.title, 'A talk', 'the rest of the entry must survive');
});

test('record keys are validated, because the id comes from a client', () => {
  assert.equal(isValidRkey('GRzaq5AHiV8'), true);
  assert.equal(isValidRkey('file_9f8e7d6c5b4a32'), true);
  assert.equal(isValidRkey('.'), false);
  assert.equal(isValidRkey('..'), false);
  assert.equal(isValidRkey('a/b'), false);
  assert.equal(isValidRkey(''), false);
  assert.equal(isValidRkey('x'.repeat(513)), false);
  assert.throws(() => entryToRecord(entry({ videoId: '../../evil' })), /cannot be stored/);
});

test('the blob ref is attached separately, because the upload happens first', () => {
  const { record } = entryToRecord(entry());
  assert.equal(transcriptCid(record), null, 'no blob until one is uploaded');

  const withBlob = withTranscriptBlob(record, { $type: 'blob', ref: { $link: 'bafyexample' }, size: 42 });
  assert.equal(transcriptCid(withBlob), 'bafyexample');
  assert.equal(record.transcript, undefined, 'the original is not mutated');
});

// ---------------------------------------------------------------------------
// The XRPC calls
// ---------------------------------------------------------------------------

test('uploadBlob returns the ref a record can embed', async () => {
  const calls = [];
  const f = mockFetch(() => ({ body: { blob: { $type: 'blob', ref: { $link: 'bafy1' }, size: 9 } } }), calls);
  const blob = await uploadBlob({ ...AUTH, bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/json' }, f);

  assert.equal(blob.ref.$link, 'bafy1');
  assert.match(calls[0].url, /com\.atproto\.repo\.uploadBlob$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('putRecord writes to the Echo collection, keyed by video id', async () => {
  const calls = [];
  const f = mockFetch(() => ({ body: { uri: 'at://did:plc:alice/dev.ssani.echo.entry/GRzaq5AHiV8' } }), calls);
  const { record } = entryToRecord(entry());
  await putRecord({ ...AUTH, rkey: 'GRzaq5AHiV8', record }, f);

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.collection, COLLECTION);
  assert.equal(sent.rkey, 'GRzaq5AHiV8');
  assert.equal(sent.repo, DID);
  assert.equal(sent.record.title, 'A talk');
});

test('listRecords is paged and returns a cursor', async () => {
  const calls = [];
  const f = mockFetch(() => ({ body: { records: [{ uri: 'at://x/y/z', value: { videoId: 'a' } }], cursor: 'next-page' } }), calls);
  const page = await listRecords({ ...AUTH, limit: 50 }, f);

  assert.equal(page.records.length, 1);
  assert.equal(page.cursor, 'next-page');
  assert.match(calls[0].url, /limit=50/);
  assert.match(calls[0].url, /collection=dev\.ssani\.echo\.entry/);
});

test('listRecords clamps a silly limit rather than passing it on', async () => {
  const calls = [];
  const f = mockFetch(() => ({ body: { records: [] } }), calls);
  await listRecords({ ...AUTH, limit: 10_000 }, f);
  assert.match(calls[0].url, /limit=100/, 'above the ceiling clamps down');

  // 0 and nonsense fall through to the default rather than to 1 — "asked for
  // nothing" reads as "did not ask", which is what the caller meant.
  await listRecords({ ...AUTH, limit: 0 }, f);
  assert.match(calls[1].url, /limit=50/);
  await listRecords({ ...AUTH, limit: -5 }, f);
  assert.match(calls[2].url, /limit=1$/, 'a negative is still floored at 1');
});

test('fetchBlob returns bytes', async () => {
  const f = mockFetch(() => ({ bytes: new TextEncoder().encode('[{"text":"hi"}]') }));
  const bytes = await fetchBlob({ ...AUTH, cid: 'bafy1' }, f);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), [{ text: 'hi' }]);
});

test('deleteRecord names the right record', async () => {
  const calls = [];
  const f = mockFetch(() => ({ body: {} }), calls);
  await deleteRecord({ ...AUTH, rkey: 'GRzaq5AHiV8' }, f);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { repo: DID, collection: COLLECTION, rkey: 'GRzaq5AHiV8' });
});

test('the failures a sync has to tell apart', async () => {
  const expired = mockFetch(() => ({ status: 401, body: { error: 'ExpiredToken' } }));
  await assert.rejects(
    () => listRecords(AUTH, expired),
    (e) => e.status === 401 && /session has expired/i.test(e.message)
  );

  // A rate limit must NOT read as a failure to sync: the work is resumable,
  // and telling someone their library is broken would be wrong.
  const limited = mockFetch(() => ({ status: 429, body: { error: 'RateLimitExceeded' } }));
  await assert.rejects(
    () => listRecords(AUTH, limited),
    (e) => e.status === 429 && /picks? up where it left off|left off/i.test(e.hint)
  );

  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => listRecords(AUTH, down), /Could not reach/);
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

test('pacing is per INSTANCE, and waits out the window rather than hitting it', async () => {
  resetPacing();
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  let clock = 1_000_000;
  const now = () => clock;

  // The limit is per IP, and every user's sync leaves from the same one, so the
  // budget is shared across owners rather than counted per owner.
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) await pace(sleep, now);
  assert.equal(slept.length, 0, 'nothing waits until the budget is actually spent');

  await pace(sleep, now);
  assert.equal(slept.length, 1, 'the next call waits');
  assert.ok(slept[0] > 0 && slept[0] <= WINDOW_MS);

  // A fresh window costs nothing again.
  clock += WINDOW_MS + 1;
  await pace(sleep, now);
  assert.equal(slept.length, 1);
  resetPacing();
});
