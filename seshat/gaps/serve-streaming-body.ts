// Server-sent events, as Echo's /api/digest?stream=1 sends them. Bun's API, so the reference is `bun run`
// (Node has no Bun.serve); the expected output is the three events, then "done".
const server = Bun.serve({
  port: 0,
  fetch() {
    const body = new ReadableStream({
      start(controller) {
        for (const word of ["one", "two", "three"]) controller.enqueue(new TextEncoder().encode(`event: token\ndata: ${word}\n\n`))
        controller.close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  },
})
const res = await fetch(`http://127.0.0.1:${server.port}/`)
console.log(await res.text())
console.log("done")
server.stop()
