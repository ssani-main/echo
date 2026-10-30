// Under node, `bun:sqlite` is this stand-in over node:sqlite, so a port that uses it runs in the port@node row
// (and a case file's own Database in the original row). Only what the ports use: query (get/all/run), exec, close.
// It binds as node:sqlite does (every number a REAL), so it checks the port's logic, not bun:sqlite's.
import { registerHooks } from 'node:module';

const SHIM = `
import { DatabaseSync } from 'node:sqlite';
class Statement {
  constructor(s) { this.s = s; }
  get(...a) { return this.s.get(...a) ?? null; }
  all(...a) { return this.s.all(...a); }
  run(...a) { const r = this.s.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
}
export class Database {
  constructor(file) { this.db = new DatabaseSync(file); }
  query(sql) { return new Statement(this.db.prepare(sql)); }
  exec(sql) { this.db.exec(sql); }
  close() { this.db.close(); }
}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'bun:sqlite') return { url: 'data:text/javascript,' + encodeURIComponent(SHIM), shortCircuit: true };
    return next(specifier, context);
  },
});
