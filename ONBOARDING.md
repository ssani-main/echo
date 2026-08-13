# Onboarding — investigation and proposed flow

Status: **built** (2026-08-13, branch `feat/atproto-signin`). Findings below come
from walking the real page in a real browser against a real gated instance, not
from reading the code — and the fix is verified the same way, 28/28 across all
five states plus 320/375/414/768 px.

Three things the browser caught that neither review nor the DOM probe could:

- The **first-run onboarding card** was still showing under the gate, saying
  *"paste a link above … no account needed"* — a direct contradiction of an
  invite-only door, pointing at a paste box that had just been removed.
- The **Requests chip showed "Requests 0" to signed-out strangers.** It borrows
  `.library-btn`, which sets `display: flex`, so `hidden = true` did nothing.
  Third appearance of that trap in this codebase.
- The **Bluesky link rendered default-UA blue** — the only chromatic thing on a
  zero-accent-hue screen.

The design system is **not** in scope. Plaintext stays exactly as it is — one
system monospace family, no accent hue, headings at body size, hierarchy from
weight and `--title`. Nothing below asks for a new colour, a new face, or a
larger type size. What changes is *which screen a person sees when*, which is an
information-architecture problem wearing a visual-design costume.

## What a stranger actually sees today

They land on the tunnel URL, signed out, and get **the full marketing hero for a
product they cannot use**, with the dead control as the most prominent thing on
the page:

```
119px   Voice, resolved into text
162px   Read what was actually said.
206px   Paste a YouTube link. Echo pulls the full transcript and distills it…
300px   ┌──────────────────────────────────────────────────────┐
        │ Paste a YouTube link — it loads automatically        │   ← does nothing
        └──────────────────────────────────────────────────────┘
419px   ┌ Sign in to use this Echo.                              ← styled as an ERROR
        │ Open Settings and sign in with your Bluesky handle.
        │ Sign in                                                ← the only live control
595px   Echo · Privacy · Terms
```

### Six findings

1. **The primary control is a trap.** The URL field is the largest, brightest
   element on the page, sits above the sign-in, and is fully enabled. A
   visitor's first instinct is to paste. It fails. The one control that works is
   a small underlined link below it.

2. **Being asked to sign in is not an error.** The gate reuses `buildErrorCard`,
   so a first-time visitor's first impression is a left-ruled error block. It is
   the *normal* first state of a gated instance, and it should look like a
   doorway, not a fault.

3. **"Sign in" leads to a settings panel.** The button opens the Settings modal,
   whose sections are `Account | Request access | Access requests |
   Transcription | Markdown vault`. A person who has never used Echo is dropped
   into Whisper model pickers and Obsidian vault sync. This is the single worst
   moment in the flow.

4. **DEFECT — the page never updates after sign-in.** The gate card is painted by
   an error handler and nothing repaints it when the account state changes.
   Measured: after signing in AND after submitting a request, the page behind
   the modal still read *"Sign in to use this Echo."* A user who closes Settings
   is told to do the thing they just did.

5. **DEFECT — a pending user is told the wrong thing.** Because of (4), someone
   who has signed in and submitted a request still sees *"Sign in to use this
   Echo"* when they try to use it. The server knows they are `pending`; the page
   shows `signed_out`.

6. **Dead chrome stays live.** The Library button (showing "0") is clickable and
   its route 503s. Nothing tells the visitor what Echo is *for* before asking
   them for a credential — the hero copy sells a paste box they cannot use.

## The proposed model: one gate state, one screen

The server already returns exactly the right thing — `status` plus a `reason` of
`signed_out` / `unsubmitted` / `pending` / `rejected`. The client should treat
that as **the page's primary state**, the way `body.pane-library` already works,
rather than as an error that happens to arrive.

```
                 ┌──────────────────────────────────────┐
   arrives  ───► │  1. WELCOME        (signed_out)      │
                 │  what Echo is + sign in with Bluesky │
                 └──────────────┬───────────────────────┘
                                │ signs in
                 ┌──────────────▼───────────────────────┐
                 │  2. REQUEST        (unsubmitted)     │
                 │  why you want it · where you found it│
                 └──────────────┬───────────────────────┘
                                │ submits
                 ┌──────────────▼───────────────────────┐
                 │  3. WAITING        (pending)         │──► 4. DECLINED (rejected)
                 └──────────────┬───────────────────────┘
                                │ admin approves
                 ┌──────────────▼───────────────────────┐
                 │  5. THE APP        (approved)        │
                 └──────────────────────────────────────┘
```

`body.gate-welcome` / `.gate-request` / `.gate-waiting` / `.gate-declined`, set
from `/api/auth/me`, with the app's normal chrome shown only in state 5. One
class drives it, matching the existing `body.pane-library` idiom.

### What each screen is

**1. Welcome.** Replaces the hero's paste box with the sign-in itself. The copy
answers *what is this and why should I hand over a credential* before asking:
Echo turns a YouTube link into a transcript and an AI digest; this instance is
someone's own machine; access is granted by hand. Then two fields — handle and
app password — and one button.

The app-password explanation belongs **here**, at the point of asking, not in a
settings note. It needs a direct link to `https://bsky.app/settings/app-passwords`
(a plain `<a>`; CSP does not govern navigation) and one line on why an app
password rather than a real one: it can be revoked, and it cannot change or
delete the account. That sentence is what converts a suspicious visitor.

**2. Request.** Same place, same visual weight — the form is the page, not a
section inside a modal. Motivation, where they found Echo, optional contact.

**3. Waiting.** Calm and final. No spinner, no "checking…" — there is nothing to
poll. Say what happens next and that they can close the tab.

**4. Declined.** One sentence, plus the admin's note when there is one. No
button, because there is no action.

**5. The app.** Exactly what exists today, untouched.

### Chrome rules while gated

- The URL input, the Library button and the digest controls are **not rendered**
  in states 1–4, rather than rendered-and-broken. An enabled control that cannot
  work is worse than an absent one.
- The Settings gear stays, because theme and reading preferences still apply.
- The Account section in Settings shrinks to *who you are + sign out*. Sign-in
  and registration move out to the gate screens; keeping two copies of a form
  that carries state is the bug that hit `extractSummary` and the reading
  controls, in a third costume.

### Admin

The queue does not belong under Transcription in a settings modal. Give it the
same treatment as the Library: a header chip, visible only to an admin, showing
the pending count, opening a full pane.

- **`Requests · 3`** in the header — the count is the notification. Without it an
  admin has no idea anyone is waiting, which is how an approval queue quietly
  becomes a wall.
- Poll `/api/admin/registrations` on load and after each decision. No push, no
  websocket — a personal instance with a handful of requests does not need one.
- Render handles as text, not avatars: an avatar means a new `img-src` origin,
  and this CSP has named none but YouTube's thumbnails.

## Files this touches

| File | Change |
| --- | --- |
| `src/components/LandingHero.astro` | gate screens 1–4 as siblings of the existing hero |
| `src/components/SettingsModal.astro` | account section shrinks; sign-in + registration move out |
| `src/components/SiteHeader.astro` | admin `Requests · N` chip |
| `src/client/main.js` | `applyGateState()` from `/api/auth/me`; repaint on every change; move the form handlers |
| `src/styles/app.css` | `body.gate-*` rules; `[hidden]` guard per new element, same commit |
| `src/components/LibraryPane.astro` | admin queue pane (moved out of Settings) |

No server change. The API already returns everything this needs.

## Verification this will need

`node --test` cannot see any of it. The existing browser probe
(`probe-phase2-ui.mjs`) already drives the real flow in Edge and should be
extended to assert each of the five states renders the right screen and no
stale one — findings 4 and 5 are exactly what a test like that catches and a
unit suite never will. Plus `npm run test:page` at 320 / 375 / 414 / 768 px:
the gate screens are the first thing a phone visitor sees.
