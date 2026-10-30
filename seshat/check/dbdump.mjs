// Prints a library database's rows, timestamps masked, so check/routes.sh can compare the two sides' twin
// copies: node seshat/check/dbdump.mjs <library.db>
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const mask = (v) => (typeof v === 'string' ? v.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<iso>') : v);
const dump = (sql) => db.prepare(sql).all().map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, mask(v)]))));
console.log('user_version', JSON.stringify(db.prepare('PRAGMA user_version').get()));
for (const line of dump('SELECT rowid, * FROM videos ORDER BY rowid')) console.log('videos', line);
for (const line of dump('SELECT rowid, * FROM tags ORDER BY rowid')) console.log('tags', line);
for (const line of dump('SELECT rowid, * FROM videos_fts ORDER BY rowid')) console.log('fts', line);
db.close();
