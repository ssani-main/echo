# Echo on Seshat: port tracker

Echo's backend moves from Node.js to [Seshat](../../Seshat) (TypeScript compiled to a native binary) one
piece at a time, next to the Node server, which keeps working unchanged throughout. Approach as in
Dossier's `seshat/PORT.md`: a port folder next to the original, this tracker, every piece checked against
the original, and every Seshat gap written down with a minimal repro.

Branch: `seshat-port` (local only, never pushed). Compiler: Seshat `main` bb9c898
(`../Seshat/target/release/seshat.exe`).

## Layout

| Path | What |
|---|---|
| `seshat/<module>.ts` | a port, plain TypeScript (`.ts`, so `node` and `tsc` read it too) |
| `seshat/errors.ts` | `EchoError`, the one error class every port throws (see "Differences on purpose") |
| `seshat/check/<module>.cases.ts` | the inputs for one port, printed one JSON line per case |
| `seshat/check/run.mjs` | runs each case file three ways and compares the output byte for byte |
| `seshat/check/original.mjs` | Node import hook: points `seshat/<module>.ts` at the original module |
| `seshat/gaps/*.ts` | one minimal repro per Seshat gap (runs under `node`, `tsc --strict` accepts it) |

## Running the checks

```sh
node seshat/check/run.mjs            # every *.cases.ts; or name some: node seshat/check/run.mjs markdown digest
SESHAT=/path/to/seshat.exe node seshat/check/run.mjs
```

Each case file runs as:

- **original**: `node --import ./original.mjs x.cases.ts`, so the imports resolve to the ORIGINAL Node module (`markdown.js`, `common/text.js`, ...);
- **port@node**: `node x.cases.ts`, the port under Node. If this one differs, the port is wrong;
- **port@seshat**: `seshat run x.cases.ts`, the target. If only this one differs, it's a Seshat gap.

The output must be identical bytes. The case files print results as JSON, so whitespace, `undefined`
against `null` and lone surrogates all show up. Planting a bug in a port makes both port rows fail (tried
on `sanitize.ts` and on `markdown.ts`'s collation). Node is 24.11 here; the first `seshat run` of a file
compiles it (seconds), later runs are cached.

The ports and case files also pass `tsc --strict` (TypeScript 5 and `@types/node` 22 installed in a
scratch folder, not in this repo):
`tsc --noEmit --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --types node seshat/*.ts seshat/check/*.ts`.

## Ported and checked

| Port | From | Cases | Status |
|---|---|---|---|
| `sanitize.ts` | `sanitize.js` (`safeHttpUrl`) | 32 | identical |
| `text.ts` | `common/text.js` (`extractVideoId`, `extractSummary`) | 64 | identical. tests/shared-parity.test.js's corpus plus Unicode, CRLF, emoji at the cut, junk |
| `markdown.ts` | `markdown.js` (`entryToMarkdown`, `buildVaultIndex`) | 42 | identical. Dates as V8 reads them (date-only, local time, `October 28, 2026`, `2026-02-30`) bucket the same in Seshat. Shortcut: collation (below) |
| `transcript.ts` | `transcript.js`: `classifyTranscriptFailure`, `isMillisecondOffsets`, `isPermanentFetchError`, `fetchWithRetry`, `MEMBERS_ONLY_PATTERNS` | 80 | identical. Shortcuts: `Error` parameters, `fetchWithRetry` not generic |
| `digest.ts` | `digest.js`: `buildClaudeArgs`, `buildClaudeStreamArgs`, `buildSpawnTarget`, `scaledTimeoutMs`, `thresholdCharsFor`, `chunkBudgetCharsFor`, `mergeUsage`, `parseJsonLoose`, `chunkText` | 231 | identical. Includes lone surrogates, `1e400`, `__proto__` keys, integer-key order, chunk cuts through emoji. Shortcuts: `Number()`, `Math.ceil` |
| `providers.ts` | `providers.js`'s registry: `PROVIDERS`, `REASONING_LEVELS`, `normalizeProviderId`, `normalizeReasoningLevel`, `getProviderId`, `getProviderLimits`, `getReasoningLevel`, `reasoningFields`, `publicProviderList`, `truncationFields`, `isTruncationReason`, `deepseekModelFor`, `parseSseLine` | 286 | identical. `parseSseLine` walks junk frames as the original does (`"choices":"abc"`, `{"0":…}`, `data: null` throwing its TypeError). Shortcuts: the `&&`/`||` lookup, `first()`, `parseSseLine`'s fallbacks |
| `whisper.ts` | `whisper.js`: `buildWhisperArgs`, `chooseModelForLanguage`, `isTransientDownloadFailure`, `withDownloadRetry`, `mapWhisperError`, `LOCAL_MEDIA_EXTENSIONS` | 117 | identical. Shortcuts: `opts?.`, typed `lastErr` |
| `vault.ts` | `vault.js` (`slugify`, `monthFolder`) | 31 | identical |

Differences on purpose:

- **Types instead of runtime junk handling.** The originals accept anything (`tags: 'ai'`, `segments: 42`)
  and ignore it. The ports take the types the callers really pass (store.js rows), so a wrong type is
  refused where the JSON is parsed, at the route (the trust boundary). Missing and `null` fields are still
  handled as before. Where an original really reads fields off arbitrary values (`parseSseLine`, the
  Whisper error mappers), the port does too.
- **`EchoError`** (`errors.ts`): the originals set `echoCode`, `hint` and `detail` on a plain `Error` (87
  places), which TypeScript does not allow and Seshat traps on (gap: error-add-property). One subclass
  carries the three fields; its `name` is still `"Error"`.
- **`WhisperErrorInfo.message` is `string | undefined`**: the original returns `undefined` there for an
  `echoCode` error with no message.
- **Collation shortcut** (`markdown.ts`): `localeCompare(b, undefined, { sensitivity: 'base' })` is
  approximated by comparing case- and accent-folded text. It differs from ICU only for titles ICU calls
  equal at base strength and folding doesn't: `Straße`/`strasse`, `Æther`/`aether`, `Øl`/`ol`, `Ⅻ`/`xii`,
  `ﬁle`/`file` (measured in Node). Then the two titles can swap places in the index.

Found in Echo itself (the original is left as it is):

- **`X-Echo-Provider: constructor` or `__proto__` is not refused.** `providers.js` looks provider names up
  in a plain object, so `normalizeProviderId('constructor')` returns `Object`'s constructor function and
  `'__proto__'` returns `Object.prototype` (any case, any padding: the name is trimmed and lowercased
  first). server.js's `requestedProvider()` takes that as a valid id, so instead of `400 PROVIDER_UNKNOWN`
  the request runs on the CLI provider (`getProvider()` falls through to it; measured in Node). The port
  returns `null`, so those two names are not in the byte corpus. Harmless today (the CLI is the default),
  but it is a request header choosing an unlisted code path.

Not ported yet from these modules, on purpose: `transcript.js`'s fetching (`fetchViaPackage`,
`fetchViaYtDlp`, `getVideoMeta`, `listCaptionTracks`, `fetchTranscript`), `digest.js`'s CLI and provider
calls, prompts and map-reduce, `providers.js`'s three providers, `whisper.js`'s spawns and
`mapWhisperJson`, `vault.js`'s `syncVault`, and usagelog's one-line `errLabel`. They come with their routes,
below.

## The plan

### How the two services run side by side

Node stays the front door, as Next.js is in Dossier. With `ECHO_SESHAT_URL` set, server.js forwards the
routes listed as ported to the Seshat service (127.0.0.1:8001) **after** its own middleware has run: the
security headers, the `requireApproved` gate, `blockInWeb` and the rate limiters. Unset, nothing changes,
so the tests, Docker, the Tauri sidecar and `npm start` keep working as they are. Answers from Seshat carry
`x-served-by: seshat`.

Why this way round for Echo: Express already owns everything that is not a route (static files with
pre-compressed brotli/gzip, the CSP, response compression, the gate screens), and three of the routes
Echo depends on stream (gap: serve-streaming-body), which Seshat can't serve yet. Seshat as the front door
would have to proxy those streams back to Node, which needs the very feature it lacks.

The forwarding is the first change to server.js and the only one until the end: about 30 lines, a `fetch`
to the service with the method, path, query, headers and body passed through, and the answer copied back.
The Seshat service listens on 127.0.0.1 only, but anything on the machine can reach it, so until
`auth.js` is ported Node adds a random per-boot secret header (`x-echo-forward`) that the service
requires; in local mode (no accounts) that matches today, where the Node server itself has no sign-in.

### Order

Each step: port the module(s), check them against the original (case files as above, or for a route: the
same request to both services, same status, headers and body, and the same database rows afterwards on
twin copies), add the route to the forwarded list, run the Node test suite with the service up.

| # | Step | Modules | Routes | npm dependency replaced | Seshat needs |
|---|---|---|---|---|---|
| 0 | **Pure logic** (done, above) | sanitize, common/text, markdown, the pure parts of transcript, digest, vault | | | |
| 1 | **Pure logic, rest** (done, above, but `errLabel`) | providers.js registry, whisper.js's pure parts | | | |
| 2 | Service skeleton + forwarding | a small router over `Bun.serve` (method + `:param` paths), `sendError` envelope, 5 MB JSON body cap | `GET /api/health`, `GET /api/providers` | express (for these) | json-undefined-unknown-field matters from here on: every response envelope with an optional field |
| 3 | Usage meter | usagelog.js (`appendFile`, `stat`, `rename`, `errLabel`) | `POST /api/event` | | done |
| 4 | Library (local/desktop) | store.js on `bun:sqlite` (FTS5 is compiled in; `PRAGMA user_version` migrations, rowid-keyed FTS), vault.js `syncVault` | `GET/POST/DELETE /api/saved*`, `PATCH .../tags`, `GET /api/search`, `GET /api/saved/:id/export.md`, `POST /api/vault/sync` | (node:sqlite → bun:sqlite) | `db.transaction()` and named parameters are "not yet" in Seshat; store.js uses positional ones. **`GET /api/saved/export` streams** gzip: stays on Node until serve-streaming-body |
| 5 | Transcripts | transcript.js; **youtube-transcript replaced by Echo's own code**: InnerTube `youtubei/v1/player` for the caption tracks, then the track's XML, ~150 lines (the package is 257). Keep its error messages word for word: `isPermanentFetchError` and `classifyTranscriptFailure` match on them. yt-dlp through `promisify(execFile)` (proven by seshat-acceptance) | `POST /api/transcript`, `GET /api/languages`, `GET /api/video-meta` (oEmbed via `fetch`) | youtube-transcript | throwing-callback-result-json (the segments come back through `fetchWithRetry`), define-property-on-array (fetchers return `{ segments, langUsed, source }` instead of tagging the array) |
| 6 | Whisper (local/desktop) | whisper.js (spawn, kill, stderr progress: proven), whisperModel.js (download: `fetch` body reader + `std/crypto` sha256 instead of `stream.pipeline`/`Transform`) | `GET /api/whisper/status`, `POST /api/whisper/model`, `POST /api/transcript/file` (raw body) | | **`GET /api/transcript/progress` is SSE**: stays on Node until serve-streaming-body |
| 7 | Digest | providers.js: **@anthropic-ai/sdk replaced by `fetch`** to `POST https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`; `stream: true` parsed like DeepSeek's frames; SDK error classes mapped from HTTP status in `mapAnthropicError`; `validateApiKey` via `GET /v1/models?limit=1`). DeepSeek already uses `fetch`. digest.js: the CLI spawn (proven), map-reduce, prompts | `POST /api/digest` (JSON), `POST /api/validate-key` | @anthropic-ai/sdk | **`POST /api/digest?stream=1` (the default in the UI) is SSE**: serve-streaming-body. Until then Node keeps the streamed variant, or the client's existing buffered fallback is used |
| 8 | Accounts (config-gated) | auth.js (HMAC cookies, Google OAuth + PKCE: `std/crypto` createHmac, createHash, randomBytes, timingSafeEqual), atproto.js (AES-GCM), syncStore.js (sqlite), pds.js, pdsSync.js | `/api/auth/*`, `/api/admin/*`, `/api/sync/*`, `/api/pds/*` | | then the service checks the session itself and `x-echo-forward` goes |
| 9 | Front door swap | static `dist/` with the boot-time gzip/brotli cache (zlib proven), CSP and security headers, rate limiters, `requireApproved`, `blockInWeb`, SIGTERM closing the databases | everything | express (gone) | serve-streaming-body must be fixed by here |
| 10 | Desktop | Tauri sidecar runs the Seshat binary instead of Node + `node_modules`; `tauri.conf.json` `bundle.resources` and `tests/tauri-bundle.test.js` change | | | Seshat builds for linux-x64 and win32-x64 |

After step 9 Node only builds the frontend (Astro), as in Dossier's end state; the Chrome extension and
the Obsidian plugin are untouched (they talk HTTP). The npm runtime dependencies are exactly the three
above (`express`, `@anthropic-ai/sdk`, `youtube-transcript`); the dev ones (astro, tauri cli,
holesail-server) are build and tunnel tooling and stay on Node.

## Seshat gaps found while porting

23 gaps. Each has a repro in `seshat/gaps/<name>.ts` that runs under `node` and that `tsc --strict`
accepts; `seshat run seshat/gaps/<name>.ts` shows the gap. Grouped, most blocking first: what blocks a
route or silently gives a wrong answer, then what compiles and then stops the program, then what refuses
valid TypeScript.

### Blocks a route, or gives a wrong answer silently

1. **serve-streaming-body: no streaming response bodies.** Missing API: `new ReadableStream({ start })` and
   `new Response(stream)`. Blocks `POST /api/digest?stream=1` (SSE, the UI default),
   `GET /api/transcript/progress` (SSE) and `GET /api/saved/export` (streamed gzip). Seshat's docs list it
   ("Not yet: ... streaming bodies"). Bun's API, so the reference is `bun run` (Node has no `Bun.serve`),
   which prints the three events. No workaround: those routes stay on Node.
   ```
   error[T0201] serve-streaming-body.ts:6:18: `new ReadableStream` takes 0 arguments, found 1
   error[T0301] serve-streaming-body.ts:7:13: can't infer the type of parameter `controller`
   error[T0001] serve-streaming-body.ts:12:25: expected `BodyInit | undefined`, found `ReadableStream`
   ```
2. **json-undefined-unknown-field: an `unknown` or `any` field holding undefined serialises as `null`.**
   `interface Frame { usage?: unknown }; JSON.stringify({} as Frame)` prints `{"usage":null}`; Node
   prints `{}`. A `string` field holding undefined is dropped correctly. Every response envelope with an
   optional field built from error or JSON values (`hint: err.hint`, `usage: json.usage || undefined`)
   would differ from Node's. Workarounds in `check/providers.cases.ts` and `check/whisper.cases.ts`
   (`shortcut:`): print only the defined fields.
3. **throwing-callback-result-json: a value that came back through a throwing callback serialises as
   `null`.** Once a function that can throw is passed as a plain function type, `JSON.stringify` of what it
   returned prints `{"segs":[null]}` where Node prints `{"segs":[{"text":"a"}]}`. Field reads are right.
   Stringified directly instead of through `unknown` it's a compile error that names the right type
   (`throwing-callback-result-json-compile.ts`):
   ```
   error[T0840] throwing-callback-result-json-compile.ts:7:28: `Seg[]` can't be converted to JSON
   ```
   This is exactly the transcript route: `fetchWithRetry(fetcher)` then a JSON response. Workaround in
   `check/transcript.cases.ts` (`shortcut:`): serialise a field-by-field copy.
4. **rethrow-any-c-error: the generated C doesn't compile.** An `any` variable that receives a caught error
   inside a function and is then thrown:
   ```
   error: internal error: the generated C failed to compile (this is a bug in seshat)
   ...: error: conversion to non-scalar type requested
   ...: error: cannot convert to a pointer type
   ```
   This is `withDownloadRetry`'s shape (and `fetchWithRetry`'s in the original). Workaround in `whisper.ts`
   (`shortcut:`): `lastErr` typed `Error`, its extra fields read through an `any` parameter.
5. **define-property-on-array: no `Object.defineProperty`.** Echo tags segment arrays with non-enumerable
   `langUsed`/`source` (transcript.js, whisper.js; read in server.js). Plan: fetchers return
   `{ segments, langUsed, source }` in the port; the route's JSON is unchanged.
   ```
   error[T0107] define-property-on-array.ts:2:8: `Object` has no member `defineProperty`
   ```

### Compiles, then stops the program (TypeScript would run on)

6. **guard-on-object-literal-crashes: crash.** A user type guard over an object literal held in `unknown`:
   `const s: unknown = { text: "a" }; if (isRecord(s)) console.log(s.text)` with
   `isRecord(v): v is Record<string, unknown>`. The same value from `JSON.parse` works.
   ```
   error: the program crashed: exception 0xC0000005 (access violation)
   ```
   Also hit by `parseSseLine`'s `|| {}` fallback. Workaround in `providers.ts` (`shortcut:`): `|| undefined`,
   which has the same (no) fields.
7. **error-add-property: an `Error` can't take extra fields.** `const e: any = new Error("boom"); e.echoCode = "CLAUDE_FAILED"`:
   ```
   trap: TypeError: can't add a property to an object of a fixed type
   ```
   Echo does this in 87 places (`echoCode`, `hint`, `detail`). Answered by `EchoError` (`errors.ts`).
8. **any-undefined-as-string: an `any` holding undefined, used where a `string` is declared, traps.**
   `function messageOf(err: any): { message: string } { return { message: err.message } }` on `{}`:
   ```
   trap: TypeError: an `any` holding undefined was used as a string
   ```
   Node prints `{}`. Answered in `whisper.ts` by typing the field `string | undefined`, which is the truth.
9. **index-out-of-range-traps: `xs[0]` of an empty array traps** where it isn't an "absent value expected"
   form (`?? d`, `?.`, `=== undefined`), e.g. as a return value:
   ```
   trap: index 0 out of bounds for length 0
   ```
   Seshat's documented rule, but it compiles and then behaves differently. Workaround in `providers.ts`
   (`shortcut:`): length checks in `first()`.
10. **record-lookup-in-conditional: a missing `Record` key as a conditional's branch traps.**
    `(key ? table[key] : undefined) || 0` with a missing key:
    ```
    trap: value is undefined (`!` assertion failed)
    ```
    The same lookup bound to a variable, or with `?? null`, works. Workaround in `providers.ts`.
11. **math-ceil-infinity: `Math.ceil`/`floor`/`round` trap on Infinity and NaN.**
    ```
    trap: Math.ceil(Infinity) is out of the int range
    ```
    Node prints `Infinity -Infinity NaN`. Seshat's documented `int` design; 17 call sites in Echo each need
    a look. Workaround in `digest.ts` `scaledTimeoutMs` (`shortcut:`).
12. **as-record-traps, as-cast-traps: `as` is checked at runtime and traps** where TypeScript's never fails.
    Even an honest cast traps: `const s: unknown = { text: "a" }; (s as Record<string, unknown>).text`:
    ```
    trap: `as` cast failed: the value is of a different type
    ```

### Refuses valid TypeScript

13. **number-of-non-string: `Number(x)` takes only a string.** TypeScript's `Number` takes anything. Echo has
    28 `Number()` calls, many of them `Number(process.env.X) || default` or on unknown input.
    ```
    error[T0001] number-of-non-string.ts:1:24: `Number` parses a `string`, found `string | undefined`
    error[T0001] number-of-non-string.ts:3:29: `Number` parses a `string`, found `unknown`
    ```
    Workaround in `digest.ts` (`shortcut:`): `?? ''` on env values, and number parameters.
14. **throw-any: only `Error` objects can be thrown**, so rethrowing an `any` parameter is refused:
    ```
    error[T0834] throw-any.ts:2:9: can only throw `Error` objects, found `any`
    ```
    Workaround in `check/whisper.cases.ts` (`shortcut:`): the scripted failures are Errors.
15. **generic-throwing-callback: a generic `() => Promise<T>` parameter refuses a callback that throws.**
    Non-generic function types accept it, as the docs say they should; an explicit type argument doesn't help.
    ```
    error[T0001] generic-throwing-callback.ts:5:27: expected `() => Promise<string>`, found `() => Promise<string, Error>`
    ```
    Workaround in `transcript.ts` (`shortcut:`): `fetchWithRetry` fixed to `CaptionSegment[]`.
16. **default-param-then-null-default: a defaulted parameter reads as possibly undefined** when the next
    parameter defaults to `null` (`function pick(opts: {...} = {}, onDone: (() => void) | null = null)`):
    ```
    error[T0120] default-param-then-null-default.ts:3:10: `opts` may be `undefined`
    ```
    With a number default after it, it compiles. Workaround in `whisper.ts` (`shortcut:`): `opts?.`.
17. **and-or-narrowing: `(key && table[key]) || fallback` keeps `string` in its type**; TypeScript narrows
    the falsy string out:
    ```
    error[T0108] and-or-narrowing.ts:4:16: not every variant of `string | { n: f64 }` has field `n`
    ```
    Workaround in `providers.ts` `reasoningFields` (`shortcut:`).
18. **in-operator-narrowing: `"key" in v` doesn't narrow** (TypeScript 4.9's narrowing of `unknown`):
    ```
    error[T0107] in-operator-narrowing.ts:2:71: `unknown` has no member `text`
    ```
19. **error-to-structural-type: an `Error` isn't accepted for a structural type** such as `{ message?: string }`:
    ```
    error[T0001] error-to-structural-type.ts:4:23: expected `{ message?: string | undefined }`, found `Error`
    ```
    Workaround in `transcript.ts` (`shortcut:`): the parameters take `Error`.
20. **error-intersection: no intersection with a class** (`type Tagged = Error & { echoCode?: string }`):
    ```
    error[X0014] error-intersection.ts:1:15: an intersection (`&`) combines record types, and `Error` isn't one
    ```
    Workaround in `check/digest.cases.ts` (`shortcut:`): cast to `EchoError`.
21. **isarray-unknown-is-any-array: `Array.isArray` of an `unknown` gives `unknown[]`, not `any[]`**, so
    `const xs: string[] = Array.isArray(input) ? input : []` is refused:
    ```
    error[T0001] isarray-unknown-is-any-array.ts:2:22: expected `string[]`, found `string[] | unknown[]`
    ```
    The ports avoid it by typing their inputs.
22. **empty-array-as-unknown: `[]` where an `unknown` is expected** (`const x: unknown = []`, `x || []`):
    ```
    error[T0301] empty-array-as-unknown.ts:1:20: can't infer the element type of an empty array
    ```
    Workarounds in `check/text.cases.ts` and `providers.ts` (`shortcut:`): a typed binding.
23. **localecompare-options: `localeCompare` takes no locales or options**:
    ```
    error[T0201] localecompare-options.ts:2:34: `string.localeCompare` takes 1 argument, found 3
    signature: string.localeCompare(that: string): int
    ```
    The one-argument form orders as Node's ICU does (checked). Workaround in `markdown.ts` (`shortcut:`),
    with its known differences above.

Things that worked the first time and were worth checking: V8's lenient `new Date(string)` parsing
(including local time and rollover), JSON with lone surrogates and integer keys, UTF-16 `slice` through
emoji, `\p{M}` with `normalize('NFD')`, regex flags, `toLocaleString('en-US')`, `Object.values` over a
`Record`, `process.env[name]`, `setTimeout`-based retry delays, top-level `await`, FTS5 compiled into the
vendored SQLite.

## Picking this up

Next is step 2: the service skeleton (`Bun.serve`, a router, the error envelope) with `GET /api/health`
and `GET /api/providers`, and the forwarding in server.js, the first edit to Node code. Check those two
routes against the Node server (same status, headers and body). Report the gaps to the Seshat session
(find it with ListAgents) rather than editing ../Seshat from here; gaps 1 to 4 matter most. When a gap is
fixed: delete its `shortcut:` workaround (grep for the gap's name), rerun `node seshat/check/run.mjs`, and
move the gap to a "fixed" line here.

Never push this branch.
