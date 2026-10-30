// Gap 49: a plain arrow that returns youtube.ts's fetchTranscript promise, used as a TranscriptFetcher, builds and
// crashes when called (exception 0xC0000005, access violation) on Seshat main 2a6404e. Node prints true. Needs
// the network. In transcript.ts's fetchViaPackage, `(id, ytOpts) => (ytOpts ? fetchPackageTranscript(id, ytOpts)
// : fetchPackageTranscript(id))` crashes with or without the `opts.transcriptFetcher ||` in front; the same arrow
// written `async` with `await` on both branches works (that is the workaround there, `shortcut:`). Not reduced:
// the same shapes cut out (an arrow over an async function with an optional config, called inside try/catch)
// run as Node does. To see it, take the `async` and both `await`s off that arrow and run this file.
import { fetchViaPackage } from '../transcript.ts';
console.log((await fetchViaPackage('GRzaq5AHiV8', undefined)).length > 0);
