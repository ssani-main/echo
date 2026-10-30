// Gap 35: a number held in `unknown` (here from JSON.parse) is bound to a bun:sqlite parameter as a truncated
// integer: 1.5 is stored as 1. A typed number and an any[] element store 1.5. Bun prints [{"v":1.5,"t":"real"}].
import { Database } from 'bun:sqlite';
const db = new Database(':memory:');
db.exec('CREATE TABLE t (v)');
const parsed: unknown = JSON.parse('[1.5]');
if (Array.isArray(parsed)) db.query('INSERT INTO t VALUES (?)').run(parsed[0]);
console.log(JSON.stringify(db.query('SELECT v, typeof(v) AS t FROM t').all<{ v: unknown; t: string }>()));
