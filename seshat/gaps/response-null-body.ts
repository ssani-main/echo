// TypeScript's Response takes `BodyInit | null`, and `null` is the usual body of a 204. Node prints 204 "".
// Seshat: error[T0001] response-null-body.ts:4:26: expected `string | URLSearchParams | u8[] | Blob | FormData |
// ReadableStream | undefined`, found `null`
const res = new Response(null, { status: 204 });
console.log(res.status, JSON.stringify(await res.text()));
