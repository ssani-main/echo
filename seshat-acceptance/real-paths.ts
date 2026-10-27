// Echo's real child_process call sites, copied from digest.js / transcript.js / whisper.js,
// run against the real binaries (claude, yt-dlp, ffmpeg, ffprobe). Node is the reference.
import { spawn, execFile } from "child_process"
import { promisify } from "util"
import os from "node:os"
import path from "node:path"

const execFileAsync = promisify(execFile)
const isWin = process.platform === "win32"
const tmp = os.tmpdir()

let failed = 0
async function check(name: string, body: () => Promise<string>) {
  const t0 = Date.now()
  try {
    const note = await body()
    console.log(`ok - ${name} (${Date.now() - t0} ms) ${note}`)
  } catch (e) {
    failed++
    console.log(`not ok - ${name}: ${(e as Error).message}`)
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// digest.js spawnClaudeProcess: cmd.exe /c claude, stdin prompt, Buffer chunks, Buffer.concat, toString('utf8').
function runClaude(args: string[], prompt: string): Promise<{ stdout: string, stderr: string, code: number | null }> {
  const exe = isWin ? (process.env.ComSpec || "cmd.exe") : "claude"
  const spawnArgs = isWin ? ["/c", "claude", ...args] : args
  return new Promise((resolve, reject) => {
    const child = spawn(exe, spawnArgs, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmp,
      ...(isWin ? {} : { detached: true }),
    })
    child.on("error", (err) => reject(err))
    const out: Buffer[] = []
    const errs: Buffer[] = []
    let firstChunk = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk)
      if (!firstChunk) firstChunk = chunk.toString("utf8").slice(0, 40)
    })
    child.stderr.on("data", (chunk: Buffer) => { errs.push(chunk) })
    child.stdin.on("error", () => {})
    child.stdin.write(prompt, "utf8")
    child.stdin.end()
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(errs).toString("utf8").trim(),
        code,
      })
    })
  })
}

// whisper.js runStreaming: no setEncoding, buf.toString(), os.setPriority, kill('SIGTERM') on timeout.
function runStreaming(cmd: string, args: string[], timeoutMs: number): Promise<{ tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: process.env, windowsHide: true })
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    }
    let tail = ""
    let timedOut = false
    const onData = (buf: Buffer) => { tail = (tail + buf.toString()).slice(-4000) }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const to = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, timeoutMs)
    child.on("error", (err) => { clearTimeout(to); reject(err) })
    child.on("close", (code, sig) => {
      clearTimeout(to)
      if (code === 0) { resolve({ tail }); return }
      reject(new Error(`${path.basename(cmd)} exited with code ${code}${sig ? ` (${sig})` : ""}${timedOut ? " timedOut" : ""}`))
    })
  })
}

const wav = path.join(tmp, "echo-seshat-probe.wav")

await check("claude -p via cmd.exe /c: real CLI answers on stdout", async () => {
  const r = await runClaude(["-p", "--model", "haiku", "--output-format", "json", "--system-prompt", "Reply with exactly the word: pong"], "ping é")
  assert(r.code === 0, `code ${r.code}, stderr ${r.stderr.slice(0, 200)}`)
  const parsed = JSON.parse(r.stdout)
  assert(String(parsed.result).toLowerCase().includes("pong"), `result ${parsed.result}`)
  return `result=${JSON.stringify(parsed.result)}`
})

await check("yt-dlp -J via promisified execFile (default maxBuffer) parses", async () => {
  const { stdout } = await execFileAsync("yt-dlp", ["--js-runtimes", "node", "-J", "--skip-download", "https://www.youtube.com/watch?v=GRzaq5AHiV8"], { timeout: 60000 })
  const info = JSON.parse(stdout)
  return `title=${JSON.stringify(info.title)} bytes=${stdout.length} autoCaptions=${Object.keys(info.automatic_captions || {}).length}`
})

await check("yt-dlp with a bad URL rejects with code + stderr", async () => {
  const e = await execFileAsync("yt-dlp", ["--js-runtimes", "node", "-J", "--skip-download", "https://www.youtube.com/watch?v=xxxxxxxxxxx"], { timeout: 60000 }).then(() => undefined, (e) => e)
  assert(e !== undefined, "did not reject")
  assert(e.code === 1, `code ${e.code}`)
  assert(String(e.stderr).includes("ERROR"), `stderr ${String(e.stderr).slice(0, 200)}`)
  return `code=${e.code}`
})

await check("ffmpeg via runStreaming writes a wav (stderr streamed, setPriority)", async () => {
  const r = await runStreaming("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 60000)
  assert(r.tail.includes("pcm_s16le"), `tail ${r.tail.slice(-200)}`)
  return `tail=${r.tail.length} chars`
})

await check("ffprobe duration via promisified execFile with timeout", async () => {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wav], { timeout: 30000 })
  const d = parseFloat(String(stdout).trim())
  assert(Math.abs(d - 3) < 0.05, `duration ${d}`)
  return `duration=${d}`
})

await check("runStreaming timeout kills with SIGTERM", async () => {
  const e = await runStreaming("ffmpeg", ["-y", "-re", "-f", "lavfi", "-i", "sine=duration=30", "-f", "null", "-"], 1500).then(() => undefined, (e) => e)
  assert(e !== undefined, "did not reject")
  return (e as Error).message
})

console.log(failed ? `${failed} failed` : "all passed")
process.exitCode = failed ? 1 : 0
