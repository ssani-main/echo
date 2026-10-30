// Gap 48: `Array.isArray(v) ? v : none` (v unknown, none: unknown[]) is `any[] | unknown[]`, which `for...of`
// refuses (T0402: needs an array or set) and which has no `map` (T0107). Node prints 2.
const v: unknown = JSON.parse('[1, 2]');
const none: unknown[] = [];
let n = 0;
for (const _ of Array.isArray(v) ? v : none) n++;
console.log(n);
