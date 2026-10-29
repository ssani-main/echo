// Node prints true. Seshat: error[P0004] import-meta.ts:3:30: expected an expression, found `import`
// (usagelog.js finds its data/ folder from import.meta.url; Node 22 also has import.meta.dirname).
const here: string = new URL(import.meta.url).protocol;
console.log(here === 'file:');
