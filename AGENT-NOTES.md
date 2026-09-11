# Agent notes

Working notes for agents on this repo. `CLAUDE.md` is the project's own
accumulated memory and is owned by the maintainer — **this file is separate and
deliberately so.** It records how the codebase wants to be worked on, and the
state of the provider workstream, so a future session does not have to rediscover
either.

When this file and `CLAUDE.md` disagree, trust the code and git history. When
either disagrees with the tests, run the tests.

---

## House rules, derived from the code

These are not preferences. Each one is visible in the history as something that
went wrong once.

**Comments explain *why*, with the measurement.** The codebase records the number
that justified a decision ("10.5 ms/save at 100 entries, 23.7 at 800"), the
alternative it rejected, and the failure mode. A comment that restates the code is
noise; a comment that records a trap is the reason this repo is maintainable.

**No new runtime dependencies without a fight.** Three runtime deps total.
Compression, CSP, rate limiting, markdown and ZIP are hand-rolled. Prefer the
platform: `fetch`, `node:sqlite`, `zlib`, `WebSocket` (which is how the browser
harnesses drive CDP with no npm dependency at all).

**Tests are targeted at regressions, not coverage.** A file exists because
something broke. Test names describe the *property*, usually with the reason.

**Assertions are mutation-tested.** Revert the fix; the test must fail. Anything
else is decoration. This is written down as a standard, and it caught real
weakness in this workstream — see below.

**Never make a fifth copy of a function or a fact.** `common/text.js` is the
definition for two shared helpers and a parity test fails if any copy disagrees.
Provider facts live in one registry and are *served* to the browser, for the same
reason.

**Two duplicated controls that carry state are the same bug as two copied
functions.** The reading controls were once duplicated as radios sharing one
`name`, which makes them one group document-wide — so only the last could ever
show a selection. Two `<select>`s bound to one storage key is fine *because* the
re-sync is explicit.

**The frontend is under CSP with no `'unsafe-inline'` and no third-party origin.**
New JS goes in `src/client/main.js`, new CSS in `src/styles/app.css`, colour and
spacing come from tokens. `el.style.width = x` (CSSOM) is fine; a `style=""` in an
`innerHTML` string is refused. **A class that sets `display` beats the UA
`[hidden]` rule**, so anything you intend to hide needs an explicit
`X[hidden] { display: none }` in the same commit.

**Adding or deleting a backend module means editing `tauri.conf.json`'s
`bundle.resources`.** Nothing in `node --test` catches the omission — the sidecar
only fails at runtime with `ERR_MODULE_NOT_FOUND`. Keeping provider code inside
`providers.js` avoided this entirely.

**Windows is a second-class citizen for verification.** 15 digest-streaming and
cancellation tests are skipped on POSIX-only spawn paths, `kill('SIGTERM')` can
never be tested (it maps to `TerminateProcess`), and the browser harness needs
`ECHO_CHROME` with a path that reports "no Chrome found" rather than failing when
wrong. A green Windows run says less than it looks like it says.

**Line endings are mixed and it matters.** `core.autocrlf=true`, so the working
tree is mostly CRLF while `providers.js` and the `common/` files are LF. Tooling
that matches multi-line text must respect the file's own ending, or edits silently
fail to apply. (This bit a mutation test during this workstream.)

---

## What changed, and why

The ask was to be able to compare models — specifically to try DeepSeek against
the existing Claude paths — with a toggle. While investigating, one thing turned
up that changed the shape of the work.

### Finding: the digest could be silently truncated

`ApiKeyProvider` hardcoded `max_tokens: 16000`, and **`stop_reason` was read
nowhere in the repository**. A response cut off at the ceiling was returned as a
plain success and then saved, exported, written to the vault and mirrored to the
PDS like any other. Because article mode ("Everything") is a full-fidelity rewrite
and 16 000 tokens is roughly 90 minutes of video, that mode truncated on any long
video — invisibly, and only on the BYOK path, which is the one path the project
already listed as unverified end-to-end.

The maintainer's own library showed why it had never been seen: 11 entries, all in
digest mode, largest ≈ 3 193 tokens — five times under the cap — generated in local
mode where the keyless CLI provider has no such parameter.

### Files

| File | Change |
|---|---|
| `providers.js` | Registry; DeepSeek provider; truncation detection; per-provider limits; reasoning levels with a per-provider dialect; `publicProviderList()`; per-provider key validation. Rewritten, LF preserved. |
| `digest.js` | Chunk geometry derived from the provider; `thresholdCharsFor()`; `chunkBudgetCharsFor()`; truncation propagated from the fast path and both map-reduce phases. |
| `server.js` | `GET /api/providers`; `X-Echo-Provider` handling; `PROVIDER_UNKNOWN`; provider-aware key reading and validation; `truncated` in logs and payloads; honest `provider`/`model` in the usage meter instead of a hardcoded `'sonnet'`. |
| `src/client/main.js` | Per-provider key storage; provider preference; both pickers; the truncation notice; the key section now follows *need* rather than mode. |
| `src/components/DigestPane.astro` | Provider picker in Options; truncation-notice element. |
| `src/components/SettingsModal.astro` | Provider picker **outside** the key section, so it stays reachable. |
| `src/styles/app.css` | One shared select skin extended rather than copied; truncation notice with its `[hidden]` guard. |
| `tests/providers.test.js` | New — 59 tests. |
| `tests/digest-stream-provider.test.js` | New — 5 tests. The streaming route over a loopback mock provider, so it has Windows coverage that the POSIX-only `digest-stream.test.js` cannot give. |
| `.env.example`, `README.md`, `PROVIDERS.md` | Documentation. |

`CLAUDE.md` was deliberately not touched, per instruction.

### The A/B harness (tools/ab-compare.mjs)

`npm run digest:ab`. Same transcripts, two providers, scored on both axes. It calls
`tools/fidelity/specifics.mjs` and `tools/ai-tell/patterns.js` rather than reimplementing
either, fixes format/language/reasoning per arm and prints them, and reports
*supported* and *coverage* side by side — an arm can win "supported" by saying nothing,
which is why coverage is printed next to it. It strips `CLAUDECODE`/`CLAUDE_CODE_*`
before the CLI arm, because this repo has already recorded that inheriting them makes a
`claude -p` subprocess behave differently from a user's.

Its pure parts (`pickCorpus`, `scoreOne`, `summarizeRuns`) are exported and covered by
`tests/ab-compare.test.js`, and the run is behind a direct-run guard so importing the
module in a test cannot spend money. Build it that way: the aggregate is what someone
decides on, so it must not be the unguarded part.

### The A/B ran, and it found two real defects

`npm run digest:ab`, 11 transcripts, ~407k chars, thinking off, both arms, no
failures. Full numbers in `PROVIDERS.md`. The short version: DeepSeek was not worse
on either axis (92% vs 86% of numbers supported, 68% vs 58% coverage, 10 vs 15
fabricated) at ~2.6x the speed and ~3.8x fewer tokens — but it wrote 2 004-word
digests against Claude's 1 425, and coverage rises with length, so that confound is
recorded rather than claimed away.

**Bug 1 — DeepSeek truncated a long article.** `article` mode on a 71 627-char
transcript returned `finish_reason: 'length'` at 6 552 words. Cause: `max_tokens`
was deliberately omitted so the API could choose, and the API's *default* ceiling is
far below the model's maximum. Fixed by sending 384 000 (a value a live probe
confirmed is accepted). Re-ran the exact case: **9 030 words, 27/27 numbers, 96%
coverage, no truncation** — the omission had been silently costing a quarter of the
article and the tail's specifics.

**Bug 2 — the local CLI exceeded its own timeout on a long article.** 185 s against
a 180 s cap, on the same ~70-minute transcript, while `digest` mode peaked at 64 s.
The default is unchanged (it is a genuine hang detector) and
`ECHO_DIGEST_TIMEOUT_MS` now exposes it.

Both are the argument for the work that came before them: bug 1 was *visible* only
because truncation is now reported, and bug 2 only because the harness prints a
per-call cap and flags runs that exceed production's.

### The "update what's necessary" pass found three more defects

Auditing the docs for staleness turned up three things that were not documentation
problems at all.

**1. A provider-specific accessor used as a general test.** Five call sites asked
`getApiKey()` — which reads Anthropic's storage slot — when the question was "does
this user have a key?". The worst was the auto-digest gate: in web mode it read
`ECHO.mode !== 'web' || getApiKey()`, so **a visitor who chose DeepSeek got no
auto-digest at all** — no error, nothing on screen, just silence. The CLI-missing
hints were the same bug's friendlier face: they told you to add a key you had
already saved. All five now call `activeApiKey()`, which asks the *selected*
provider, and the three Anthropic-specific accessors are deleted rather than left
lying around to be reached for again.

**2. …and fixing that introduced a race.** `activeApiKey()` resolves through
`activeProviderId()`, which validated the stored preference against `PROVIDER_LIST`
— a list that arrives from `GET /api/providers` asynchronously. But
`autoLoadFromQuery()` applies an extension-supplied transcript **synchronously
during INITIALISE**, so on a cold page load the transcript lands first and
`activeProviderId()` returned `''`. Two failures from one cause: the auto-digest
gate saw no key again, and the first AI request went out with **no
`X-Echo-Provider` header** — sending a DeepSeek user's key to Anthropic. A stored
preference is now trusted on its own; the list only tells us which preferences
exist. Caught by a browser probe, not by any unit test, because it is a timing
property across an async boundary.

**3. Copy that named one vendor.** A hosted visitor was told "An Anthropic API key
is required for this hosted instance" when DeepSeek was equally valid, and the
privacy/terms overlays described *your Anthropic API key* as if there were one
provider.

Guard: `tests/providers.test.js` asserts the client never CALLS a
provider-specific accessor, and never passes a string literal to
`getKeyForProvider()`. The first version of that guard only checked the accessor
— and a mutation reintroducing the identical bug as
`getKeyForProvider('anthropic')` sailed straight through it, which is why there are
two shapes and both were mutation-checked.

Behaviour was verified in a real browser against a loopback mock: in **web** mode,
with a DeepSeek key stored and DeepSeek selected, a fragment-supplied transcript
auto-digests and renders — 5/5, where the pre-fix code produced silence.

### Verification

- **715 unit tests, 700 pass, 0 fail, 15 skipped** (baseline was 632 / 617 / 0 / 15).
- **Mutation-tested**: deleting the Anthropic `stop_reason` read fails exactly 2
  tests; deleting the map-phase truncation capture fails exactly 1; making DeepSeek
  inherit `16_000` fails exactly 2; deleting the streaming truncation report fails
  exactly 1; inferring the reasoning dialect from `opts` again fails exactly 1. Each
  mutation failed only the tests that cover it — no over- or under-coupling.
- **Real browser**: `page-smoke.mjs` 24/24 (layout invariants, `[hidden]` holds, no
  uncaught JS errors, no failed requests).
- **Real browser, provider UI**: a throwaway CDP probe (19/19) confirmed the
  selects populate from `/api/providers`, that choosing a key-requiring provider
  reveals and relabels the key field, that both pickers stay in sync, that the
  preference persists, and — the case the layout was designed around — that
  switching *back* to the CLI is reachable.
- **Streaming route over real HTTP** (now a committed test, and therefore also a
  Windows one): the concatenated `token` events equal `done.digest` exactly, the
  parallel tagging call is not mistaken for the digest, the provider's key and
  model are what get sent, and a stream that stops at the output ceiling still ends
  in `done` with `truncated: true` rather than an `error`.
- **The thinking control, all the way to the wire** (throwaway CDP probe, 16/16):
  against a loopback mock provider, with a real transcript delivered over the
  extension fragment path, the browser's picker reaches the provider's request body —
  `off` sends `thinking:{type:'disabled'}` and no `reasoning_effort`, `high` sends
  `reasoning_effort:'high'` with no `budget_tokens`, the model id is `deepseek-flash`,
  and the control hides again for the CLI.

### Finding: the default DeepSeek model id was wrong

Shipped first as `deepseek-chat` — the OpenAI-compatible-era alias, carried over by
assumption rather than checked. [docs.deepseek.com](https://api-docs.deepseek.com)
lists exactly two ids: **`deepseek-flash`** and `deepseek-v4-pro`, and
`deepseek-flash` *is* DeepSeek-V4.1-Flash. (`deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` are accepted legacy names served by the same model;
`deepseek-v4-pro` also routes to V4.1 Flash from 2026-09-14. `deepseek-chat` is not
in the list.)

The lesson is specific and worth keeping: **a model's wire id and its product name
are different strings.** "Which model am I using?" cannot be answered from the UI
label, and nothing at build time or in any test would have caught a wrong id — only
a real request, as a rejection. Fixed, documented in three places, and **pinned by a
test** so a future rename fails loudly at the one line that needs changing.

### Finding: reasoning was a hidden second variable in any comparison

Anthropic's path always sent `thinking: {type: 'disabled'}`; DeepSeek's sent nothing,
leaving it to the API's default. If that default is `enabled`, switching provider
changed *two* things at once and a difference in output could not be attributed to
either. There is now one vocabulary (`off`/`low`/`medium`/`high`), translated per
provider: a `budget_tokens` on Anthropic (clamped — an out-of-range budget is a hard
400), `reasoning_effort` on DeepSeek, and nothing at all for the CLI. **Off is the
default and is sent explicitly**, so it means off rather than "whatever this API
decides".

Reasoning output is also filtered on every path — Anthropic `thinking` blocks,
DeepSeek `reasoning_content`, and DeepSeek `delta.reasoning_content` while streaming —
with tests that put a literal `PRIVATE DELIBERATION` string in each place and assert it
reaches neither the result nor the token stream.

### Finding: the dialect was inferred from a request that implies the wrong provider

The first version of `reasoningFields(opts)` resolved the dialect from `opts`, which
looks right because a request usually names its provider. It is wrong: DeepSeek is
reached with `{ apiKey }` and no `provider`, and a bare key means **Anthropic** to
`getProviderId()` — so DeepSeek was sent Anthropic's `budget_tokens` dialect, which its
API would have rejected on every digest. Caught by a test asserting the **request body**
rather than the resolver's return value, which is the argument for testing the wire
shape and not just the helper. Each provider now passes its own id explicitly.

### Two things the verification itself caught

Worth recording, because both are the failure mode this repo warns about — *the
instrument corrupting the verification*.

1. **The probe passed two checks for the wrong reason.** `checkVisibility()` on
   `#apiKeySection` returns false whenever the Settings modal is `[hidden]`, since
   that hides the whole subtree. "The key section is hidden for the CLI" was
   therefore true whether or not the code did anything. Fixed by asserting the
   `hidden` property *and* opening the modal before asking about visibility.
2. **A full-suite run failed once on a timing assertion** in
   `tests/page-serving.test.js` ("a cold asset request took 572 ms"), then passed
   in isolation and on two subsequent full runs, before and after these changes.
   It is a 300 ms budget for a request racing a brotli warm-up under `node --test`'s
   parallel file execution. Pre-existing flakiness, not a regression — but it is a
   real one to know about.

---

## CLAUDE.md: updated 2026-09-11

`CLAUDE.md` described a two-provider seam (CLI + Anthropic BYOK) that no longer
exists, which had made the project's own memory file the least accurate document
in the repo. It has now been updated — the maintainer authorised it after this
workstream, having originally asked for it to be left alone.

What changed there: line 12 (the `**AI:**` bullet) now describes the registry,
`X-Echo-Provider` and `GET /api/providers`; the module map's `providers.js` entry
says what it actually contains; the digest feature bullet and the three-modes table
mention the per-run provider choice and per-provider keys; "What's left" records
that the Anthropic API arm is **deliberately** unmeasured rather than pending; and
three new gotchas record the traps this workstream paid for — the unread
`stop_reason`, the reasoning dialect that must come from the caller, and the
provider-specific key accessor whose fix exposed an async race.

`PROVIDERS.md` is now listed under Key docs. Its own statements were checked at the
same time and are current as of that date.

## Open questions

- **`thinking: {type: 'disabled'}` is sent on trust.** DeepSeek's docs document
  `{type: 'enabled'}`; that the same object accepts `disabled` is a strong convention
  rather than a documented fact. If it is rejected, `ECHO_DEEPSEEK_THINKING_FIELD=omit`
  drops the field — but that would also drop the guarantee that "off" means off, so
  the real answer is one live request to confirm it.
- **The Anthropic API arm is NOT measured, and that is a decision, not a gap.**
  Decided 2026-09-11. The CLI arm covers local use (keyless, `claude -p` with its own
  login) and the DeepSeek arm covers the second provider; the `anthropic` provider
  exists for hosted web mode and desktop-BYOK, neither of which is what this
  instance is run as. Adding an Anthropic key purely to score digests it would
  never produce locally is not worth the cost.

  The distinction that matters: **that path's behaviour is already verified**, by
  `tests/provider-error-mapping.test.js` and the truncation tests, which drive
  `ApiKeyProvider` through a mocked SDK — including `stop_reason: 'max_tokens'`
  mapping to `truncated`. What is missing is a live *quality* measurement on that
  provider, which is the part being skipped on purpose.
- **The 16 000-token cap on the Anthropic API path is a known, documented outcome,
  not an unknown.** It is where the original finding came from, it is unchanged on
  purpose (raising it is a behaviour change, not a bug fix), and the consequence is
  now predictable: `article` mode truncates past roughly 90 minutes of video — and
  says so, instead of saving a half-digest that looks finished. Anyone enabling web
  mode later inherits a stated limit, not a mystery.
- **A live reasoning run may hit the ceiling sooner on Anthropic.** Reasoning tokens
  count as output tokens, and Anthropic's budget comes out of the same 16 000 as the
  digest, so `high` leaves roughly half the budget for the article. Worth measuring
  rather than assuming, and it is exactly what the truncation notice reports. The A/B
  only ever ran with thinking off, deliberately — so the reasoning arms are still
  unmeasured.
- **`ECHO_DEEPSEEK_API_KEY` now lives in `.env.local`** (gitignored, verified untracked).
  The key was pasted in chat, so it should be rotated when convenient.
- **The CLI's output ceiling is bounded from below, not measured exactly.** The A/B
  is the evidence: an `article`-mode digest of a 71 627-char transcript reached
  **8 946 words with no truncation**, so `claude -p`'s ceiling is above ~12k output
  tokens — and on that same run the **180 s timeout fired first (185 s)**. So on the
  CLI path the practical limit is time, not tokens, which is why
  `ECHO_DIGEST_TIMEOUT_MS` is the knob that matters there. Whether the CLI reports a
  ceiling as `is_error` remains untested, because it was never reached.
- **The provider and thinking probes are not committed.** They live outside the repo,
  so runtime coverage of the pickers is currently manual. If it is wanted permanently,
  `tests/e2e/` is the right home, alongside `page-smoke.mjs`. (The streaming probe
  *was* made permanent, because it covers a path the suite skips on Windows.)
