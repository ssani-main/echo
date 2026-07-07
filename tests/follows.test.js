import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-follows-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');
const { normalizeChannel } = await import('../discovery.js');

function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
}

test.after(cleanupDb);

// ---------------------------------------------------------------------------
// addFollow / listFollows / removeFollow
// ---------------------------------------------------------------------------

test('addFollow inserts a new follow with addedAt set and no lastCheckedAt', async () => {
  const follow = await store.addFollow({
    channelId: '@somechannel',
    title: 'Some Channel',
    url: 'https://www.youtube.com/@somechannel/videos',
  });

  assert.equal(follow.channelId, '@somechannel');
  assert.equal(follow.title, 'Some Channel');
  assert.equal(follow.url, 'https://www.youtube.com/@somechannel/videos');
  assert.ok(follow.addedAt);
  assert.equal(follow.lastCheckedAt, null);
});

test('addFollow on an existing channelId updates title/url but preserves addedAt', async () => {
  const first = await store.addFollow({
    channelId: 'UCabc123',
    title: 'Original Title',
    url: 'https://www.youtube.com/channel/UCabc123/videos',
  });

  await new Promise((r) => setTimeout(r, 5));

  const second = await store.addFollow({
    channelId: 'UCabc123',
    title: 'Updated Title',
    url: 'https://www.youtube.com/channel/UCabc123/videos',
  });

  assert.equal(second.title, 'Updated Title');
  assert.equal(second.addedAt, first.addedAt);
});

test('listFollows returns all followed channels ordered by addedAt ascending', async () => {
  const follows = await store.listFollows();
  const ids = follows.map((f) => f.channelId);
  assert.ok(ids.includes('@somechannel'));
  assert.ok(ids.includes('UCabc123'));

  // @somechannel was added first in this test file, so it should sort first
  // among these two.
  const idxSome = ids.indexOf('@somechannel');
  const idxAbc  = ids.indexOf('UCabc123');
  assert.ok(idxSome < idxAbc);
});

test('removeFollow deletes the follow and returns true; false for unknown channelId', async () => {
  await store.addFollow({
    channelId: 'to-remove',
    title: null,
    url: 'https://www.youtube.com/c/to-remove/videos',
  });

  const ok = await store.removeFollow('to-remove');
  assert.equal(ok, true);

  const stillThere = (await store.listFollows()).some((f) => f.channelId === 'to-remove');
  assert.equal(stillThere, false);

  const okAgain = await store.removeFollow('to-remove');
  assert.equal(okAgain, false);
});

// ---------------------------------------------------------------------------
// getSeenSet / recordSeen dedupe
// ---------------------------------------------------------------------------

test('getSeenSet is empty for a channel with no recorded views', async () => {
  const seen = await store.getSeenSet('never-checked');
  assert.ok(seen instanceof Set);
  assert.equal(seen.size, 0);
});

test('recordSeen records videoIds and getSeenSet reflects them; duplicates are deduped', async () => {
  await store.addFollow({
    channelId: 'seen-chan',
    title: 'Seen Chan',
    url: 'https://www.youtube.com/@seenchan/videos',
  });

  await store.recordSeen('seen-chan', ['vidA', 'vidB', 'vidA']);
  let seen = await store.getSeenSet('seen-chan');
  assert.equal(seen.size, 2);
  assert.ok(seen.has('vidA'));
  assert.ok(seen.has('vidB'));

  // Re-recording the same ids plus a new one should only add the new one.
  await store.recordSeen('seen-chan', ['vidA', 'vidC']);
  seen = await store.getSeenSet('seen-chan');
  assert.equal(seen.size, 3);
  assert.ok(seen.has('vidC'));
});

// ---------------------------------------------------------------------------
// touchChecked
// ---------------------------------------------------------------------------

test('touchChecked sets lastCheckedAt on the follow row', async () => {
  await store.addFollow({
    channelId: 'touch-chan',
    title: 'Touch Chan',
    url: 'https://www.youtube.com/@touchchan/videos',
  });

  let follow = (await store.listFollows()).find((f) => f.channelId === 'touch-chan');
  assert.equal(follow.lastCheckedAt, null);

  await store.touchChecked('touch-chan');

  follow = (await store.listFollows()).find((f) => f.channelId === 'touch-chan');
  assert.ok(follow.lastCheckedAt);
});

// ---------------------------------------------------------------------------
// follow_seen cascade on removeFollow
// ---------------------------------------------------------------------------

test('removeFollow clears follow_seen rows for that channel', async () => {
  await store.addFollow({
    channelId: 'cascade-chan',
    title: 'Cascade Chan',
    url: 'https://www.youtube.com/@cascadechan/videos',
  });
  await store.recordSeen('cascade-chan', ['vidX', 'vidY']);

  let seen = await store.getSeenSet('cascade-chan');
  assert.equal(seen.size, 2);

  await store.removeFollow('cascade-chan');

  seen = await store.getSeenSet('cascade-chan');
  assert.equal(seen.size, 0);
});

// ---------------------------------------------------------------------------
// normalizeChannel URL parsing (no yt-dlp / network involved)
// ---------------------------------------------------------------------------

test('normalizeChannel parses a /channel/UC... URL', () => {
  const { channelId, url } = normalizeChannel('https://www.youtube.com/channel/UCabcDEF123');
  assert.equal(channelId, 'UCabcDEF123');
  assert.equal(url, 'https://www.youtube.com/channel/UCabcDEF123/videos');
});

test('normalizeChannel parses a /channel/UC.../videos URL', () => {
  const { channelId, url } = normalizeChannel('https://www.youtube.com/channel/UCabcDEF123/videos');
  assert.equal(channelId, 'UCabcDEF123');
  assert.equal(url, 'https://www.youtube.com/channel/UCabcDEF123/videos');
});

test('normalizeChannel parses a /@handle URL', () => {
  const { channelId, url } = normalizeChannel('https://www.youtube.com/@SomeHandle');
  assert.equal(channelId, '@somehandle');
  assert.equal(url, 'https://www.youtube.com/@somehandle/videos');
});

test('normalizeChannel parses a bare @handle string', () => {
  const { channelId, url } = normalizeChannel('@SomeHandle');
  assert.equal(channelId, '@somehandle');
  assert.equal(url, 'https://www.youtube.com/@somehandle/videos');
});

test('normalizeChannel parses a /c/name URL', () => {
  const { channelId, url } = normalizeChannel('https://www.youtube.com/c/SomeName');
  assert.equal(channelId, 'c/somename');
  assert.equal(url, 'https://www.youtube.com/c/somename/videos');
});

test('normalizeChannel parses a /user/name URL', () => {
  const { channelId, url } = normalizeChannel('https://www.youtube.com/user/SomeUser');
  assert.equal(channelId, 'user/someuser');
  assert.equal(url, 'https://www.youtube.com/user/someuser/videos');
});

test('normalizeChannel throws an INVALID_URL-tagged error for garbage input', () => {
  assert.throws(() => normalizeChannel('not a url at all'), (err) => {
    assert.equal(err.echoCode, 'INVALID_URL');
    return true;
  });
});

test('normalizeChannel throws an INVALID_URL-tagged error for a non-YouTube URL', () => {
  assert.throws(() => normalizeChannel('https://example.com/channel/UC123'), (err) => {
    assert.equal(err.echoCode, 'INVALID_URL');
    return true;
  });
});

test('normalizeChannel throws an INVALID_URL-tagged error for empty input', () => {
  assert.throws(() => normalizeChannel(''), (err) => {
    assert.equal(err.echoCode, 'INVALID_URL');
    return true;
  });
});
