import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdsSync } from '../pdsSync.js';
import { resetPacing } from '../pds.js';

// ---------------------------------------------------------------------------
// Keeping a repository in step with a library.
//
// Every dependency is injected, so nothing here can reach a real account. The
// cases that matter are the ones that lose data or lose a session: rotation
// order, a blob that fails after its record would have been written, and a
// restore that gives up part way.
// ---------------------------------------------------------------------------

/** A fake PDS that records what it was asked to do. */
function fakePds({ pages = [], failBlobFor = null, failUpload = false } = {}) {
  const calls = [];
  const blobs = new Map();
  let refreshCount = 0;

  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const ok = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    });

    if (u.includes('refreshSession')) {
      refreshCount += 1;
      return ok({ did: 'did:plc:alice', handle: 'alice.test', accessJwt: `access-${refreshCount}`, refreshJwt: `refresh-${refreshCount}` });
    }
    if (u.includes('uploadBlob')) {
      if (failUpload) return ok({ error: 'BlobTooLarge' }, 400);
      const cid = `bafy-${blobs.size + 1}`;
      blobs.set(cid, init.body);
      return ok({ blob: { $type: 'blob', ref: { $link: cid }, size: init.body.byteLength } });
    }
    if (u.includes('putRecord')) return ok({ uri: 'at://did:plc:alice/x/y' });
    if (u.includes('deleteRecord')) return ok({});
    if (u.includes('listRecords')) {
      const page = pages.shift() || { records: [] };
      return ok(page);
    }
    if (u.includes('getBlob')) {
      const cid = new URL(u).searchParams.get('cid');
      if (failBlobFor && cid === failBlobFor) return ok({ error: 'BlobNotFound' }, 404);
      const stored = blobs.get(cid);
      return {
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => (stored ? stored.buffer ?? stored : new TextEncoder().encode('[]').buffer),
      };
    }
    throw new Error(`unexpected call: ${u}`);
  };

  return { fetchImpl, calls, get refreshCount() { return refreshCount; } };
}

function harness(pdsOpts, { tokens = { did: 'did:plc:alice', pdsUrl: 'https://pds.test', refreshJwt: 'sealed:refresh-0' } } = {}) {
  const pds = fakePds(pdsOpts);
  const saved = [];
  let clock = 1_000_000;
  const store = { current: tokens };

  const sync = createPdsSync({
    getTokens: () => store.current,
    saveTokens: (t) => { saved.push(t); store.current = { ...store.current, ...t }; },
    seal: (s) => `sealed:${s}`,
    open: (s) => (typeof s === 'string' && s.startsWith('sealed:') ? s.slice(7) : null),
    fetchImpl: pds.fetchImpl,
    now: () => clock,
  });

  return { sync, pds, saved, store, tick: (ms) => { clock += ms; } };
}

const entry = (over = {}) => ({
  videoId: 'GRzaq5AHiV8',
  url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8',
  title: 'A talk',
  savedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  segments: [{ start: 0, text: 'hello world' }],
  digest: '# A talk',
  tags: ['talks'],
  ...over,
});

test.beforeEach(() => resetPacing());

// ---------------------------------------------------------------------------
// Token rotation — the thing that loses sessions if it is done backwards
// ---------------------------------------------------------------------------

test('the rotated refresh token is persisted BEFORE the access token is used', async () => {
  const { sync, saved, pds } = harness();
  await sync.pushEntry('u1', entry());

  // Refresh tokens rotate: the stored one dies the instant the refresh
  // succeeds. Persisting after the write would mean a crash mid-write signs the
  // user out of Bluesky permanently.
  assert.equal(saved.length, 1, 'exactly one persist');
  assert.equal(saved[0].refreshJwt, 'sealed:refresh-1', 'the NEW token is what was stored');

  const persistIndex = pds.calls.findIndex((c) => c.url.includes('refreshSession'));
  const writeIndex = pds.calls.findIndex((c) => c.url.includes('uploadBlob'));
  assert.ok(persistIndex < writeIndex, 'refresh happens before any write');
});

test('the access token is cached, so a burst of saves does not re-refresh', async () => {
  const { sync, pds, tick } = harness();
  for (let i = 0; i < 5; i++) await sync.pushEntry('u1', entry({ videoId: `vid0000000${i}` }));
  assert.equal(pds.refreshCount, 1, 'one refresh for five writes');

  // ...but not past the shortest documented access-token lifetime.
  tick(5 * 60_000);
  await sync.pushEntry('u1', entry({ videoId: 'laterentry1' }));
  assert.equal(pds.refreshCount, 2);
});

test('a user with no stored credentials is a no-op, not an error', async () => {
  const { sync } = harness({}, { tokens: null });
  assert.deepEqual(await sync.pushEntry('u1', entry()), { ok: false, reason: 'no_credentials' });
  assert.deepEqual(await sync.removeEntry('u1', 'GRzaq5AHiV8'), { ok: false, reason: 'no_credentials' });
});

test('a token sealed under a different key reads as no credentials', async () => {
  // Rotating ECHO_ATPROTO_SECRET makes every stored token unopenable. That is a
  // sign-in-again situation, not a sync error to shout about.
  const { sync } = harness({}, { tokens: { did: 'did:plc:alice', pdsUrl: 'https://pds.test', refreshJwt: 'garbage' } });
  assert.deepEqual(await sync.pushEntry('u1', entry()), { ok: false, reason: 'no_credentials' });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test('the blob is uploaded before the record that points at it', async () => {
  const { sync, pds } = harness();
  await sync.pushEntry('u1', entry());

  const upload = pds.calls.findIndex((c) => c.url.includes('uploadBlob'));
  const put = pds.calls.findIndex((c) => c.url.includes('putRecord'));
  assert.ok(upload < put, 'a record written first would point at nothing');

  const record = JSON.parse(pds.calls[put].init.body).record;
  assert.equal(record.transcript.ref.$link, 'bafy-1');
  assert.equal(record.segments, undefined, 'the transcript is not inline');
  assert.equal(record.title, 'A talk');
});

test('a failed blob upload means no record is written at all', async () => {
  const { sync, pds } = harness({ failUpload: true });
  await assert.rejects(() => sync.pushEntry('u1', entry()));

  // The failure has to be the harmless one: an orphan blob is garbage the PDS
  // collects, an orphan record is a library row that cannot be opened.
  assert.equal(pds.calls.some((c) => c.url.includes('putRecord')), false);
});

test('an unusable video id never reaches the network', async () => {
  const { sync, pds } = harness();
  assert.deepEqual(await sync.pushEntry('u1', entry({ videoId: '../../evil' })), { ok: false, reason: 'invalid_key' });
  assert.equal(pds.calls.length, 0);
});

test('removing an entry deletes its record', async () => {
  const { sync, pds } = harness();
  assert.deepEqual(await sync.removeEntry('u1', 'GRzaq5AHiV8'), { ok: true });
  const del = pds.calls.find((c) => c.url.includes('deleteRecord'));
  assert.equal(JSON.parse(del.init.body).rkey, 'GRzaq5AHiV8');
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('a restore walks every page and streams entries out one at a time', async () => {
  const rec = (videoId, cid) => ({
    uri: `at://did:plc:alice/dev.ssani.echo.entry/${videoId}`,
    value: {
      videoId, url: `https://youtu.be/${videoId}`, title: `Title ${videoId}`,
      savedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      segmentCount: 1, tags: [],
      ...(cid ? { transcript: { $type: 'blob', ref: { $link: cid }, size: 10 } } : {}),
    },
  });

  const { sync } = harness({
    pages: [
      { records: [rec('vid000000001'), rec('vid000000002')], cursor: 'page-2' },
      { records: [rec('vid000000003')], cursor: null },
    ],
  });

  const seen = [];
  const result = await sync.pullAll('u1', { onEntry: (e) => { seen.push(e); } });

  assert.equal(result.restored, 3, 'the cursor was followed to the end');
  assert.deepEqual(seen.map((e) => e.videoId), ['vid000000001', 'vid000000002', 'vid000000003']);
  assert.equal(seen[0].title, 'Title vid000000001');
});

test('one unreadable blob does not end the restore', async () => {
  const rec = (videoId, cid) => ({
    value: {
      videoId, url: 'https://x', title: videoId, savedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z', segmentCount: 1, tags: [],
      transcript: { $type: 'blob', ref: { $link: cid }, size: 10 },
    },
  });

  const { sync } = harness({
    pages: [{ records: [rec('vid000000001', 'missing-cid'), rec('vid000000002', 'bafy-ok')], cursor: null }],
    failBlobFor: 'missing-cid',
  });

  const seen = [];
  const result = await sync.pullAll('u1', { onEntry: (e) => { seen.push(e); } });

  // Stopping at entry 1 of 300 because one blob is gone would be the worst
  // possible reading of "restore my library".
  assert.equal(result.restored, 2);
  assert.deepEqual(seen[0].segments, [], 'the broken one comes back without its transcript');
  assert.equal(seen[0].title, 'vid000000001', 'but with everything else intact');
});

test('a record with no videoId is skipped, not restored as a blank', async () => {
  const { sync } = harness({
    pages: [{ records: [{ value: { title: 'junk from another app' } }, { value: { videoId: 'goodvid00001', title: 'ok', savedAt: '', updatedAt: '', tags: [] } }], cursor: null }],
  });
  const seen = [];
  const result = await sync.pullAll('u1', { onEntry: (e) => { seen.push(e); } });

  // A repository is shared with every other atproto app; foreign or malformed
  // records in the collection are a normal thing to meet, not a crash.
  assert.equal(result.restored, 1);
  assert.equal(result.skipped, 1);
  assert.equal(seen[0].videoId, 'goodvid00001');
});

test('a restore can skip transcripts entirely when only metadata is wanted', async () => {
  const { sync, pds } = harness({
    pages: [{ records: [{ value: { videoId: 'vid000000001', title: 'x', tags: [], transcript: { ref: { $link: 'bafy-1' } } } }], cursor: null }],
  });
  await sync.pullAll('u1', { onEntry: () => {}, withTranscripts: false });
  assert.equal(pds.calls.some((c) => c.url.includes('getBlob')), false, 'no blob fetched');
});
