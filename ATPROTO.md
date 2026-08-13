# Bluesky accounts, registration and approval

Status: **Phases 1–5 built** (2026-08-13, branch `feat/atproto-signin`).
Sign-in, registration, admin approval and the access gate all work end to end
against a real Bluesky account, and every account has its own library. Phase 5
is the only one left.

**Libraries are now per-account** (Phase 4), so approving someone no longer hands them yours. They still spend your Claude quota and your residential IP.

Goal: let people other than the operator use an Echo instance hosted on a
personal machine — identified by their Bluesky account, admitted one at a time
by an admin, and eventually storing their library in their own PDS rather than
in Echo's SQLite.

This is a *third* auth path. The Google/OIDC path in `auth.js` + `syncStore.js`
stays exactly as it is, dormant behind its three env vars.

## Decisions, and why

**App passwords, not OAuth.** The atproto OAuth profile requires a `client_id`
that is a public `https://` URL with no port, serving a client-metadata
document, plus PAR, DPoP with server-issued nonce rotation, and PKCE. The
official `@atproto/oauth-client-node` package handles all of that, so the work
is tractable — but `client_id` becomes part of every issued session. Echo's
public origin is a Holesail/Janus URL today and is intended to move to Project
Cardea (P2P, iroh) later. **An origin change invalidates every OAuth session and
refresh token.** App passwords have no origin binding, so they survive the move.

Accepted costs: app passwords are officially deprecated for new projects, and
they grant broad account access (posting, deleting, following — not account
management, and not DMs unless the user opts in). Acceptable here because access
is allowlisted, not open registration. Revisit if Echo ever admits strangers.

**Browser → Echo → PDS**, not browser → PDS directly. The alternative keeps the
password off Echo's machine entirely, but needs each user's PDS host in
`connect-src`, which does not generalise past `bsky.social`. Transport is
already TLS (Janus terminates it; Holesail is E2E encrypted), so the simpler
path costs nothing. **Revisit if Echo is ever served over plain `http://`.**

**Never persist the password.** Exchange it once via
`com.atproto.server.createSession`, keep the `refreshJwt` encrypted at rest,
refresh via `com.atproto.server.refreshSession`, discard the password
immediately. Phase 5 needs durable credentials; it does not need passwords.

**DID is the join key**, never the handle — handles are rented and change.
Store the handle for display only, and re-resolve it on each sign-in.

**Echo's own session is the existing `auth.js` machinery**, unchanged: signed
cookie, `SESSION_COOKIE`, `verifyToken`, `tokenVersion` for sign-out-everywhere.
The atproto tokens live server-side only. The browser never sees them.

## Constraints measured from the spec

- `createSession`: **30 per 5 min, 300 per day, per account.** Irrelevant to
  login, listed so nobody re-derives it.
- **3,000 requests per 5 min per IP** against a PDS. Matters in Phase 5: one box
  writing to many PDSes shares one address. Bulk sync must be paced.
- Records should stay under **a few dozen KB**; larger payloads belong in blobs
  (PDS blob upload limit is 50 MB). Echo entries average ~45 KB and are almost
  entirely transcript, so **the transcript is a blob and the record holds
  metadata + digest + tags + a blob ref.** Not optional.

## Phases

Phases 1–4 are built. Phase 5 is independent and belongs on its own branch.

### Phase 1 — sign in with Bluesky (`atproto.js`) — BUILT

Config-gated on `ECHO_ATPROTO_ENABLED=1` + `ECHO_ATPROTO_SECRET` +
`ECHO_SESSION_SECRET`. **Unset means no sign-in and no behaviour change** —
verified: `/api/auth/me` returns `{enabled:false}`, `POST /api/auth/atproto`
503s with a hint naming the three vars, and no database file is created.

- `POST /api/auth/atproto` — handle + app password → resolve → `createSession`
  → sealed refresh token → Echo's existing signed cookie. Rate-limited in
  **every** mode via `alwaysLimit`, not `webLimit`: a local instance published
  over a tunnel is reachable by anyone, and what is being guessed is someone
  else's app password.
- `GET /api/auth/me` gained an additive `providers` object; `enabled` and
  `user.email` still mean what they always did.
- Sign-out and sign-out-everywhere drop the stored credential.
- **A real Bluesky password is refused before anything is sent anywhere**
  (`APP_PASSWORD_RE`). Handing a stranger's server a real password gives away
  the whole account, including the ability to lock the owner out.
- `serviceEndpoint` from a DID document is scheme-checked, never host-checked —
  attacker-controlled input, and the `javascript:`-has-no-host trap applies.
- Not hardcoded to `bsky.social`: the PDS comes from the DID document, so
  self-hosted accounts work.

**Not built:** any UI. The sign-in form is deliberately deferred to Phase 2, so
it can be built once alongside the registration and pending screens rather than
twice.

### Phase 2 — registration and admin approval — BUILT

Authentication and authorisation are separate. Signing in always succeeds; Echo
then looks up the DID's **status**: `pending` → `approved` / `rejected`.

`users` gains: `did TEXT UNIQUE`, `handle`, `provider`, `status`, `motivation`,
`referral_source`, `contact`, `requested_at`, `decided_at`, `decided_by`,
`admin_note`. `google_sub` becomes nullable behind `provider` so the Google path
keeps working.

- **First sign-in lands on a registration form, not the app**: why they want
  access, where they found Echo, optional contact. Editable while pending.
- **Pending is a real screen.** Gated routes return 403 carrying the status so
  the client renders the right thing rather than a generic error.
- **Admin** = a DID listed in `ECHO_ADMIN_DIDS`. `/admin` lists pending requests
  with approve / reject / note. Requests show the applicant's real Bluesky
  handle and profile — far better signal than an anonymous email.
- Rejections persist, so a rejected DID cannot re-apply in a loop. A pending
  request CAN be re-submitted, so a thin first answer can be improved.
- **`ECHO_ADMIN_DIDS` is an env var, not a database flag.** Becoming an admin
  requires access to the machine; no sequence of requests can promote anyone.
- **Admins auto-approve at sign-in.** Otherwise the first sign-in on a fresh
  instance leaves the operator pending with nobody able to approve them — the
  gate locked from the inside.
- **The admin routes 404 rather than 403** for a signed-in non-admin. A 403
  confirms the route exists; the admin already knows where it is.
- **Accounts are no longer web-mode-only in the client.** `renderAccountState()`
  and `EchoSync.refresh()` returned early unless `ECHO.mode === 'web'`, so a
  locally-hosted instance rendered no account UI at all — the exact deployment
  this feature exists for. Sync itself stays web-only, guarded inside
  `syncNow()` rather than at each call site.
- **Accounts that predate the gate are grandfathered to `approved`.** New rows
  default to `pending`; applying that to existing rows would lock out people who
  were using the instance before there was a gate.
- The queue is **paged from the start** — an open instance collects pending rows
  faster than anything else here, because signing up costs a stranger nothing.

### Phase 3 — gating and quota guard — BUILT

`requireApproved` on all 16 AI, fetch, Whisper and library routes.

- **It no-ops entirely when no provider is configured.** That is the hard
  constraint, not a convenience: a plain local install must behave exactly as it
  always has. The 549-test suite runs with accounts off and is the proof.
- **Anonymous visitors are blocked too**, not just signed-in non-approved ones.
  An instance published over a tunnel is reachable by anyone, and "signed out"
  is the state every stranger arrives in.
- The refusal carries a machine-readable `reason` — `signed_out`,
  `unsubmitted`, `pending`, `rejected` — so the client can offer a way forward
  where one exists and stay quiet where none does. Four situations that would
  otherwise collapse into one generic error.
- `/api/auth/*` and `/api/health` are never gated, or there would be no way
  back in.
- **Per-ACCOUNT quotas**, not per-IP: `webLimit` keys on address, which is right
  for a hosted deployment and wrong here, because the Claude quota and the
  residential IP's standing with YouTube are spent per person. Two users behind
  one NAT should not share a budget; one user on two devices should not get two.
- **One limiter instance per budget, shared across routes.** Calling
  `userLimit()` at each route gives each its own store, so "90 fetches an hour"
  silently becomes three separate 90s. YouTube does not care which endpoint
  spent the IP. Knobs: `ECHO_USER_DIGEST_LIMIT` (30/h), `ECHO_USER_FETCH_LIMIT`
  (90/h).

**The gate and the isolation are both complete.** What an approved account can still spend is the operator's Claude quota and their residential IP — bounded by the per-account limits, not by isolation.

### Phase 4 — per-account libraries — BUILT

**One database FILE per owner, not an `ownerId` column.** The column approach
was the plan, and it is the wrong one here: it needs a WHERE on every query, a
composite primary key, a rebuilt tags foreign key and an FTS reindex — and then
it is correct only for as long as nobody forgets the WHERE. This repo has SEVEN
recorded bugs of the shape "fine because the fixture was small". A filter that
must be remembered at thirty call sites is that shape again with a worse failure
mode: not a slow page, but one person reading another's library.

Separate files make the isolation **structural**. A query cannot reach across an
owner boundary because there is nothing to reach across — the other library is a
file this connection never opened. It also made the change far smaller: no
schema migration, no FTS rebuild, and `store.js`'s queries are untouched.

- `forOwner(id)` returns the library API bound to one owner. The bare exports
  stay, bound to `DEFAULT_OWNER` — which is what an install without accounts
  has, at the ORIGINAL path — so single-user local mode is unchanged and every
  existing caller and test still works.
- The owner id becomes a filename, so it is validated as one. A path separator
  or a `..` would be a traversal out of the data directory.
- **`adoptDefaultLibrary()`** hands the pre-accounts library to the first admin
  who signs in, by renaming the file. Without it, turning accounts on looks
  exactly like data loss: the operator signs in, gets a new empty library, and
  everything they saved sits in the default file with nothing left to show it.
- "Owner already has a library" means **has entries**, not "has a file". Reading
  an empty library creates its file, so an existence check would refuse to adopt
  for anyone who had merely loaded the page — which is everyone who just signed
  in. Found by the test, not by review.
- Costs, honestly: no cross-owner query is possible (nothing wants one), and one
  handle is held per active owner (`closeAllLibraries()` releases them).

### Phase 5 — libraries in the user's PDS

Records at `dev.ssani.echo.entry` via `putRecord`; transcript as a blob via
`uploadBlob`. `store.js` stays the local cache that keeps FTS5 search fast; the
PDS becomes the portable source of truth. Reconcile with the existing
last-write-wins-by-`updatedAt` + tombstone semantics in `syncStore.js`.

## Traps specific to this work

- **`tauri.conf.json`.** `atproto.js` must be added to `bundle.resources` or the
  desktop sidecar throws `ERR_MODULE_NOT_FOUND`. `tests/tauri-bundle.test.js`
  guards it — but only for import dialects its regex knows.
- **Lockfile.** Any new dependency must be locked with npm 10
  (`npx --yes npm@10.9.0 install --package-lock-only --ignore-scripts`) and
  verified under both majors, or CI and the Docker builder stage break.
- **`node --test` cannot see any of this.** Sign-in needs an E2E harness against
  a mock PDS, in the spirit of `tests/e2e/oauth-flow.mjs`.
- **New hideable elements need their `[hidden]` guard in the same commit** — the
  registration form, the pending screen and the admin panel are all
  conditionally shown, which is exactly the shape that has silently failed here
  before.
- **Admin list avatars would be the first non-YouTube `img-src` origin.** Render
  handles as text unless there is a reason not to.

## Open questions

- Under Project Cardea, does the P2P origin count as a **secure context**? If
  not, the vault folder picker (File System Access API) disappears for remote
  users, as it does on any plain-`http://` origin.
- Does approval need to notify the applicant, or is a pending screen they
  re-visit enough? Notification would mean posting or DMing from a Bluesky
  account, which needs write scope Echo does not otherwise use.
- Phase 5 makes the PDS the source of truth while Phase 4 makes `store.js`
  per-user. Confirm the cache-vs-truth direction before building either.
