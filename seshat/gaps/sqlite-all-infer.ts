// Gap 32: Statement.all() without a type argument is refused (T0305); tsc (with @types/bun) gives unknown[].
// Bun prints [{"n":1}]. Needs bun:sqlite, so it runs under seshat or bun, not node.
import { Database } from 'bun:sqlite';
const db = new Database(':memory:');
console.log(JSON.stringify(db.query('SELECT 1 AS n').all()));
