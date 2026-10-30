// Gap 39: String() of an array writes a nested array's null as "null"; JavaScript writes nothing there.
// Node prints "1,,x,3|1,,x,3"; Seshat "1,null,x,3|...".
const v: unknown = JSON.parse('[1, [null, "x"], 3]');
console.log(String(v) + '|' + (Array.isArray(v) ? v.join(',') : ''));
