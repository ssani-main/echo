// Gap 38: a nested array literal held in `unknown`, read with Array.isArray, traps. Node prints [-1,2].
// Seshat: trap: an array of a union type held in `unknown` can't be read as `unknown[]` yet
// The same values from JSON.parse work.
function lengthOf(v: unknown): number { return Array.isArray(v) ? v.length : -1; }
const xs: unknown[] = [1, [2, null]];
console.log(JSON.stringify(xs.map(lengthOf)));
