// Node prints a.1.jsonl. Seshat: "internal error: the generated C failed to compile (this is a bug in seshat)",
// ...: error: redeclaration of 'rec2' with no linkage (the top level is emitted twice, each copy declaring the
// regex literal's static cache). Needs both: a regex literal at the top level and an `await` in a top-level loop.
const r = 'a.jsonl'.replace(/\.jsonl$/, '.1.jsonl');
for (const n of [1, 2]) {
  await new Promise((ok) => setTimeout(ok, n));
}
console.log(r);
