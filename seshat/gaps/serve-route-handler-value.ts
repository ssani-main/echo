// Bun.serve's routes take a handler written inline, but not a function value that has the same type.
// Reference: `bun run` (Node has no Bun.serve); prints "ok", then "done".
const ok = (_req: Request): Response => new Response('ok')
const server = Bun.serve({ port: 0, routes: { "/a": { GET: ok } }, fetch() { return new Response('missing', { status: 404 }) } })
console.log(await (await fetch(`http://127.0.0.1:${server.port}/a`)).text())
console.log('done')
server.stop()
