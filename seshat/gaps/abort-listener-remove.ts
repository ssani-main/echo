// Gap 54: AbortSignal.addEventListener takes no options ({ once: true }: T0201) and there is no
// removeEventListener, so a listener can't be taken back once its work is done. Node prints 0.
const ac = new AbortController();
let calls = 0;
const onAbort = (): void => { calls++; };
ac.signal.addEventListener('abort', onAbort, { once: true });
ac.signal.removeEventListener('abort', onAbort);
ac.abort();
console.log(calls);
