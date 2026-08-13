# Bluesky accounts, registration and approval

Status: **Phases 1–2 built** (2026-08-13, branch `feat/atproto-signin`).
Sign-in, registration and admin approval all work end to end against a real
Bluesky account. Phases 3–5 planned.

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

Phases 1–3 are a complete, shippable system. Stop and run it there. 4 and 5 are
each large and independent, and belong on their own branches.

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

### Phase 3 — gating and quota guard

`requireApproved` middleware beside the existing `blockInWeb`, on
`/api/digest`, `/api/transcript` and the library routes. Plus **per-user rate
limits**: the operator's Claude quota and residential IP are both shared
resources, and approval is the gate while the limiter is the blast radius.

### Phase 4 — tenant-ise `store.js`

`userId` on `videos` and `tags`, filtered in every query, migrated behind a
`PRAGMA user_version` bump (the FTS-rowid gotcha applies directly). Touches the
repo's highest-risk file plus the export, the vault sync and the Obsidian
plugin. Do not combine with any other phase.

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
