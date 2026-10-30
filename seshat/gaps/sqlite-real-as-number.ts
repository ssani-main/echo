// Gap 36: a REAL read into a row field typed number fails. Bun prints {"x":1.5}.
// Seshat: uncaught SQLiteError: a row doesn't fit the expected type: Expected an integer but found 1.5
import { Database } from 'bun:sqlite';
const db = new Database(':memory:');
console.log(JSON.stringify(db.query('SELECT 1.5 AS x').get<{ x: number }>()));
