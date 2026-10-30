// Gap 44: an async function that awaits fetch (or a function that can throw, like youtube.ts's
// fetchTranscript) doesn't go where a `(…) => Promise<Response>` type is expected: T0001, "found
// `((…) => Promise<Response>) | ((…) => Promise<Response, Error>)`". TypeScript has no thrown-type in Promise.
// Node prints function.
type FetchFn = (url: string) => Promise<Response>;
async function viaGlobal(url: string): Promise<Response> {
  return await fetch(url);
}
function pick(given: FetchFn | undefined): FetchFn {
  return given ?? viaGlobal;
}
console.log(typeof pick(undefined));
