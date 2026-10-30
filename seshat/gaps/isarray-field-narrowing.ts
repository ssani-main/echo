// Gap 41: Array.isArray on a field access doesn't narrow that access (T0001 expected unknown[], found unknown);
// TypeScript narrows `rec.tags` in the true branch. Node prints 2.
function count(xs: unknown[]): number { return xs.length; }
const rec: Record<string, unknown> = { tags: ['a', 'b'] };
console.log(count(Array.isArray(rec.tags) ? rec.tags : []));
