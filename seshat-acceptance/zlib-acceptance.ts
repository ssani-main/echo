// Acceptance tests for node:zlib as Echo's server uses it (server.js serveCached + the streamed export).
// Must pass unchanged under `node zlib-acceptance.ts` and `seshat run zlib-acceptance.ts`.
import { gzipSync, gunzipSync, brotliCompress, brotliDecompressSync, createGzip, constants } from "node:zlib"
import { promisify } from "node:util"

const brotliAsync = promisify(brotliCompress)
const enc = new TextEncoder()
const dec = new TextDecoder()

let failed = 0
async function check(name: string, body: () => Promise<void>) {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (e) {
    failed++
    console.log(`not ok - ${name}: ${(e as Error).message}`)
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const page = "<!doctype html><p>Résumé — Echo ✓</p>\n".repeat(5000)
const raw = enc.encode(page)

await check("gzipSync level 9 round-trips and writes a gzip header", async () => {
  const gz = gzipSync(raw, { level: 9 })
  assert(gz[0] === 0x1f && gz[1] === 0x8b, "no gzip magic bytes")
  assert(gz.length < raw.length / 10, `${gz.length} bytes from ${raw.length}`)
  assert(dec.decode(gunzipSync(gz)) === page, "round trip differs")
})

await check("gunzipSync reads gzip written by Node", async () => {
  // gzipSync("hello é", { level: 9 }) from Node 24, mtime 0.
  const fromNode = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 2, 10, 203, 72, 205, 201, 201, 87, 56, 188, 18, 0, 60, 108, 131, 136, 8, 0, 0, 0])
  assert(dec.decode(gunzipSync(fromNode)) === "hello é", "wrong text")
})

await check("promisified brotliCompress with QUALITY 11 and SIZE_HINT round-trips", async () => {
  const br = await brotliAsync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  })
  assert(br.length < gzipSync(raw, { level: 9 }).length, "brotli q11 not smaller than gzip -9")
  assert(dec.decode(brotliDecompressSync(br)) === page, "round trip differs")
})

await check("createGzip streams with write/drain/end", async () => {
  const gz = createGzip({ level: 6 })
  const parts: Uint8Array[] = []
  gz.on("data", (c: Uint8Array) => { parts.push(c) })
  const ended = new Promise<void>((r) => gz.on("end", () => r()))
  const line = enc.encode('{"videoId":"GRzaq5AHiV8","title":"Résumé"}\n')
  for (let i = 0; i < 20000; i++) {
    if (!gz.write(line)) await new Promise<void>((r) => gz.once("drain", () => r()))
  }
  gz.end()
  await ended
  const total = parts.reduce((n, p) => n + p.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const p of parts) { all.set(p, at); at += p.length }
  const text = dec.decode(gunzipSync(all))
  assert(parts.length > 1, "output arrived in one piece: buffered, not streamed")
  assert(text.length === 20000 * dec.decode(line).length && text.startsWith('{"videoId"'), "round trip differs")
})

console.log(failed ? `${failed} failed` : "all passed")
process.exit(failed ? 1 : 0)
