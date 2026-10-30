// Gap 37: an object's JSON key order isn't its literal's order once the program has other interfaces sharing
// its fields. Not reduced yet: the two interfaces alone are laid out right; inside ../store.ts they aren't.
// Node prints Meta as declared (videoId, url, title, savedAt, hasDigest, segmentCount, tags, channel, ...);
// Seshat puts the fields Meta shares with store.ts's Entry first, in Entry's order, then hasDigest and
// segmentCount. Declaring Meta above Entry fixes Meta and breaks Entry (videoId, segments, url, ...).
//   ECHO_DB_PATH=<tmp>/library.db seshat run seshat/gaps/object-key-order.ts
//   ECHO_DB_PATH=<tmp>/library.db node --import ./seshat/check/node-bun.mjs seshat/gaps/object-key-order.ts
import { saveEntry, getEntry } from '../store.ts';
import { rmSync } from 'node:fs';
for (const s of ['', '-wal', '-shm']) rmSync(process.env.ECHO_DB_PATH! + s, { force: true });
const iso = /\d{4}-\d\d-\d\dT[\d:.]+Z/g;
console.log(JSON.stringify(await saveEntry({ videoId: 'a', segments: [] })).replace(iso, 'T'));
console.log(JSON.stringify(await getEntry('a')).replace(iso, 'T'));
