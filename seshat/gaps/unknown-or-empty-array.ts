// Gap 40: `x || []` with x unknown is refused (T0301 can't infer the element type of an empty array);
// TypeScript types it unknown. Node prints [] and [1].
function orEmpty(x: unknown): string { return JSON.stringify(x || []); }
console.log(orEmpty(null), orEmpty([1]));
