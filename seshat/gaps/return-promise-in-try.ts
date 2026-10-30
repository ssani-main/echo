// Gap 45: in an async function, `return p` (not awaited) inside a `try` hands back p's rejection unhandled
// by that try in JavaScript; Seshat's catch catches it. Node prints "rejected: boom".
async function fails(): Promise<string> { throw new Error('boom'); }
async function viaTry(): Promise<string> {
  try {
    return fails();
  } catch {
    return 'caught';
  }
}
try { console.log(await viaTry()); } catch (e) { console.log(`rejected: ${e instanceof Error ? e.message : '?'}`); }
