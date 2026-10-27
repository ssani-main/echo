// Acceptance tests for node:child_process as Echo uses it. Must pass unchanged
// under `node spawn-acceptance.ts` (the reference) and `seshat run spawn-acceptance.ts`.
// Run from this folder. Prints one ok/not ok line per test; exits 1 on any failure.
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { resolve, delimiter } from "node:path"

const isWin = process.platform === "win32"
const FAKE = resolve("fake-claude.mjs")
const BIN = resolve("bin")
const env = { ...process.env, PATH: BIN + delimiter + (process.env.PATH ?? "") }
const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

// Echo's exact launch: cmd.exe /c claude on Windows (claude is a .cmd), the binary in its own group on POSIX.
function spawnClaude(mode: string) {
  const args = [mode, "-p", "--output-format", "stream-json", "--verbose"]
  return spawn(isWin ? (process.env.ComSpec ?? "cmd.exe") : "claude", isWin ? ["/c", "claude", ...args] : args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpdir(),
    env,
    windowsHide: true,
    ...(isWin ? {} : { detached: true }),
  })
}

// Echo's killTree(): taskkill /T on Windows (killing cmd.exe alone orphans claude), the process group on POSIX.
function killTree(pid: number) {
  if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" }).on("error", () => {})
  else process.kill(-pid, "SIGKILL")
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

await check("streams NDJSON split in 7-byte writes; 360 KB prompt over stdin; UTF-8 kept whole", async () => {
  const child = spawnClaude("stream")
  child.stdout.setEncoding("utf8")
  let buf = ""
  let text = ""
  let result: { result: string; prompt_bytes: number } | undefined
  let chunks = 0
  let firstChunkAt = 0
  child.stdout.on("data", (chunk: string) => {
    chunks++
    if (!firstChunkAt) firstChunkAt = Date.now()
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const ev = JSON.parse(line)
      if (ev.type === "stream_event") text += ev.event.delta.text
      if (ev.type === "result") result = ev
    }
  })
  child.stdin.on("error", () => {})
  child.stdin.write("ab é\n".repeat(60000), "utf8") // 6 bytes each: 360000
  child.stdin.end()
  const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("close", (c, s) => r([c, s])))
  const closedAt = Date.now()
  assert(code === 0 && signal === null, `exit ${code} ${signal}`)
  assert(result !== undefined, "no result line")
  assert(result!.prompt_bytes === 360000, `child read ${result!.prompt_bytes} prompt bytes`)
  assert(text === result!.result, `deltas ${JSON.stringify(text)} != result ${JSON.stringify(result!.result)}`)
  assert(text.includes("Résumé — done ✓ 🎧"), "non-ASCII text damaged")
  assert(chunks > 1, "stdout arrived in one chunk: buffered, not streamed")
  assert(closedAt - firstChunkAt >= 250, "first output only arrived at exit: buffered, not streamed")
})

await check("80 MiB of stderr streams without a buffer limit", async () => {
  const child = spawn("node", [FAKE, "flood"], { windowsHide: true })
  let bytes = 0
  let out = ""
  child.stderr.on("data", (c: { length: number }) => { bytes += c.length })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (c: string) => { out += c })
  const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)))
  assert(code === 0, `exit ${code}`)
  assert(bytes === 80 * 1024 * 1024, `got ${bytes} stderr bytes`)
  assert(out === "done\n", `stdout ${JSON.stringify(out)}`)
})

await check("non-zero exit reports code and stderr", async () => {
  const child = spawnClaude("fail")
  let err = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (c: string) => { err += c })
  child.stdin.end()
  const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("close", (c, s) => r([c, s])))
  assert(code === 3 && signal === null, `exit ${code} ${signal}`)
  assert(err.includes("boom: not logged in"), `stderr ${JSON.stringify(err)}`)
})

await check("missing command emits 'error' with code ENOENT", async () => {
  const child = spawn("echo-no-such-command-xyz", [], { shell: false })
  const err = await new Promise<NodeJS.ErrnoException>((r) => child.on("error", (e) => r(e)))
  assert(err.code === "ENOENT", `code ${err.code}`)
})

await check("tree kill mid-stream leaves no orphan; pending stdin write does not crash", async () => {
  const child = spawnClaude("hang")
  child.stdout.setEncoding("utf8")
  let buf = ""
  const pids = await new Promise<{ fake: number; grandchild: number }>((r) => {
    child.stdout.on("data", (c: string) => {
      buf += c
      const nl = buf.indexOf("\n")
      if (nl >= 0 && buf.startsWith('{"type":"pids"')) r(JSON.parse(buf.slice(0, nl)))
    })
  })
  // The fake never reads stdin, so this write is still pending when the tree dies (EPIPE must not escape).
  child.stdin.on("error", () => {})
  child.stdin.write("x".repeat(2 * 1024 * 1024))
  child.stdin.end()
  await sleep(150) // let a few deltas arrive: kill mid-stream
  const closed = new Promise<void>((r) => child.on("close", () => r()))
  killTree(child.pid!)
  // An orphan holds stdout open, so 'close' never fires: report that instead of hanging.
  const closedInTime = await Promise.race([closed.then(() => true), sleep(5000).then(() => false)])
  const all = [child.pid!, pids.fake, pids.grandchild]
  for (let i = 0; i < 50 && all.some(alive); i++) await sleep(100)
  const left = all.filter(alive)
  for (const pid of left) try { process.kill(pid, "SIGKILL") } catch {} // don't leave strays behind a failure
  assert(left.length === 0, `still running after tree kill: ${left.join(", ")} (launcher, claude, grandchild = ${all.join(", ")})`)
  assert(closedInTime, "'close' never fired after the tree died")
})

await check("promisified execFile returns stdout", async () => {
  const ok = await execFileAsync("node", ["-e", "process.stdout.write('hi é')"])
  assert(ok.stdout === "hi é", `stdout ${JSON.stringify(ok.stdout)}`)
})

await check("execFile non-zero exit rejects with code and stderr", async () => {
  const err = await execFileAsync("node", [FAKE, "fail"]).then(() => undefined, (e) => e)
  assert(err !== undefined, "did not reject")
  assert(err.code === 3, `code ${err.code}`)
  assert(String(err.stderr).includes("boom"), `stderr ${JSON.stringify(err.stderr)}`)
})

await check("execFile timeout kills and rejects with killed + SIGTERM", async () => {
  const t0 = Date.now()
  const err = await execFileAsync("node", [FAKE, "sleep"], { timeout: 500 }).then(() => undefined, (e) => e)
  assert(err !== undefined, "did not reject")
  assert(err.killed === true && err.signal === "SIGTERM", `killed ${err.killed} signal ${err.signal}`)
  assert(String(err.stdout).includes("started"), `stdout ${JSON.stringify(err.stdout)}`)
  assert(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
})

await check("execFile with an aborted AbortSignal rejects with AbortError", async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  const err = await execFileAsync("node", [FAKE, "sleep"], { signal: ac.signal }).then(() => undefined, (e) => e)
  assert(err !== undefined, "did not reject")
  assert(err.name === "AbortError", `name ${err.name}`)
})

console.log(failed ? `${failed} failed` : "all passed")
process.exit(failed ? 1 : 0)
