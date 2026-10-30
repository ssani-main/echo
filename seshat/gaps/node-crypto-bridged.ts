// Gap 52: `import { createHash } from 'node:crypto'` goes through the npm bridge ("npm packages need
// JavaScriptCore") on Windows, while 'std/crypto' has the same functions natively. Node prints ca97.
import { createHash } from 'node:crypto';
console.log(createHash('sha256').update('a').digest('hex').slice(0, 4));
