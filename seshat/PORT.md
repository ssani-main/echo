# Echo on Seshat: port tracker

Echo's backend moves from Node.js to [Seshat](../../Seshat) (TypeScript compiled to a native binary) one
piece at a time, next to the Node server, which keeps working unchanged throughout. Approach as in
Dossier's `seshat/PORT.md`: a port folder next to the original, this tracker, every piece checked against
the original, and every Seshat gap written down with a minimal repro.

Branch: `seshat-port`, pushed to `origin`. Compiler: Seshat `main` ee849ba
(`../Seshat/target/release/seshat.exe`, what `check/run.mjs` uses unless `SESHAT=` names another), which
has the `echo-gaps` work: 20 of the first 23 gaps fixed, and the workarounds for them removed (2026-10-29).

## Layout

| Path | What |
|---|---|
| `seshat/<module>.ts` | a port, plain TypeScript (`.ts`, so `node` and `tsc` read it too) |
| `seshat/errors.ts` | `EchoError`, the one error class every port throws (see "Differences on purpose") |
| `seshat/check/<module>.cases.ts` | the inputs for one port, printed one JSON line per case |
| `seshat/check/run.mjs` | runs each case file three ways and compares the output byte for byte |
| `seshat/server.ts` | the Seshat service: `Bun.serve` on 127.0.0.1:8001 with the ported routes |
| `seshat/check/routes.sh` | the same requests to server.js alone and to server.js forwarding to the service, compared byte for byte; then their databases, usage logs and vault folders |
| `seshat/check/library.sh` | step 4's requests, through routes.sh |
| `seshat/check/suite.sh` | the Node suite with forwarding on |
| `seshat/check/node-bun.mjs` | under node, `bun:sqlite` as a stand-in over node:sqlite (the port@node row) |
| `seshat/check/dbdump.mjs` | a library database's rows, timestamps masked |
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
| `markdown.ts` | `markdown.js` (`entryToMarkdown`, `buildVaultIndex`) | 44 | identical. Dates as V8 reads them (date-only, local time, `October 28, 2026`, `2026-02-30`) bucket the same in Seshat. Collation as ICU's at base strength (`Straße`/`strasse`, `Æther`, `Ⅻ`, `ﬁle`, `Ａpple`, `㎏`). Shortcut: NFKC before `localeCompare` (gap 26) |
| `transcript.ts` | `transcript.js`: `classifyTranscriptFailure`, `isMillisecondOffsets`, `isPermanentFetchError`, `fetchWithRetry`, `MEMBERS_ONLY_PATTERNS` | 80 | identical |
| `digest.ts` | `digest.js`: `buildClaudeArgs`, `buildClaudeStreamArgs`, `buildSpawnTarget`, `scaledTimeoutMs`, `thresholdCharsFor`, `chunkBudgetCharsFor`, `mergeUsage`, `parseJsonLoose`, `chunkText` | 251 | identical. Includes lone surrogates, `1e400`, `__proto__` keys, integer-key order, chunk cuts through emoji, `scaledTimeoutMs` of strings, arrays, `null` and `Infinity` |
| `providers.ts` | `providers.js`'s registry: `PROVIDERS`, `REASONING_LEVELS`, `normalizeProviderId`, `normalizeReasoningLevel`, `getProviderId`, `getProviderLimits`, `getReasoningLevel`, `reasoningFields`, `publicProviderList`, `truncationFields`, `isTruncationReason`, `deepseekModelFor`, `parseSseLine` | 286 | identical. `parseSseLine` walks junk frames as the original does (`"choices":"abc"`, `{"0":…}`, `data: null` throwing its TypeError) |
| `whisper.ts` | `whisper.js`: `buildWhisperArgs`, `chooseModelForLanguage`, `isTransientDownloadFailure`, `withDownloadRetry`, `mapWhisperError`, `LOCAL_MEDIA_EXTENSIONS` | 117 | identical |
| `vault.ts` | `vault.js` (`slugify`, `monthFolder`; `syncVault` is checked through its route, step 4) | 31 | identical |
| `store.ts` | `store.js` on `bun:sqlite` (all but `adoptDefaultLibrary`, which only accounts call: step 8) | 72 | port@node identical; port@seshat the same values, **keys in another order** (gap 37, open). One scripted session: saves, updates keeping omitted fields, junk segments and tags as JSON brings them, a null segment failing after the insert as store.js does, paging edge cases, FTS search and its malformed queries, a second owner's file, and a pre-migration database (columns added, FTS re-keyed). Shortcuts: one-level mkdir (gap 34), locals for gaps 40 and 41. Under node, `bun:sqlite` is `check/node-bun.mjs`, a stand-in over node:sqlite |
| `usagelog.ts` | `usagelog.js` (`logEvent`, `errLabel`) | 17 | identical: the JSONL lines written (ts masked), rotation at 400 bytes, lone surrogates, fields overriding `event`/`ts`. Shortcuts: the default path from the working directory (gap 28), rotation by copy + unlink (gap 29), the case file's environment set by `run.mjs` (gap 27) |

Differences on purpose:

- **Types instead of runtime junk handling.** The originals accept anything (`tags: 'ai'`, `segments: 42`)
  and ignore it. The ports take the types the callers really pass (store.js rows), so a wrong type is
  refused where the JSON is parsed, at the route (the trust boundary). Missing and `null` fields are still
  handled as before. Where an original really reads fields off arbitrary values (`parseSseLine`, the
  Whisper error mappers), the port does too.
- **`EchoError`** (`errors.ts`): the originals set `echoCode`, `hint` and `detail` on a plain `Error` (87
  places), which TypeScript does not allow (Seshat did trap on it, gap 7, fixed now). One subclass
  carries the three fields; its `name` is still `"Error"`.
- **`WhisperErrorInfo.message` is `string | undefined`**: the original returns `undefined` there for an
  `echoCode` error with no message.

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
`mapWhisperJson`. They come with their routes, below (`vault.js`'s `syncVault` came with the library, step 4).

## The plan

### How the two services run side by side

Node stays the front door, as Next.js is in Dossier. With `ECHO_SESHAT_URL` set, server.js forwards the
routes listed as ported to the Seshat service (127.0.0.1:8001) **after** its own middleware has run: the
security headers, the `requireApproved` gate, `blockInWeb` and the rate limiters. Unset, nothing changes,
so the tests, Docker, the Tauri sidecar and `npm start` keep working as they are. Answers from Seshat carry
`x-served-by: seshat`.

Why this way round for Echo: Express already owns everything that is not a route (static files with
pre-compressed brotli/gzip, the CSP, response compression, the gate screens), and three of the routes
Echo depends on stream, which Seshat couldn't serve when this was decided (gap 1, fixed since). Seshat as the
front door would have had to proxy those streams back to Node.

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
| 1 | **Pure logic, rest** (done, above) | providers.js registry, whisper.js's pure parts | | | |
| 2 | **Service skeleton + forwarding** (done, below) | `seshat/server.ts`: `Bun.serve`'s own `routes` (method + `:param` paths, so no router of ours), `sendError` envelope; server.js's `seshat` middleware | `GET /api/health`, `GET /api/providers` | express (for these) | done (gap 24 worked around) |
| 3 | **Usage meter** (done, below) | usagelog.js (`appendFile`, `stat`, `rename`, `errLabel`); the 5 MB JSON body cap comes with this first POST route | `POST /api/event` | | done |
| 4 | **Library** (built, below; the byte check waits for gap 37) | store.js on `bun:sqlite` (FTS5 is compiled in; `PRAGMA user_version` migrations, rowid-keyed FTS), vault.js `syncVault` | `GET/POST/DELETE /api/saved*`, `PATCH .../tags`, `GET /api/search`, `GET /api/saved/:id/export.md`, `POST /api/vault/sync` | (node:sqlite → bun:sqlite) | `db.transaction()` and named parameters are "not yet" in Seshat; store.js uses positional ones. **`GET /api/saved/export` streams** gzip: Seshat can now (gap 1 fixed), the forwarding has to stream too |
| 5 | Transcripts | transcript.js; **youtube-transcript replaced by Echo's own code**: InnerTube `youtubei/v1/player` for the caption tracks, then the track's XML, ~150 lines (the package is 257). Keep its error messages word for word: `isPermanentFetchError` and `classifyTranscriptFailure` match on them. yt-dlp through `promisify(execFile)` (proven by seshat-acceptance) | `POST /api/transcript`, `GET /api/languages`, `GET /api/video-meta` (oEmbed via `fetch`) | youtube-transcript | nothing left: gaps 3 (throwing-callback-result-json) and 5 (define-property-on-array) are fixed, so the fetchers can tag the array as the original does |
| 6 | Whisper (local/desktop) | whisper.js (spawn, kill, stderr progress: proven), whisperModel.js (download: `fetch` body reader + `std/crypto` sha256 instead of `stream.pipeline`/`Transform`) | `GET /api/whisper/status`, `POST /api/whisper/model`, `POST /api/transcript/file` (raw body) | | **`GET /api/transcript/progress` is SSE**: Seshat can now (gap 1 fixed), the forwarding has to stream too |
| 7 | Digest | providers.js: **@anthropic-ai/sdk replaced by `fetch`** to `POST https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`; `stream: true` parsed like DeepSeek's frames; SDK error classes mapped from HTTP status in `mapAnthropicError`; `validateApiKey` via `GET /v1/models?limit=1`). DeepSeek already uses `fetch`. digest.js: the CLI spawn (proven), map-reduce, prompts | `POST /api/digest` (JSON), `POST /api/validate-key` | @anthropic-ai/sdk | **`POST /api/digest?stream=1` (the default in the UI) is SSE**: Seshat can now (gap 1 fixed), the forwarding has to stream too |
| 8 | Accounts (config-gated) | auth.js (HMAC cookies, Google OAuth + PKCE: `std/crypto` createHmac, createHash, randomBytes, timingSafeEqual), atproto.js (AES-GCM), syncStore.js (sqlite), pds.js, pdsSync.js | `/api/auth/*`, `/api/admin/*`, `/api/sync/*`, `/api/pds/*` | | then the service checks the session itself and `x-echo-forward` goes |
| 9 | Front door swap | static `dist/` with the boot-time gzip/brotli cache (zlib proven), CSP and security headers, rate limiters, `requireApproved`, `blockInWeb`, SIGTERM closing the databases | everything | express (gone) | (gap 1, streaming bodies, is fixed) |
| 10 | Desktop | Tauri sidecar runs the Seshat binary instead of Node + `node_modules`; `tauri.conf.json` `bundle.resources` and `tests/tauri-bundle.test.js` change | | | Seshat builds for linux-x64 and win32-x64 |

After step 9 Node only builds the frontend (Astro), as in Dossier's end state; the Chrome extension and
the Obsidian plugin are untouched (they talk HTTP). The npm runtime dependencies are exactly the three
above (`express`, `@anthropic-ai/sdk`, `youtube-transcript`); the dev ones (astro, tauri cli,
holesail-server) are build and tunnel tooling and stay on Node.

### Step 2: the service and the forwarding (done)

Run it:

```sh
ECHO_SESHAT_SECRET=<32+ characters> seshat run seshat/server.ts             # the service, 127.0.0.1:8001
ECHO_SESHAT_URL=http://127.0.0.1:8001 ECHO_SESHAT_SECRET=<same> npm start  # Echo, forwarding the ported routes
```

- **Forwarding** is server.js's `seshat` middleware, put LAST in a ported route's chain
  (`app.get('/api/health', seshat, handler)`), so every gate before it has run. Without
  `ECHO_SESHAT_URL` it calls `next()`; with it but no 32-character secret, server.js refuses to start.
  It copies status, headers and body back, minus per-connection headers; the compression middleware then
  gzips as for its own answers, so ETags match too.
- **The secret is a shared env var** (`ECHO_SESHAT_SECRET`, given to both), not a random one per Node boot
  as planned above: a random one needs Node to start the service, which nothing does yet. Every service
  route refuses a request without it (403).
- **Node answers itself** when the service is unreachable (logged), or when the service's `x-echo-mode`
  isn't its own `ECHO_MODE`: a service started in local mode would otherwise answer a web-mode Echo with
  the CLI in its provider list. Found by the suite: `desktop-mode.test.js` boots server.js in desktop mode.
  The rest of the environment (`ECHO_PROVIDER`, `ECHO_THINKING`, ...) is not compared: give both the same.
- **Checked:** `seshat/check/routes.sh /api/health /api/providers` identical (status, headers, body, plain
  and gzip) in local mode, web mode, and with `ECHO_PROVIDER=deepseek ECHO_THINKING=high`. The Node suite
  passes with forwarding on (service up) and off: 717 pass, 15 skipped (POSIX-only), 0 fail. The
  forwarding's own branches are in `tests/seshat-forward.test.js` (a node:http stand-in for the service;
  removing the mode check fails it).
- Shortcuts in the middleware (`shortcut:`): JSON request bodies only (raw-body routes come in step 6),
  and the answer is buffered (streamed routes wait for the front-door swap or a streaming forward).

### Step 3: the usage meter (done)

- **`seshat/usagelog.ts`** on the service, and `POST /api/event` in `server.ts`, forwarded by server.js
  after `requireApproved`. Its JSON body is read as server.js's `express.json({ limit: '5mb' })` leaves
  `req.body` (`jsonBody()`): `{}` unless the type is `application/json`, `{}` for an empty body, a body of
  exactly 5 MiB read, one byte more server.js's 413 envelope, and anything but an object or array
  (body-parser's strict mode: `5`, `"x"`, `null`, blanks) or broken JSON its 400. Behind server.js those
  two never reach the service, since express.json() answers first; the service has them for the front-door
  swap. Shortcut (`shortcut:`): no charset or content-encoding handling yet, and a chunked body is read
  whole before the size check.
- **`routes.sh`** takes a request per argument now: `'POST /api/event <json>'`, `@file` for a body,
  `POST:<type>` for another content type, and a leading `!` for a request server.js answers before
  forwarding, which is then also sent to the service directly and must get the same status and body.
  Afterwards it compares the usage logs: server.js alone writes one, the service the other (lines with the
  `ts` masked, and the rotated `.1.jsonl`).
- **Checked:** 24 `/api/event` requests (each allow-listed event; `videoId` a number, null, cut through an
  emoji; arrays, `{}`, no body, `__proto__`, unknown names, `text/plain`, `charset`, upper case, 5 MiB, 5 MiB
  + 1, broken JSON, `5`, `"x"`, `null`, blanks) identical plain and gzipped, and the usage logs identical: in
  local mode, in web mode (no log on either side), with `ECHO_USAGE_SYNTHETIC=1 ECHO_USAGE_ROTATE_BYTES=600`
  (rotated several times), and `/api/health`, `/api/providers` and an event with `ECHO_PROVIDER=deepseek
  ECHO_THINKING=high`. The Node suite: 721 pass, 15 skipped, 0 fail with forwarding off, and the same with
  it on (the service started with `ECHO_USAGE_LOG_PATH` set to the suite's `ECHO_TEST_USAGE_LOG`, a
  test-only name, so `api.test.js` reads the line the service wrote). One run with forwarding on failed
  `digest-idle-timeout.test.js` (a 1 s idle timer, under load); alone it passed 3 of 3, and the full rerun
  passed.
- **Two bugs in step 2's forwarding, found by routes.sh:** curl sends `expect: 100-continue` with a body
  over 1 MB, which server.js copied onto its `fetch()`, which refuses it ("expect header not supported"),
  so a large body was quietly served by Node instead (now a skipped header); and a forwarded 204 got an
  `etag` that server.js's own 204 doesn't have (`res.send()` of an empty body; now `res.end()`). Both are in
  `tests/seshat-forward.test.js`, and reverting either fix fails it.

### Step 4: the library (built; byte-identical once gap 37 is fixed)

- **`seshat/store.ts`** (store.js on `bun:sqlite`), **`syncVault`** in `vault.ts`, and the routes in
  `server.ts`: `GET /api/saved` (whole or paged), `POST /api/saved`, `GET`/`DELETE /api/saved/:videoId`,
  `PATCH /api/saved/:videoId/tags`, `GET /api/saved/:videoId/export.md`, `POST /api/vault/sync`,
  `GET /api/search`. server.js forwards them with `seshatLibrary`, which forwards **only while accounts are
  off**: with accounts on, the library is the signed-in owner's file and a save may be mirrored to their PDS,
  and both stay on Node until step 8. The service also answers web mode with blockInWeb's 503, for when it
  is the front door.
- **`GET /api/saved/export` stays on Node** (not forwarded): it streams, and the forwarding buffers. Port it
  with a streaming forward or at the front-door swap.
- **Different on purpose: `POST /api/saved` checks its field types.** server.js binds whatever JSON brings:
  node:sqlite stores a number as REAL text in the TEXT columns (`5` becomes `"5.0"`) and refuses a boolean
  or an object with a 500. bun:sqlite would store `5` as `"5"`, so the two can't agree anyway. The service
  answers 400 `<field> must be a string.` for a `videoId` that isn't a string, and for `url`, `title`,
  `digest`, `channel`, `channelUrl`, `transcriptSource` or `whisperModel` that isn't a string or null.
  Segments and tags stay loose: they are turned into text in JavaScript, which the port copies (`jsString`),
  so junk there gives the same rows as store.js.
- **The forwarding sends the route's own path**, not the URL as sent: Express matches `/API/SAVED/x/` (any
  case, a trailing slash) and Bun's router doesn't, so such a request got the service's 404. The step 2 and 3
  routes had the same latent bug. `tests/seshat-forward.test.js` covers it.
- **routes.sh** gives each side its own `ECHO_DB_PATH` and `ECHO_VAULT_DIR` now (`@VAULT@` in a body is that
  side's folder), compares the two databases (`check/dbdump.mjs`) and vault folders afterwards, masks
  timestamps, `ms` and a sync's `dir`, compares a body that needed masking unzipped and without its etag and
  content-length, and compares headers in any order (fetch's `Headers` lists them sorted, so the forwarding
  can't keep the service's order; `export.md`'s two headers came out swapped). Step 4's requests are
  `check/library.sh`.
- **Checked:** `bash seshat/check/library.sh`: of 107 comparisons, 67 identical and 40 different only in key
  order (gap 37: status, headers and values match). The databases (rows, tags, FTS rows, user_version), the
  usage logs and the 9 vault files are identical. The Node suite: 721 pass with forwarding off (one run had
  `digest-idle-timeout`'s known load flake; alone it passed 3 of 3), and with forwarding on
  (`bash seshat/check/suite.sh`) 722 pass, 0 fail, 15 skipped. suite.sh runs `api`, `saved-pagination` and
  `page-serving` each against a service on that test's own database (`ECHO_TEST_DB_PATH`, test-only, like
  `ECHO_TEST_USAGE_LOG`), since they count what they save; their 400s and 404s are in those services' logs.
  `atproto-gating`'s "accounts off" guard reaches the shared service rather than its own database; it only
  asserts that nothing is refused.

## Seshat gaps found while porting

**Status on Seshat `main` ee849ba (2026-10-29; gaps 32 to 41 added 2026-10-30):** 41 gaps found, 20 fixed, and their workarounds removed
from the ports and case files: every case is still identical (922 now, with usagelog). Open: 8, 12's
`as-cast-traps` half, 14 for a thrown non-`Error` object, 24 and 25 (being fixed in the Seshat session), and
26 to 31 (new, not reported to the Seshat session yet). Each gap
has a repro in `seshat/gaps/<name>.ts` that runs under `node` and that `tsc --strict` accepts (the two
`Bun.serve` ones need `@types/bun`); `seshat run seshat/gaps/<name>.ts` shows the gap.

**Fixed** (on `main` since ee849ba; the repro gives Node's output, Bun's for 1): 1 serve-streaming-body,
2 json-undefined-unknown-field, 3 throwing-callback-result-json, 4 rethrow-any-c-error, 5
define-property-on-array, 6 guard-on-object-literal-crashes, 7 error-add-property, 9
index-out-of-range-traps, 10 record-lookup-in-conditional, 11 math-ceil-infinity, 12's as-record-traps
half, 13 number-of-non-string, 14's `any` parameter half, 15 generic-throwing-callback, 16
default-param-then-null-default, 17 and-or-narrowing, 18 in-operator-narrowing, 19
error-to-structural-type, 20 error-intersection, 21 isarray-unknown-is-any-array, 22
empty-array-as-unknown, 23 localecompare-options (but see 26).

### Open

8. **any-undefined-as-string: an `any` holding undefined, used where a `string` is declared, traps.**
   `function messageOf(err: any): { message: string } { return { message: err.message } }` on `{}`:
   ```
   trap: TypeError: an `any` holding undefined was used as a string
   ```
   Node prints `{}`. Answered in `whisper.ts` by typing the field `string | undefined`, which is the truth.
12. **as-cast-traps: `as` is checked at runtime and traps** where TypeScript's never fails: an array holding
    a `null`, cast to `{ text: string }[]`:
    ```
    trap: `as` cast failed: the value is of a different type
    ```
    The ports don't cast such values.
14. **throw-any: throwing a non-`Error` object traps.** Rethrowing an `any` parameter compiles now, but
    throwing `{ message }` through it:
    ```
    trap: TypeError: an `any` holding a value was used as Error
    ```
    Workaround in `check/whisper.cases.ts` (`shortcut:`): the scripted failures are Errors.
24. **serve-route-handler-value: a `routes` handler must be written inline.** `routes: { "/a": { GET: ok } }`
    with `ok` a function of the right type is refused with a misleading message:
    ```
    error[X0017] serve-route-handler-value.ts:4:47: "/a" isn't a field name: records have identifier field names
    ```
    Workaround in `server.ts`: `GET: (req) => refused(req) ?? health()`.
25. **A running service's binary can't be rebuilt, reported as a C compile failure.** With the service still
    running, `seshat run seshat/server.ts` after an edit printed "internal error: the generated C failed to
    compile (this is a bug in seshat)"; stopped, the same file built. Likely Windows locking the cached
    `.exe` (not confirmed). Workaround: stop the service before rebuilding.
26. **localecompare-compat-chars: ligatures, fullwidth letters and unit symbols sort after every letter.**
    `'ﬁle'.localeCompare('file', undefined, { sensitivity: 'base' })` is 1 (ICU: 0), and even the
    one-argument `'ﬁle'.localeCompare('zebra')` is 1 (ICU: -1); the same for `Ａ` (U+FF21) and `㎏`. `²`,
    `Ⅻ`, `ß`, `Æ` and `ſ` collate as ICU does. Repro `gaps/localecompare-compat-chars.ts`: Node prints
    `[0,-1,0,0]`, Seshat `[1,1,1,1]`. Found removing gap 23's workaround (an index with a `ﬁle` title
    sorted it last). Workaround in `markdown.ts` (`shortcut:`): both sides `normalize('NFKC')` first, which
    ICU at base strength already sees through, so Node's order is unchanged.

New in step 3:

27. **dynamic-import: `await import()` doesn't parse.**
    ```
    error[P0004] dynamic-import.ts:3:24: expected an expression, found `import`
    ```
    A module that reads its environment when it loads (usagelog.js) is tested by setting the environment,
    then importing it. Side-effect imports aren't Seshat's either (documented). Workaround in
    `check/usagelog.cases.ts` (`shortcut:`): `run.mjs` sets that case file's environment.
28. **import-meta: `import.meta.url` doesn't parse** (nor, so, Node 22's `import.meta.dirname`):
    ```
    error[P0004] import-meta.ts:3:30: expected an expression, found `import`
    ```
    usagelog.js finds `data/` from it. Workaround in `usagelog.ts` (`shortcut:`): `process.cwd()`, the repo
    root the service is started from.
29. **fs-rename: no `rename`.** It isn't one of Seshat's own `node:fs/promises` calls, so the import goes to
    Node's JavaScript module, which needs JavaScriptCore; on Windows:
    ```
    error: npm packages need JavaScriptCore: install WebKitGTK's (on Debian and Ubuntu, libjavascriptcoregtk-4.1-dev; pkg-config finds it)
    ```
    And the other names in the same import become `Js`: `(await stat(p)).size >= n` is T0501, "can't
    compare `Js` with `f64` using `>=`". Workaround in `usagelog.ts` (`shortcut:`): rotation copies the
    file and unlinks it, which can lose an append landing in between.
30. **top-level-await-loop-regex: the generated C doesn't compile.** A regex literal at the top level and an
    `await` inside a top-level loop; the top level is emitted twice, each copy declaring the literal's cache:
    ```
    error: internal error: the generated C failed to compile (this is a bug in seshat)
    ...: error: redeclaration of 'rec2' with no linkage
    ```
    Workaround in `check/usagelog.cases.ts` (`shortcut:`): the loop is in an async function.
31. **response-null-body: `new Response(null, ...)` is refused**, the usual way to write a 204 (TypeScript's
    `BodyInit | null`):
    ```
    error[T0001] response-null-body.ts:4:26: expected `string | URLSearchParams | u8[] | Blob | FormData | ReadableStream | undefined`, found `null`
    ```
    Workaround in `server.ts` (`shortcut:`): `undefined`.

New before step 4:

32. **sqlite-all-infer: `Statement.all()` without a type argument is refused** (tsc with `@types/bun`
    gives `unknown[]`; `.get()` without one builds):
    ```
    error[T0305] sqlite-all-infer.ts:5:28: can't infer type argument `T` of `Statement.all`
    ```
    Answered by typing the rows (`.all<Row>()`), which store.js's port wants anyway.

New in step 4 (33-39 reported 2026-10-30, 37 as blocking; 40 and 41 mentioned there, not numbered):

33. **writefilesync-encoding:** `writeFileSync(path, text, 'utf8')` is refused (T0201, takes 2 arguments).
    Workaround in `vault.ts` (`shortcut:`): no encoding argument; UTF-8 is the default.
34. **mkdir-recursive:** `mkdirSync(a/b, { recursive: true })` with `a` missing is ENOENT on Windows.
    Workaround `mkdirp` in `store.ts` (`shortcut:`): one level at a time.
35. **sqlite-unknown-number:** a number held in `unknown` (from JSON.parse) is bound as a truncated integer:
    1.5 is stored as 1. Data loss for anyone binding parsed JSON; Echo checks its types first.
36. **sqlite-real-as-number:** `get<{ x: number }>()` of a REAL fails ("Expected an integer but found 1.5").
    Echo reads only integers into number fields.
37. **object-key-order (blocks step 4):** inside `store.ts`, `Meta`, `Entry` and `SearchResult` serialise their
    fields in another order than written (the fields shared with `Entry` first, in `Entry`'s order), even a
    `const m: Meta = {...}` literal. The interfaces alone and a small Entry-to-Meta program print correctly,
    so the repro (`gaps/object-key-order.ts`) drives `../store.ts`. Not worked around: that would mean
    serialising every response by hand.
38. **union-array-in-unknown:** `const xs: unknown[] = [1, [2, null]]`, then `Array.isArray(xs[1])` traps ("an
    array of a union type held in `unknown` can't be read as `unknown[]` yet"). The same values from JSON.parse
    work, so `check/store.cases.ts` builds them that way, as the route gets them.
39. **string-of-nested-array:** `String([1, [null, 'x'], 3])` (and `join`) is `1,null,x,3`; JavaScript writes
    `1,,x,3`. Workaround in `vault.ts` (`shortcut:`): a segment's text array goes through store.ts's `jsString`.
40. **unknown-or-empty-array:** `x || []` with `x: unknown` is T0301 (can't infer the empty array's type).
41. **isarray-field-narrowing:** `Array.isArray(rec.tags) ? rec.tags : []` doesn't narrow the field (T0001).
    Workaround for both in `store.ts`'s legacy import (`shortcut:`): locals.

Things that worked the first time and were worth checking: V8's lenient `new Date(string)` parsing
(including local time and rollover), JSON with lone surrogates and integer keys, UTF-16 `slice` through
emoji, `\p{M}` with `normalize('NFD')`, regex flags, `toLocaleString('en-US')`, `Object.values` over a
`Record`, `process.env[name]`, `setTimeout`-based retry delays, top-level `await`, FTS5 compiled into the
vendored SQLite.

## Picking this up

Step 4 is built and waits for gap 37 (key order) on Seshat. When the Seshat session says it is fixed,
`node seshat/check/run.mjs store` must be identical on all three rows and `bash seshat/check/library.sh` must
show no DIFF; then step 4 is done (mark it done in the plan table, push). Run the suite both ways:
`npm run test:only`, and `bash seshat/check/suite.sh` with forwarding on.

Next after that is step 5, transcripts. `GET /api/saved/export` is still Node's (it streams).

**bun:sqlite probe (2026-10-30), passed.** `seshat/check/sqlite-probe/` runs store.js's SQLite usage on
`node:sqlite` (`node.mjs`) and on `bun:sqlite` under Seshat (`bun.ts`), each on its own database file:
`node --no-warnings seshat/check/sqlite-probe/node.mjs <a.db>` against
`seshat run seshat/check/sqlite-probe/bun.ts <b.db>`. Identical on Windows: WAL, foreign keys and the
cascade, `PRAGMA user_version` set and kept over close and reopen, `table_info`, rowid-keyed FTS5 with
`snippet()` (Unicode, emoji, `…` ellipsis), the error messages of a UNIQUE violation and of two malformed
MATCH queries, `BEGIN`/`ROLLBACK`/`COMMIT`, a missing row as `null`. The one difference: `run()`'s result
is `{changes, lastInsertRowid}`, Node's `{lastInsertRowid, changes}`; store.js reads only `.changes`.
store.js already uses `exec('BEGIN')`/`COMMIT`/`ROLLBACK`, not a transaction helper, so step 4 does not wait
for `db.transaction()` or named parameters (on Seshat's list after gaps 26-31).

Gap 24 is fixed on Seshat main (the repro prints `ok`); its workaround in `server.ts` is still there. Gaps 26
to 31 are reported (2026-10-30) and being fixed on Seshat's branch `echo-gaps-2`; keep their workarounds until
the Seshat session says it is merged. Gaps 33 to 39 are reported too (37 as blocking). Gap 25 did not reproduce there: send exact steps if it happens again.
Find the session with ListAgents rather than editing ../Seshat from here. When a gap is fixed: delete its `shortcut:`
workaround (grep for the gap's name), rerun `node seshat/check/run.mjs`, and move the gap to the "fixed"
line here.

The branch is pushed to `origin`; push after each step.
