// Gap 43: the global fetch doesn't go where one's own fetch type goes. Node prints function. In youtube.ts it
// showed as an internal compiler error (C0003, "no conversion from `FetchInit` to `RequestInit`"), which is why
// youtube.ts's fetchWith calls fetch itself with the init written out field by field.
interface FetchInit { method?: string; headers: Record<string, string>; body?: string }
type FetchFn = (url: string, init: FetchInit) => Promise<Response>;
const viaGlobal: FetchFn = fetch;
console.log(typeof viaGlobal);
