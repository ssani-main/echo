# Deploying Echo (hosted web mode)

Echo's hosted web mode is **BYOK** (bring-your-own-key) and stateless on the
server: each visitor supplies their own Anthropic API key from the browser
(`X-Echo-Api-Key` header, stored in their own `localStorage`) and their
library lives in their own browser's IndexedDB. The server never sees or
stores an API key, and needs no persistent volume. That means deploying it
needs **no secrets** and **no database provisioning** — just build the
existing `Dockerfile` and run it.

Optionally, accounts can be switched on so a library follows someone between
devices; that adds one small SQLite file and a Google OAuth client, and nothing
else. It is off unless configured — see "No volume, no database" below. The
server never stores an API key either way.

This doc covers **Fly.io** (primary, one command once set up) and a brief
note on **Railway** as an alternative. To run it on a box you own instead,
see [`VPS.md`](VPS.md) — same `Dockerfile`, with Docker Compose and Caddy
standing in for Fly's remote build and automatic TLS.

## Primary: Fly.io

### Prerequisites

- A [Fly.io](https://fly.io) account.
- [`flyctl`](https://fly.io/docs/flyctl/install/) installed locally.

### Steps

```bash
# 1. Log in (opens a browser)
fly auth login

# 2. Create the Fly app from the committed fly.toml without deploying yet.
#    --copy-config reuses this repo's fly.toml as-is (rename `app` inside it
#    first if "echo-web" is already taken, or let this step prompt you).
fly launch --copy-config --no-deploy

# 3. Deploy
fly deploy
```

That's it — **no `fly secrets set` step**. There is no server-side API key
to configure; visitors bring their own via the app's Settings panel after it
loads.

### Verify it's live

```bash
fly status
curl https://<your-app-name>.fly.dev/api/health
# → {"status":"ok","mode":"web"}
```

Open `https://<your-app-name>.fly.dev` in a browser — you should see the
first-run onboarding card prompting for an Anthropic API key.

### Custom domain + TLS

```bash
fly certs add yourdomain.com
```

Then add the DNS records Fly prints (typically an `A`/`AAAA` pair, or a
`CNAME` if you're pointing a subdomain) at your DNS provider. Fly
provisions and renews the TLS certificate automatically once DNS
propagates — no separate certbot/ACME setup needed.

### Scaling note (read this before changing machine count)

`fly.toml` pins this app to a **single machine** (`[[vm]]`, no `count`
override, `min_machines_running = 0`). This is intentional: the per-IP rate
limiter that guards the AI and transcript routes in `ECHO_MODE=web` keeps
its counters in that one process's memory. It is **not** shared across
machines or regions.

If you scale out to multiple machines (e.g. `fly scale count 2`, or
deploying to multiple regions), each machine enforces the rate limit
independently — a visitor effectively gets `N ×` the intended request
budget, split across whichever machine Fly's proxy routes them to on each
request. If you need real horizontal scaling later, move the limiter to a
shared store (e.g. Redis) first; until then, keep this at one machine.

### Cost note

`min_machines_running = 0` means the machine stops when idle and cold-starts
on the next incoming request (cheapest option — you're not billed while
nobody's using it, at the cost of a few seconds' latency on the first
request after idle). Set `min_machines_running = 1` in `fly.toml` if you'd
rather pay for an always-warm machine and avoid that cold start.

### No volume, no database — unless you turn on accounts

By default web mode keeps nothing on the server: the library lives in each
visitor's IndexedDB, the server-side library routes (`/api/saved*`,
`/api/search`, `/api/vault/sync`) return 503, and API keys arrive per-request
and are never written down. So `fly.toml` has no `[mounts]` block and needs
none — don't add a volume or set `ECHO_DB_PATH`.

**Accounts + library sync** is the one feature that changes this, and it is
opt-in. Set all three of `ECHO_GOOGLE_CLIENT_ID`, `ECHO_GOOGLE_CLIENT_SECRET`
and `ECHO_SESSION_SECRET` and Echo will offer "Sign in with Google" so a
library follows someone between devices. That needs somewhere to keep it:

```bash
# 1. An OAuth client at https://console.cloud.google.com/apis/credentials
#    (Web application). Authorised redirect URI:
#       https://<your-app>.fly.dev/api/auth/callback

# 2. A volume for the one SQLite file
fly volumes create echo_data --size 1

# 3. In fly.toml, add:
#    [mounts]
#      source = "echo_data"
#      destination = "/data"
#    and under [env]:
#      ECHO_PUBLIC_URL = "https://<your-app>.fly.dev"
#      ECHO_SYNC_DB_PATH = "/data/echo-sync.db"

# 4. The secrets
fly secrets set ECHO_GOOGLE_CLIENT_ID=... ECHO_GOOGLE_CLIENT_SECRET=... \
  ECHO_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
```

What that database holds is deliberately small: one row per account mapping
Google's `sub` to an id, and one row per saved video. **No passwords** (Google
is the only provider), **no sessions table** (sessions are signed cookies), and
**no API keys** — signing in does not change where an Anthropic key lives. It
stays in the browser and rides per-request in `X-Echo-Api-Key`, so the promise
above survives accounts intact.

Leave the three vars unset and none of this exists: no sign-in UI, no database
file, no volume.

(An earlier build offered server-persisted public digest shares behind
`ECHO_SHARES`, which is what the volume was for. That feature was removed in
the 2026-07-23 lean cut; the env var no longer does anything. Web sharing is
Phase-2 work — see `CLAUDE.md`.)

## Alternative: Railway

Railway can deploy the same `Dockerfile` directly — it auto-detects
`Dockerfile` in the repo root, so no separate Railway-specific config file
is needed. In the Railway dashboard (or `railway.toml` if you prefer
config-as-code):

- Set the `ECHO_MODE` environment variable to `web`.
- Leave `PORT` unset — Railway injects its own `PORT` at runtime, and
  `server.js` already reads `process.env.PORT`.
- No volume, no secrets required (same BYOK reasoning as above).

See [railway.app](https://railway.app) for account setup and the deploy
flow. Fly.io is the primary, documented path above; this section is
intentionally brief.

## What NOT to do

- **Don't commit a real `.env`.** Only `.env.example` is tracked in this
  repo (see `.gitignore`) — it documents every variable but ships with no
  real values.
- **Don't set `ANTHROPIC_API_KEY` on the server.** This is a BYOK
  deployment — visitors bring their own key from the browser. Setting a
  server-side key isn't needed and isn't the intended usage model for
  hosted web mode.
- **Don't add a Fly volume — unless you enabled accounts.** The default
  `ECHO_MODE=web` deployment is stateless: library routes are disabled (`503`)
  and each visitor's library lives in their own browser's IndexedDB, so a volume
  and `ECHO_DB_PATH` buy you nothing. The exception is library sync, which needs
  one volume for `ECHO_SYNC_DB_PATH` — see "No volume, no database" above.

## Node version

The `Dockerfile` already pins `node:22-bookworm-slim`, which satisfies the
`>= 22.5` requirement (`node:sqlite`, per `package.json`'s `engines` field)
that the rest of the app depends on. No action needed here for either Fly
or Railway.

## A note on verification

Docker is not available in the environment this config was authored in, so
the image itself could not be test-built. `fly.toml` was written to be
statically consistent with the existing `Dockerfile`:

| | `Dockerfile` | `fly.toml` |
|---|---|---|
| Internal port | `EXPOSE 8080`, `PORT=8080` | `internal_port = 8080` |
| Health check path | `HEALTHCHECK` → `/api/health` | `[[http_service.checks]]` → `path = "/api/health"` |
| Mode | `ECHO_MODE=web` | `[env] ECHO_MODE = "web"` |
| Bind address | `ECHO_HOST=0.0.0.0` | `[env] ECHO_HOST = "0.0.0.0"` |

Run `fly deploy` (or a local `docker build .` if Docker is available to
you) before relying on this in production, and watch `fly logs` on first
deploy in case anything in the runtime environment differs from what's
documented here.
