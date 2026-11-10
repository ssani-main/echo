// Gap 56: when a client leaves a streamed answer, the stream's cancel() runs only at the next write, not when
// the client goes. Bun prints "cancelled at once", done; Seshat "cancelled 1 s later", done. Echo's progress
// stream writes a ping every 10 s, so its open-stream count (capped at 32) stayed taken that long.
let cancelled = false;
const server = Bun.serve({ port: 0, fetch() {
  let stop = (): void => {};
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue('retry: 2000\n\n');
      const iv = setInterval(() => controller.enqueue(': ping\n\n'), 1000);
      stop = (): void => { clearInterval(iv); };
    },
    cancel() { cancelled = true; stop(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
} });
const ac = new AbortController();
const res = await fetch(`http://127.0.0.1:${server.port}/`, { signal: ac.signal });
await res.body!.getReader().read();
ac.abort();
await new Promise((r) => setTimeout(r, 500));
const atOnce = cancelled;
await new Promise((r) => setTimeout(r, 1500));
console.log(atOnce ? 'cancelled at once' : cancelled ? 'cancelled 1 s later' : 'never cancelled');
server.stop();
console.log('done');
process.exit(0);
