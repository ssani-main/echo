import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChannelPage } from '../discovery.js';

// ---------------------------------------------------------------------------
// buildChannelPage — pure mapping/thumbnail-fallback/hasMore logic used by
// getChannelUploadsPage. No yt-dlp/network involved.
// ---------------------------------------------------------------------------

test('buildChannelPage maps entries to cards and preserves an existing thumbnail', () => {
  const entries = [
    {
      id: 'vid1',
      title: 'First video',
      channel: 'Some Channel',
      duration: 125,
      view_count: 1000,
      thumbnails: [{ url: 'https://example.com/thumb-small.jpg' }, { url: 'https://example.com/thumb-big.jpg' }],
    },
  ];

  const { items, hasMore } = buildChannelPage(entries, 12);
  assert.equal(items.length, 1);
  assert.equal(items[0].videoId, 'vid1');
  assert.equal(items[0].title, 'First video');
  assert.equal(items[0].thumbnail, 'https://example.com/thumb-big.jpg');
  assert.equal(hasMore, false); // 1 item returned, page size 12 -> short page
});

test('buildChannelPage falls back to the hqdefault thumbnail when the entry has none', () => {
  const entries = [{ id: 'vid2', title: 'No thumb', thumbnails: [] }];
  const { items } = buildChannelPage(entries, 12);
  assert.equal(items[0].thumbnail, 'https://i.ytimg.com/vi/vid2/hqdefault.jpg');
});

test('buildChannelPage falls back when thumbnails field is missing entirely', () => {
  const entries = [{ id: 'vid3', title: 'Missing thumbnails key' }];
  const { items } = buildChannelPage(entries, 12);
  assert.equal(items[0].thumbnail, 'https://i.ytimg.com/vi/vid3/hqdefault.jpg');
});

test('buildChannelPage skips entries with no id', () => {
  const entries = [{ title: 'No id' }, { id: 'vid4', title: 'Has id' }];
  const { items } = buildChannelPage(entries, 12);
  assert.equal(items.length, 1);
  assert.equal(items[0].videoId, 'vid4');
});

test('buildChannelPage sets hasMore=true when the page is exactly full', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}` }));
  const { items, hasMore } = buildChannelPage(entries, 5);
  assert.equal(items.length, 5);
  assert.equal(hasMore, true);
});

test('buildChannelPage sets hasMore=false for a short (end-of-catalog) page', () => {
  const entries = Array.from({ length: 3 }, (_, i) => ({ id: `v${i}` }));
  const { items, hasMore } = buildChannelPage(entries, 12);
  assert.equal(items.length, 3);
  assert.equal(hasMore, false);
});

test('buildChannelPage returns hasMore=false and empty items for an empty page', () => {
  const { items, hasMore } = buildChannelPage([], 12);
  assert.deepEqual(items, []);
  assert.equal(hasMore, false);
});

// ---------------------------------------------------------------------------
// Pagination math sanity check (offset -> playlist-start/end), mirrored here
// as a pure computation since the real call spawns yt-dlp.
// ---------------------------------------------------------------------------

test('offset/limit maps to 1-indexed inclusive playlist-start/end', () => {
  function toPlaylistRange(offset, limit) {
    return { start: offset + 1, end: offset + limit };
  }
  assert.deepEqual(toPlaylistRange(0, 12), { start: 1, end: 12 });
  assert.deepEqual(toPlaylistRange(12, 12), { start: 13, end: 24 });
  assert.deepEqual(toPlaylistRange(24, 6), { start: 25, end: 30 });
});

// ---------------------------------------------------------------------------
// seen/saved annotation logic (mirrors the route's per-item annotation)
// ---------------------------------------------------------------------------

test('annotating items with seen/saved sets from Sets works as expected', () => {
  const items = [{ videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' }];
  const seenSet = new Set(['a']);
  const savedIds = new Set(['b', 'c']);

  const annotated = items.map((item) => ({
    ...item,
    seen: seenSet.has(item.videoId),
    saved: savedIds.has(item.videoId),
  }));

  assert.deepEqual(annotated, [
    { videoId: 'a', seen: true, saved: false },
    { videoId: 'b', seen: false, saved: true },
    { videoId: 'c', seen: false, saved: true },
  ]);
});
