// `node --import ./original.mjs <mod>.cases.ts` runs a case file against the
// ORIGINAL Node module instead of the port: every import of a port file
// (seshat/<name>.ts) is redirected to the file it was ported from.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINALS = {
  'sanitize.ts': 'sanitize.js',
  'text.ts': 'common/text.js',
  'markdown.ts': 'markdown.js',
  'transcript.ts': 'transcript.js',
  'vault.ts': 'vault.js',
  'digest.ts': 'digest.js',
  'providers.ts': 'providers.js',
  'whisper.ts': 'whisper.js',
};

registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    const file = r.url.startsWith('file:') ? fileURLToPath(r.url) : '';
    const name = basename(file);
    // Only the ports themselves, never the case files in seshat/check/.
    if (ORIGINALS[name] && basename(dirname(file)) === 'seshat') {
      return { url: pathToFileURL(join(ROOT, ORIGINALS[name])).href, shortCircuit: true };
    }
    return r;
  },
});
