// store.js against store.ts: one scripted library session, each step's result printed. The database is
// ECHO_DB_PATH, set by run.mjs (store.js reads it when it loads), and removed first. Timestamps are masked;
// saves are 3 ms apart so the newest-first order never rests on a tie.
// Not covered: the legacy library.json import (it only runs without ECHO_DB_PATH, on the real data folder).
import {
  forOwner, dbPathFor, closeAllLibraries, DEFAULT_OWNER,
  countEntries, listEntries, getEntry, saveEntry, deleteEntry, setTags, searchSummaries,
} from '../store.ts';
import { Database } from 'bun:sqlite';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { out } from './out.ts';

const dbFile = process.env.ECHO_DB_PATH!;
const dataDir = dirname(dbFile);
const libraries = join(dataDir, 'libraries');
for (const f of [dbFile, join(libraries, 'old.db'), join(libraries, 'u_1.db')]) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(f + suffix, { force: true });
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function show(name: string, value: unknown): void {
  out(name, JSON.parse(JSON.stringify(value ?? null).replace(ISO, '<iso>')));
}
async function step(name: string, f: () => Promise<unknown>): Promise<void> {
  try {
    show(name, await f());
  } catch (e) {
    show(name, e instanceof Error ? `ERR ${e.name}: ${e.message}` : 'ERR (not an Error)');
  }
}
const pause = () => new Promise<void>((r) => setTimeout(r, 3));

// --- paths
show('path local', dbPathFor(DEFAULT_OWNER) === dbFile);
show('path owner', dbPathFor('u_1') === join(libraries, 'u_1.db'));
for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'é', 'a b']) await step(`path ${bad.slice(0, 12)}`, async () => dbPathFor(bad));

// --- empty library
await step('count empty', () => countEntries());
await step('list empty', () => listEntries());
await step('list empty paged', () => listEntries({ limit: 5 }));
await step('search empty', () => searchSummaries('anything'));

// --- saves
const words = (n: number, w: string) => Array.from({ length: n }, (_: unknown, i: number) => `${w}${i}`).join(' ');
await step('save a', () => saveEntry({
  videoId: 'aaaaaaaaaaa', url: ' https://www.youtube.com/watch?v=aaaaaaaaaaa ', title: 'Straße café 🎉 learning',
  segments: [{ text: words(40, 'intro') }, { text: 'machine learning matters' }, { text: words(40, 'outro') }],
  digest: '## TL;DR\n\nLearning is fun.', channel: 'Chan', channelUrl: 'https://youtube.com/@chan',
  transcriptSource: 'captions', whisperModel: null,
}));
await pause();
// Built by JSON.parse, as the route gets them (as literals they trap in Seshat, gap: union-array-in-unknown).
const junkSegments: unknown[] = JSON.parse(`[5, "str", [1, 2], {}, {"text": 0}, {"text": false}, {"text": 12.5},
  {"text": [1, [null, "x"], 3]}, {"text": {"a": 1}}, {"text": true}, {"other": "y"}, {"text": "  spaced  "}]`);
const junkTags: unknown[] = JSON.parse('[" ai ", "ai", "", null, 5, 1.5, true, {}, [1, [2, null]], "ML"]');
await step('save b junk segments', () => saveEntry({
  videoId: 'bbbbbbbbbbb', url: 'javascript:alert(1)', title: '', segments: junkSegments, digest: '',
  tags: [...junkTags, ...Array.from({ length: 25 }, (_: unknown, i: number) => `t${i}`)],
}));
await pause();
await step('save c minimal', () => saveEntry({ videoId: 'ccccccccccc', segments: [{ text: 'gamma' }] }));
await pause();
await step('save d null segment', () => saveEntry({ videoId: 'ddddddddddd', title: 'half saved', segments: [{ text: 'ok' }, null] }));
await pause();
await step('get d after the throw', () => getEntry('ddddddddddd'));
await step('save no segments', () => saveEntry({ videoId: 'eeeeeeeeeee', url: 'http://x.test/', segments: null, title: 'empty' }));
await pause();

// --- update keeps what the payload omits
await step('update a partial', () => saveEntry({ videoId: 'aaaaaaaaaaa', segments: [{ text: 'rewritten deep learning' }], title: 'A two' }));
await step('get a', () => getEntry('aaaaaaaaaaa'));
await step('update a clears', () => saveEntry({
  videoId: 'aaaaaaaaaaa', url: 'ftp://nope', segments: [{ text: 'x' }], channel: '', channelUrl: null,
  transcriptSource: 'whisper', whisperModel: 'small', digest: 'New digest', tags: ['z', 'y', 'z'],
}));
await step('get a again', () => getEntry('aaaaaaaaaaa'));
await step('update c url null keeps', () => saveEntry({ videoId: 'ccccccccccc', url: null, segments: [{ text: 'gamma two' }], transcriptSource: null }));

// --- reads
await step('count', () => countEntries());
await step('list', () => listEntries());
for (const opts of [{ limit: 2 }, { limit: 2, offset: 2 }, { limit: 2.9, offset: 1.5 }, { limit: 0 }, { limit: -1 }, { limit: NaN },
  { limit: Infinity }, { offset: 3 }, { limit: 1, offset: -4 }, { limit: 10, offset: 99 }]) {
  await step(`list ${JSON.stringify(opts)}`, () => listEntries(opts));
}
await step('get missing', () => getEntry('nope'));

// --- tags
await step('tags b', () => setTags('bbbbbbbbbbb', JSON.parse('["  one ", "two", "one", 7, null]')));
await step('tags not array', () => setTags('bbbbbbbbbbb', 'ai'));
await step('tags missing entry', () => setTags('nope', ['x']));
await step('tags c', () => setTags('ccccccccccc', ['gamma']));

// --- search
for (const [q, limit] of [['learning', undefined], ['café', undefined], ['GAMMA', undefined], ['"unterminated', undefined],
  ['AND OR', undefined], ['', undefined], ['   ', undefined], ['spaced', 1], ['learning OR gamma', 0], ['learning OR gamma', 1000],
  ['learning OR gamma', NaN], ['learning OR gamma', 1], ['intro5', undefined], ['zzz', undefined], ['digest', undefined]] as [string, number | undefined][]) {
  await step(`search ${q} ${limit}`, () => searchSummaries(q, limit));
}

// --- delete
await step('delete b', () => deleteEntry('bbbbbbbbbbb'));
await step('delete b again', () => deleteEntry('bbbbbbbbbbb'));
await step('search after delete', () => searchSummaries('learning OR gamma OR spaced'));
await step('list after delete', () => listEntries());

// --- owners: a second library is a separate file
const owner = forOwner('u_1');
await step('owner save', () => owner.saveEntry({ videoId: 'ownerowner1', segments: [{ text: 'private' }], title: 'Mine' }));
await step('owner list', () => owner.listEntries());
await step('owner count', () => owner.countEntries());
await step('default does not see it', () => searchSummaries('private'));
await step('owner search', () => owner.searchSummaries('private'));
await step('bad owner', () => forOwner('../evil').countEntries());

// --- a library from before the migrations: no segment_count/channel/transcript columns, FTS rows on other rowids
mkdirSync(libraries, { recursive: true });
const old = new Database(join(libraries, 'old.db'));
old.exec(`CREATE TABLE videos (videoId TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, savedAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  segments TEXT NOT NULL DEFAULT '[]', digest TEXT, favorite INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tags (videoId TEXT NOT NULL REFERENCES videos(videoId) ON DELETE CASCADE, tag TEXT NOT NULL, UNIQUE(videoId, tag));
CREATE VIRTUAL TABLE videos_fts USING fts5(videoId UNINDEXED, title, transcript_text, digest);
INSERT INTO videos VALUES ('old1', 'https://a', 'Old one', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '[{"text":"ancient wisdom"},{"text":"more"}]', 'old digest', 0);
INSERT INTO videos VALUES ('old2', 'https://b', 'Old two', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '[{"text":"second"}]', NULL, 1);
INSERT INTO tags VALUES ('old1', 'history');
INSERT INTO videos_fts (rowid, videoId, title, transcript_text, digest) VALUES (7, 'old1', 'stale title', 'stale text', '');`);
old.close();
const migrated = forOwner('old');
await step('old list', () => migrated.listEntries());
await step('old search ancient', () => migrated.searchSummaries('ancient'));
await step('old search stale', () => migrated.searchSummaries('stale'));
const check = new Database(join(libraries, 'old.db'));
show('old columns', check.query('PRAGMA table_info(videos)').all<{ name: string }>().map((c) => c.name));
show('old user_version', check.query('PRAGMA user_version').get<{ user_version: number }>());
show('old fts rowids', check.query('SELECT rowid, videoId FROM videos_fts ORDER BY rowid').all<{ rowid: number; videoId: string }>());
check.close();

closeAllLibraries();
show('closed, file kept', existsSync(dbFile));
