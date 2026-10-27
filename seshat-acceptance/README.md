# Seshat acceptance tests for Echo

What Echo's backend needs from Seshat before it can be ported off Node. Each file mirrors Echo's real code and must pass **unchanged** under both runtimes; Node is the reference.

```sh
cd seshat-acceptance
node zlib-acceptance.ts            # reference: all passed (Node 24, Windows, 2026-10-26)
node spawn-acceptance.ts
seshat run zlib-acceptance.ts      # the target
seshat run spawn-acceptance.ts
```

On POSIX, first `chmod +x bin/claude`. `node` must be on PATH: `fake-claude.mjs` is the program being spawned and always runs under Node.

| File | Mirrors in Echo |
|---|---|
| `spawn-acceptance.ts` | `digest.js` `spawnClaudeProcess` (cmd.exe /c claude, stdin prompt, streamed stream-json, taskkill /T or the process group), `whisper.js` (stderr flood, spawn + kill), `transcript.js` (`promisify(execFile)` with `timeout` / `signal`) |
| `zlib-acceptance.ts` | `server.js` `serveCached` (gzipSync -9, brotli q11 with SIZE_HINT) and the streamed library export (`createGzip`) |
| `real-paths.ts` | the same call sites against the REAL binaries (`claude -p` on haiku, yt-dlp `-J` on the test video, ffmpeg, ffprobe), written as Echo writes them: Buffer chunks, `import os from "node:os"`, `env: process.env`. Needs network and a logged-in `claude`; run it with `CLAUDECODE`/`CLAUDE_CODE_*` unset. |

The tree-kill test is mutation-checked: replacing `killTree(pid)` with `child.kill()` makes it fail and name the orphaned `claude` and grandchild (it also kills them).
