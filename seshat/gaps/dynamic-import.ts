// Node prints function. Seshat: error[P0004] dynamic-import.ts:3:24: expected an expression, found `import`
// (a module whose environment must be set before it loads is imported this way).
const { join } = await import('node:path');
console.log(typeof join);
