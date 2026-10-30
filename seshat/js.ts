// JavaScript's own conversions, for values that arrive as JSON (`unknown`), where the originals lean on
// JavaScript doing them implicitly.

/** String(v) for a JSON value: arrays joined with commas (null and undefined as ''), objects as [object Object]. */
export function jsString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((e) => (e === null || e === undefined ? '' : jsString(e))).join(',');
  return '[object Object]';
}

/** `v.key` as JavaScript reads it off any value: a TypeError on null and undefined, nothing off a primitive. */
export function prop(v: unknown, key: string): unknown {
  if (v === null || v === undefined) throw new TypeError(`Cannot read properties of ${v === null ? 'null' : 'undefined'} (reading '${key}')`);
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  return (v as Record<string, unknown>)[key];
}

/** `v?.key`. */
export function optProp(v: unknown, key: string): unknown {
  return v === null || v === undefined ? undefined : prop(v, key);
}

/** v if it is an array, else []: where the originals iterate a JSON value they expect to be one. */
export function arrayOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const none: unknown[] = [];
  return none;
}
