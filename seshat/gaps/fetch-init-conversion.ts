// Gap 43: passing an object of one's own init interface to the global fetch can be an internal compiler error:
//   error[C0003] youtube.ts:79:10: internal compiler error: no conversion from `FetchInit` to `RequestInit`
// Not reduced: this file, the same shapes cut out of youtube.ts, builds and prints 3 as Node does. To see it,
// replace the last two lines of youtube.ts's fetchWith (the init written out field by field) with
// `return await fetch(url, init);` and run `seshat run seshat/check/youtube.cases.ts`.
interface FetchInit { method?: string; headers: Record<string, string>; body?: string }
type FetchFn = (url: string, init: FetchInit) => Promise<Response>;
interface Config { fetch?: FetchFn }
async function fetchWith(config: Config | undefined, url: string, init: FetchInit): Promise<Response> {
  const given = config?.fetch;
  if (given) return await given(url, init);
  return await fetch(url, init);
}
async function send(): Promise<number> {
  try {
    await fetchWith({ fetch: async (_u: string, _i: FetchInit): Promise<Response> => new Response('') }, 'x', { headers: {} });
    await fetchWith(undefined, 'http://127.0.0.1:9/', { headers: { a: 'b' } });
  } catch {
    // The request itself doesn't matter, only that it builds.
  }
  return 3;
}
console.log(await send());
