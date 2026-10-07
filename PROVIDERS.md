# AI providers

Echo writes digests with one of three providers. Which one runs is a user choice,
not a build-time decision, and the seam that makes that possible lives in
`providers.js`.

| Provider id | Label | Kind | Key | Context | Max output |
|---|---|---|---|---|---|
| `claude-cli` | Claude CLI (this machine) | `cli` | not needed | 1 000 000 | — (the CLI's own) |
| `anthropic` | Anthropic API | `anthropic` | required | 200k | 16 000 |
| `deepseek` | DeepSeek API | `openai` | required | 1 000 000 | 384 000 |

DeepSeek's wire model id is `deepseek-flash`, which **is** DeepSeek-V4.1-Flash — the
id and the display name differ, and that is how a wrong default gets shipped: the
first version of this file sent `deepseek-chat`, an OpenAI-era alias
[docs.deepseek.com](https://api-docs.deepseek.com) no longer accepts. As of
2026-09-11 the documented ids are `deepseek-flash` and `deepseek-v4-pro`
(the latter also routing to V4.1 Flash from 2026-09-14). Override with
`ECHO_DEEPSEEK_MODEL`, and see the caveat under *Deliberate non-goals*.

## Why there is a registry

The three providers differ in more than transport. They differ in **facts** that
must never be inherited from one another:

- how many output tokens they can produce (16 000 here, ~384 000 there)
- how large a prompt they can hold, which sets where map-reduce begins
- how many characters make a token, which is a tokenizer property
- whether a key is needed at all

All four used to be either literal in one provider or a constant in `digest.js`,
which was only safe while Anthropic was the only API provider. A second one
inherits the first one's numbers by default, and the failure is silent.

`PROVIDERS` in `providers.js` is the single source of those facts. Nothing else
in the codebase may restate them — `digest.js` derives its chunk geometry from
them, `server.js` serves them to the browser, and the browser builds its controls
from that response rather than holding a list of its own.

## Truncation is the reason this file exists

Anthropic's output ceiling was `max_tokens: 16000`, hardcoded at the call site.
`stop_reason` was read **nowhere** in the repository. So a digest that ran out of
room came back as an ordinary success: saved to the library, exported to
Markdown, written into the Obsidian vault, mirrored to the atproto PDS —
indistinguishable from a complete one. Nothing in the product, the tests or the
UI could have noticed.

The arithmetic makes it worse than an edge case. Article mode ("Everything") is a
full-fidelity rewrite that keeps everything substantive; at ~150 wpm speaking and
~85% retention that is ~128 words per minute of video, against a 16 000-token
ceiling of roughly 11 800 words — so **any video past about 90 minutes truncated.**
It stayed hidden because local mode runs the keyless CLI provider, which has no
such parameter, and because digest mode is compressed to 2–3k tokens.

### The contract

A truncated response is **not** thrown as an error. The text that exists is real,
is on screen already when it streamed, and is worth keeping — discarding it would
turn a partial answer into no answer. Instead:

- the provider returns `{ result, usage, truncated: true, truncationNote }`
- `generateDigest()` propagates both fields, from the fast path **and** from
  either phase of map-reduce (a truncated *map* chunk is a hole in the middle of
  the video, which no reader could spot from the finished digest)
- the route passes them through in the JSON body and in the SSE `done` event
- the client renders `#digestTruncationNote` next to the text it applies to

Detection is one function, `isTruncationReason()`, because the two APIs spell the
same fact differently — Anthropic `stop_reason: 'max_tokens'`, OpenAI-compatible
`finish_reason: 'length'` — and neither ever raises an error for it. The CLI path
reads `stop_reason` defensively; if a given CLI build does not emit it, nothing
changes.

**If you add a provider, wire its finish reason into `isTruncationReason()` or
its ceilings will be invisible.**

## Request shapes

Two shapes exist, and they are deliberately kept comparable. The Anthropic API
path sends the prompt as a single user message; the DeepSeek path does the same,
even though OpenAI-compatible APIs accept a system message, because the isolating
system prompt is a **CLI-only** concern. Adding a system message to one API
provider but not the other would make a model comparison measure the prompt
change as well as the model.

DeepSeek's transport is plain `fetch`, not a new dependency: Node 22's global
`fetch` covers both the request and the SSE stream. This matters beyond tidiness
— a new runtime dependency would also have to be staged into the Tauri bundle's
`node_modules`.

`max_tokens` **is** sent to DeepSeek, and this is a corrected decision rather than
an original one. It was omitted at first, on the reasoning that the API's own
ceiling beats one we assert. The provider A/B measured what that costs: an
`article`-mode digest of a 71 627-char transcript came back
`finish_reason: 'length'` at **6 552 words**, 16 of 23 numbers supported, 70%
coverage — while the same transcript with a ceiling set produced **9 030 words**,
27 of 27 numbers, and 96% coverage. The API's *default* ceiling is far below the
model's maximum, so omitting it truncated the one mode that rewrites a whole
video. Digest mode never showed it: 2–3k output tokens is nowhere near a limit.

The default is the model's stated maximum (384 000), and a live request carrying
exactly that value was accepted before it became the default. A ceiling is not a
request to generate — unused room is not billed.

## Chunk geometry

`digest.js` derives both thresholds from the resolved provider:

```
longPathThreshold = contextTokens x charsPerToken x 0.60
chunkBudget       = contextTokens x charsPerToken x 0.45
```

Those ratios are the original hardcoded numbers expressed as ratios of the
Anthropic API's window (480 000 and 360 000 against 200 000 x 4), so that
provider's behaviour is unchanged **by arithmetic rather than by coincidence**.
The `claude-cli` entry is a 1 000 000-token window (claude-opus-5-5 reports
`contextWindow: 1000000` in the CLI's `modelUsage`), so its threshold is
2 400 000 chars and its chunk budget 1 800 000 — `thresholdCharsFor({})` is
asserted to be exactly 2 400 000. A 1M-token provider stops chunking where a
200k one would have started, which is the point.

## The wire contract

| Header | Meaning |
|---|---|
| `X-Echo-Provider` | Which provider this request means. Absent = resolve normally. |
| `X-Echo-Api-Key` | The key **for that provider**. Never a different vendor's. |
| `X-Echo-Thinking` | `off`/`low`/`medium`/`high`. Absent = use `ECHO_THINKING`. |

Resolution order is `explicit provider` → `a bare key means Anthropic` →
`ECHO_PROVIDER` → the local default. A bare key still meaning Anthropic is
load-bearing: every caller that existed before DeepSeek sends exactly that.

Three rules that are easy to get wrong:

- **An unknown provider name is a 400, not a silent fallback.** An unrecognised
  `ECHO_PROVIDER` in a `.env` falls back to the default (a typo must not stop
  `npm start`), but a *request* naming a provider we do not have is a client bug
  and gets `PROVIDER_UNKNOWN`. Silently substituting would bill the wrong account.
- **In local mode a key is honoured only when a provider is named.** A key
  appearing out of nowhere must not move a local install off the keyless CLI —
  that is the surprise the original web/desktop-only rule existed to prevent. But
  "use DeepSeek, here is its key" is deliberate, and without it the picker would
  be unusable in the mode this app is actually run in.
- **`claude-cli` is not offered in web mode.** A hosted instance has no `claude`
  binary; a control that cannot work is worse than an absent one. `GET
  /api/providers` filters it, and `default` falls back to the first available
  entry so the client is never handed a default it cannot select.

## Keys in the browser

One key per provider, in separate `localStorage` slots. Anthropic keeps the
**original** slot name (`echo-anthropic-key`) because a key saved before providers
existed must not have to be re-entered. The Settings save button validates the key
against `/api/validate-key` **with the provider named**, or a DeepSeek key would be
judged against Anthropic's models endpoint and reported invalid for the wrong
reason.

The key section is shown exactly when the active provider needs a key — not "in
web/desktop mode", which was the old rule and is now wrong, since local mode is
precisely where someone would choose DeepSeek. The picker itself lives **outside**
that section: putting it inside would make it unreachable at the one moment it is
needed, coming back from the CLI to an API provider.

## Reasoning ("thinking")

One vocabulary, four values, translated into each provider's dialect. It exists
for exactly one reason: **a comparison between two providers has to mean
something.**

Echo's Anthropic path has always sent `thinking: {type: 'disabled'}`. The DeepSeek
path initially sent nothing at all — which leaves the decision to DeepSeek's own
default. If that default is `enabled`, then switching provider changes *two*
things at once (the model, and whether it reasons before answering), and a
difference in the output cannot be attributed to either. The same asymmetry made
the old code's intent unreadable: was Anthropic's `disabled` a deliberate choice
for this workload, or a leftover?

| Level | Anthropic (`anthropic-budget`) | DeepSeek (`effort`) |
|---|---|---|
| `off` _(default)_ | `thinking: {type:'disabled'}` | `thinking: {type:'disabled'}` |
| `low` | `thinking: {type:'enabled', budget_tokens: 2048}` | `thinking: {type:'enabled'}`, `reasoning_effort: 'low'` |
| `medium` | `budget_tokens: 4096` | `reasoning_effort: 'medium'` |
| `high` | `budget_tokens: 8000` | `reasoning_effort: 'high'` |
| — | `claude-cli`: **nothing**, no dialect | |

Three details that are deliberate:

- **Off is SENT, not omitted.** Omitting the field would let each API's default
decide, which is the problem this whole control exists to remove.
- **Anthropic's numbers are Echo's mapping, not the API's.** Anthropic has no
notion of an effort level, so a level has to become a budget. The mapping is
written down (`ANTHROPIC_THINKING_BUDGETS`) and overridable
(`ECHO_THINKING_BUDGET_TOKENS`), and it is **clamped** to the API's valid range —
`>= 1024` and strictly below `max_tokens` — because an out-of-range budget is a
hard 400 rather than a clamped one.
- **The dialect is passed explicitly by each provider**, never inferred from the
request. See the bug below.

### The dialect must come from the caller, not the request

`reasoningFields(opts)` originally resolved which provider's dialect to use from
`opts` — which looks correct, because a request usually names its provider. It is
wrong: the DeepSeek provider is reached with `{ apiKey }` and no `provider`, and a
bare key means **Anthropic** to `getProviderId()`. So DeepSeek was handed
Anthropic's dialect and sent `budget_tokens` to an API expecting
`reasoning_effort`, which would have been rejected on every digest.

Found by a test asserting the *request body*, not the resolver's return value —
which is the argument for testing the wire shape rather than the helper. Each
provider now states its own dialect (`reasoningFields(opts, 'deepseek')`), and
that cannot be got wrong by a caller.

### Reasoning must not reach the digest

A model's deliberation is not part of the answer. Anthropic returns it as separate
`thinking` blocks; DeepSeek as a `reasoning_content` field (or `delta.reasoning_content`
while streaming). Both are excluded, on both transport paths, and there are tests
that put a literal `PRIVATE DELIBERATION` string in each of those three places and
assert it appears nowhere in the result. Without them it would land in your library,
export to Markdown, and mirror to the PDS.

### Cost interaction

Reasoning tokens count as **completion** tokens, so a level above `off` moves a
response closer to its output ceiling — which is why it is logged next to
`truncated` in the usage meter. On Anthropic it is worse than on DeepSeek: the
budget comes out of the same 16 000-token `max_tokens` as the digest itself, so
`high` leaves roughly 8 000 tokens for the article. That is not a bug to fix
quietly — it is the reason the truncation notice exists.

Tagging deliberately pins `reasoning: 'off'` in `suggestTagsBestEffort()` rather
than inheriting the request's level: it is metadata extraction, its prompt is
capped at 6 000 chars to stay cheap, and a call whose shape should be deterministic
should not be left to an API default.

## What the first A/B measured

`npm run digest:ab`, 2026-09-11. Same 11 saved transcripts (407 458 chars), `digest`
format, English, **thinking off**, both providers, no failures and no truncations:

| | claude-cli (sonnet) | deepseek (deepseek-flash) |
|---|---|---|
| mean words | 1 425 | **2 004** |
| compression of source | 24% | 33% |
| numbers kept | 109 | 120 |
| numbers supported | 94 (86%) | **110 (92%)** |
| numbers NOT in transcript | 15 | **10** |
| numeric coverage of source | 58% | **68%** |
| ai-tell mean *(lower better)* | 2.5 | 2.4 |
| mean seconds | 42 | **16** |
| total tokens | 567 637 | **149 654** |

Reading it honestly:

- **DeepSeek was not worse on either axis**, and on both fidelity numbers it was
  better — while being ~2.6x faster and using ~3.8x fewer tokens.
- **The length confound is real and stated, not hidden.** DeepSeek compressed less,
  and coverage rises with length; an arm can win "coverage" by simply saying more.
  Whether ~2 000 words is still a *digest* is a product judgement, not a
  measurement — and it means the same provider sits closer to "Everything" on the
  Gist/Digest/Everything dial than Claude does.
- **ai-tell is a wash** (2.4 vs 2.5, both worst 4), so neither writes more like
  generic AI than the other on this corpus.
- **Nothing truncated**, which confirms where the 16 000-token problem lives: in
  `article` mode and in the Anthropic *API* path, not in `digest` mode.

`article` mode on the two largest transcripts is where both arms showed a limit:

| | claude-cli | deepseek |
|---|---|---|
| 61 779-char transcript | 4 703w, 118s | 5 863w, 45s |
| 71 627-char transcript | 8 946w, **185s** | 6 552w, **TRUNCATED** |

Two real defects, both surfaced by the run and both now fixed:

1. **DeepSeek truncated** because `max_tokens` was omitted and the API's default
   ceiling is far below the model's maximum. Fixed by sending 384 000 (measured
   accepted). The same transcript re-ran at **9 030 words, 27/27 numbers, 96%
   coverage, no truncation.**
2. **The local CLI exceeded its 180 s timeout** on an `article`-mode digest of a
   ~70-minute video, while `digest` mode peaked at 64 s. The default is left alone
   — it is a real hang detector — and `ECHO_DIGEST_TIMEOUT_MS` now exists for
   anyone who wants full rewrites of long transcripts.

The second is also the clearest argument for the truncation notice: without it,
that DeepSeek article would have been saved, exported and mirrored looking complete.

**The `anthropic` provider's arm is deliberately not measured** (decided 2026-09-11).
It exists for hosted web mode and desktop-BYOK, not for the local instance this was
run on, so scoring it would cost a key to produce numbers nobody acts on. Its
*behaviour* is already covered by unit tests driving `ApiKeyProvider` through a mocked
SDK — including `stop_reason: 'max_tokens'` becoming `truncated`.

Which leaves one documented number rather than an open question: **the hardcoded
16 000-token cap on that path.** It is where this whole finding started, it is
unchanged on purpose (raising it would be a behaviour change, not a bug fix), and its
consequence is now predictable rather than mysterious — `article` mode truncates past
roughly 90 minutes of video, and reports that it did. Somebody turning on web mode
later inherits a stated limit, not a bug report.

## What the CLI's Sonnet-vs-Opus 5.5 comparison measured

2026-10-07, `claude` CLI 2.1.292, `npm run digest:ab -- --providers claude-cli
--limit 11 --timeout-ms 600000`. The same 11 saved transcripts (407 458 chars) as
the September run, `digest` format, English, **reasoning off**, one run per arm, run
sequentially. The Sonnet arm ran from a worktree at commit `a5fe6ea`, so no
model-override knob was added to the product to make it possible.

| | claude-cli (sonnet) | claude-cli (claude-opus-5-5) |
|---|---|---|
| mean words | 1 374 | 1 329 |
| compression of source | 22% | 21% |
| numbers kept | 118 | 113 |
| numbers supported | 105 (89%) | **106 (94%)** |
| numbers NOT in transcript | 13 | **7** |
| numeric coverage of source | 65% | 66% |
| ai-tell mean *(lower better)* | **1.4** | 1.5 |
| ai-tell worst | 4 | **2** |
| mean seconds | **33** | 44 |
| slowest digest (s) | **51** | 62 |
| total tokens | **616 098** | 632 674 |
| notional cost | **$2.10** | $4.40 |
| truncated / failed | 0 / 0 | 0 / 0 |

Caveats, stated plainly:

- **One run per arm, 11 digests.** Differences this small are not established.
- **Five of the "not in transcript" numbers are identical in both arms** (`4500`,
  `73%`, `8000`, `1998`, `27`). That points at the scorer missing a figure worded
  differently in the transcript, not at invention. Excluding them it is 8 vs 2.
  **None were checked by hand against the transcripts.**
- **`article` mode and transcripts over ~72k chars were not measured.**
- The cost is the CLI's *notional* list-price figure, not money spent on a subscription.

What it supports: Opus 5.5 is at least as faithful on numbers, a little slower and
about twice the notional cost, with no visible change in length or ai-tell. It is the
CLI default as of commit `567f905`. For `claude-opus-5-5` the CLI reported
`contextWindow: 1000000` and `maxOutputTokens: 128000`; the first is where the
registry's 1 000 000 comes from. Auto-tagging (`suggestTags`) shares the CLI args, so
it runs on Opus too.

Two consequences of that window, and what was done about each:

- **The classic threshold no longer applies to the CLI.** Map-reduce starts at
  2 400 000 chars instead of 480 000, so a transcript in that range is one call.
- **The per-call timeout now scales with input** — on the single call and on each
  map chunk, by that call's own length: base x `ceil(chars / 480 000)`
  (`scaledTimeoutMs()` in `digest.js`), where the base is the
  caller's `timeoutMs` or `ECHO_DIGEST_TIMEOUT_MS` (180 s default). At or under
  480 000 chars it is exactly the base. Only the CLI reads it; the API providers have
  no such timeout. The scaling is **not measured** — it is a proportional allowance,
  not a benchmark. The reduce call is not scaled (its input is the chunk summaries,
  not the transcript). The `anthropic` provider's 360 000-char chunks never exceed
  480 000, so its calls are unchanged.
- The browser's "processing in multiple parts" hint now reads the active provider's
  served `longPathThresholdChars` (falling back to 480 000 until the list arrives).

## Adding a provider

1. Add an entry to `PROVIDERS` with all the facts, including `contextTokens`,
   `maxOutputTokens` and `charsPerToken`.
2. Add aliases to `PROVIDER_ALIASES` if it has a short name people will type.
3. Implement `{ call, stream }`. Map errors onto the existing `echoCode`
   vocabulary (`API_NOT_AUTHED`, `API_RATE_LIMITED`, `API_FAILED`) and keep the
   vendor's own words in `detail` so the error card's disclosure has content.
4. Report `truncated` / `truncationNote` via `truncationFields()`.
5. Add a `reasoning: { dialect }` entry — `null` if the provider has no such
   concept, so it gets no control rather than a dead one — and express it in
   `reasoningFields()`, passing your own provider id explicitly.
6. If it reports no cost, set `costUsd: null` — **not** `undefined`. `mergeUsage()`
   sums with `+=`, so an undefined cost poisons a multi-chunk total into `NaN`.
7. Add it to the tests in `tests/providers.test.js`. There is nothing else to
   register: `/api/providers` and both pickers are built from the registry.

## Testing

`tools/ab-compare.mjs` is the measurement rig for the whole point of the registry:
run the same transcripts through two providers and compare. It calls the fidelity
and ai-tell scorers rather than reimplementing them, fixes format/language/reasoning
for every arm (and prints them, because a comparison with a second variable is not a
comparison), and reports the two fidelity numbers that pull against each other —
*supported* (did it invent?) and *coverage* (did it drop things?) — beside ai-tell.

```bash
npm run digest:ab -- --dry-run     # list the corpus, call nothing
npm run digest:ab -- --limit 4     # both providers, 4 shortest transcripts
```

`tests/providers.test.js` covers the registry, resolution, truncation on both
transport paths, DeepSeek's HTTP surface over a **stubbed global fetch** (no network,
no key), SSE frame reassembly across chunk boundaries, reasoning dialect per
provider, the reasoning-output leak guard, the chunk geometry, truncation surviving
`generateDigest()` on both the single and map-reduce paths, and the HTTP surface of
`/api/providers` plus `PROVIDER_UNKNOWN` and `THINKING_INVALID`. `tests/ab-compare.test.js`
guards the harness's own arithmetic, because the aggregate is what a reader decides on.

The assertions that matter are **mutation-tested**: making DeepSeek inherit
`16_000`, deleting the Anthropic `stop_reason` check, deleting the map-phase
truncation capture, and inferring the reasoning dialect from `opts` each make exactly
the tests that cover them fail. An assertion that cannot fail proves nothing.

## Deliberate non-goals

- **One pinned default model name, and a test that fails when it changes.**
  `deepseek-flash` is hardcoded as the fallback because the API requires a model
  and "unset" is not an option — but it is a name DeepSeek controls, and getting
  it wrong produces a 400 at digest time rather than anything visible at build
  time. `tests/providers.test.js` pins it deliberately: if DeepSeek renames again,
  that test failing loudly is the desired behaviour, and the fix is one line here
  plus a note of the new date. Everything else about the model is configurable.
- **No cost estimate for DeepSeek.** Published rates change; a wrong number in a
  cost display is worse than no number, and cost display was removed from the UI
  anyway. Token counts are reported, `costUsd` stays null.
- **No automatic provider fallback.** If the selected provider fails, the error is
  classified and shown. Silently re-running on a different provider would bill
  someone for a model they did not choose.
- **No `thinking` / `reasoning_effort` left to chance.** DeepSeek's docs show
  `thinking: {type: 'enabled'}` with `reasoning_effort`. Echo sends neither only
  when the level is `off` **and** `ECHO_DEEPSEEK_THINKING_FIELD=omit` is set — the
  default is to send `{type:'disabled'}` explicitly, because a parameter we cannot
  verify is better handled by a documented switch than by a guess in either
  direction. If DeepSeek rejects it, that is one env var, not a rewrite.
