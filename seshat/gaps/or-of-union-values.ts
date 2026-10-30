// Gap 47: `a || b` on two `string | string[] | undefined` values: at the top level the generated C doesn't
// compile ('u10' undeclared); in the Seshat service's route function it built and crashed (access violation).
// Node prints a, b "https://youtu.be/GRzaq5AHiV8", c GRzaq5AHiV8.
import { extractVideoId } from '../text.ts';
function queryRaw(url: string, name: string): string | string[] | undefined {
  const all = new URL(url).searchParams.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return all;
}
const u = 'http://x/api/video-meta?url=https%3A%2F%2Fyoutu.be%2FGRzaq5AHiV8';
const rawId = queryRaw(u, 'videoId');
console.log('a');
const either = rawId || queryRaw(u, 'url');
console.log('b', JSON.stringify(either ?? null));
console.log('c', extractVideoId(either));
