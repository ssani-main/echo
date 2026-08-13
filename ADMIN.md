# Running an Echo other people use

You are the admin: the person whose machine this runs on, whose Claude quota
pays for the digests, and whose home IP fetches the transcripts. This is the
guide to the day-to-day of that.

Everything below assumes Bluesky sign-in is switched on. With it off — the
default — none of this exists and Echo is the single-user tool it always was.

## Setup, once

Four environment variables. `.env.local` at the repo root is gitignored and is
the right place for them; `scratchpad/start-echo.ps1` reads it and boots.

| Variable | What it does |
| --- | --- |
| `ECHO_ATPROTO_ENABLED=1` | turns sign-in on |
| `ECHO_ATPROTO_SECRET` | seals stored Bluesky refresh tokens. **Changing it signs everyone out of Bluesky** (they just sign in again). Keep it stable. |
| `ECHO_SESSION_SECRET` | signs Echo's session cookies. **Changing it signs everyone out of Echo.** |
| `ECHO_ADMIN_DIDS` | comma-separated DIDs who may approve people. **Yours must be here** |

**Your DID is not your handle.** Find it by signing in and reading
`/api/auth/me`, or from your Bluesky profile. Handles are rented and can change;
the DID never does, which is why the admin list is keyed on it.

If `ECHO_ATPROTO_ENABLED` is on and `ECHO_ADMIN_DIDS` is empty, the server warns
at boot and every account — **including yours** — sits pending forever with
nobody able to approve it. The gate locked from the inside.

Optional budget knobs, per account per hour: `ECHO_USER_DIGEST_LIMIT` (30) and
`ECHO_USER_FETCH_LIMIT` (90).

## The daily loop

**The People chip in the header is the notification.** It shows the number of
people waiting, and hides itself at zero. If there is no badge, there is nothing
to do.

Click it for the People pane. Filter between **Pending / Approved / Declined**.
Each card shows the handle, the DID, where they said they found Echo, their
contact if they left one, what they wrote, whether they hold a live credential,
and when they were last active.

Before approving someone, **open their Bluesky profile.** That is the real
advantage of this identity provider over an email address: you can see an actual
account with actual history. An empty profile created this week is a different
proposition from someone you have seen posting for two years.

Four actions, per person:

- **Approve** — they get in immediately, next page load.
- **Decline / Revoke access** — declining an applicant, or revoking someone
  already approved. Either way they cannot ask again. Revoking an approved
  account **also signs them out on every device automatically**, because a
  stateless session cookie stays valid for up to a month otherwise and the
  revocation would not bite until it expired.
- **Force sign-out** — ends every session for that account without changing
  their access. For a laptop left somewhere, or a credential you want rotated.
  They can sign back in.
- **Note** — optional, and **shown to the person if you decline them**. Write it
  as something they will read.

## What you can and cannot see

**Can:** every account by status, their handle and DID, what they wrote, whether
they have a live credential, and roughly when they were last active (recorded at
most once every fifteen minutes per person — a write on every request would put
SQLite on the hot path of an app that streams long transcripts).

**Cannot: who is on the site right now.** Sessions are stateless signed cookies
with no sessions table — a deliberate design choice that predates all of this.
Nothing on the server knows who has a tab open. "Signed in (has a live
credential)" means their account has a working Bluesky token stored, not that
they are here; someone who signed in three weeks ago and never came back still
shows it.

**Cannot: what anyone digested.** There is no per-user activity log. The local
usage meter (`usage_stats.mjs`) counts actions for the instance as a whole.

## What you are actually giving away

Approving someone hands them three things:

1. **Your Claude quota.** Every digest they run spends it. The per-account limit
   is a backstop against one person running away with it, not a budget.
2. **Your home IP's standing with YouTube.** Every transcript fetch goes out
   from your connection. This is the whole reason the instance works at all —
   YouTube bot-blocks datacenter IPs — and it is the resource with the least
   headroom.
3. **Nothing of your library.** Each account gets its OWN library — a separate database file — so an approved person cannot read, edit or delete anything you saved. That was true only from Phase 4 onward; if you are reading an older copy of this file, it was not.

**So the bar is: people you are willing to spend compute and bandwidth on.** That is a lower bar than it used to be, but it is not zero — a stranger with an approved account can still burn a day of your Claude quota inside their hourly limits.

## Keeping it running

- **Back up the data directory, not one file.** `data/echo-sync.db` is every account and decision; `data/library.db` is your own library; `data/libraries/*.db` is one file per other account.
  `.holesail-seed` is the serving capability for your public URL — lose it and
  the URL changes for everyone. Both are gitignored; neither is in any backup
  you have not made yourself.
- **`npm run serve:public`** is the working way to expose it. Not a VPS:
  YouTube bot-blocks datacenter IPs outright, so transcripts fail there.
- **Rotate your own app password** whenever you have pasted it somewhere you
  would rather it had not been. Revoke it at Bluesky → Settings → App passwords
  and sign in again; nothing else is affected.
- **Watch the digest failures.** The most common cause of "Echo is broken" is
  the Claude CLI losing its authentication, which surfaces as a classified error
  card and not a crash.
- **Before you update Echo**, run `npm test`, and if you touched the frontend,
  `npm run test:page` (`ECHO_CHROME` must point at a Chrome or Edge binary on
  Windows). The unit suite cannot see the browser, and this is the app where
  that has bitten repeatedly.

## Repository mirroring

Off unless BOTH  is set on the instance AND the person turns it
on for their own account. It publishes: their library becomes readable by anyone
with no credentials, under their real handle, and deleting later does not
retract it. Recordings they uploaded themselves are never mirrored at all.

The About & FAQ in the footer explains all of this in their words, not yours.

## Turning it off

Unset `ECHO_ATPROTO_ENABLED` and restart. Sign-in disappears, the gate stops
applying, and Echo is a single-user tool again. **Nothing is deleted** — the
accounts, decisions and stored credentials stay in the database, and switching
it back on restores exactly the state you left. Anyone who was signed in is
simply no longer anywhere they can sign in from.
