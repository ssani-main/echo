// Gap 50: a served Request has no `signal` (T0107), so a handler can't tell that its client went away. Bun
// prints aborted, client left, done. Echo needs it to stop a Whisper job (yt-dlp, ffmpeg, whisper-cli) when the
// page that asked for it is closed, as server.js does on res 'close'.
const server = Bun.serve({ port: 0, fetch: async (req: Request) => {
  req.signal.addEventListener('abort', () => console.log('client left'));
  await new Promise((r) => setTimeout(r, 500));
  return new Response('late');
} });
const ac = new AbortController();
const p = fetch(`http://127.0.0.1:${server.port}/`, { signal: ac.signal }).catch(() => 'aborted');
setTimeout(() => ac.abort(), 100);
console.log(await p);
await new Promise((r) => setTimeout(r, 800));
server.stop();
console.log('done');
