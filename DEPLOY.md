# Deploying Echo (hosted web mode)

Echo's hosted web mode is **BYOK** (bring-your-own-key) and stateless on the
server: each visitor supplies their own Anthropic API key from the browser
(`X-Echo-Api-Key` header, stored in their own `localStorage`) and their
library lives in their own browser's IndexedDB. The server never sees or
stores an API key, and needs no persistent volume. That means deploying it
needs **no secrets** and **no database provisioning** — just build the
existing `Dockerfile` and run it.

This doc covers **Fly.io** (primary, one command once set up) and a brief
note on **Railway** as an alternative.

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
- **Don't add a Fly volume.** There's no server-side state to persist in
  `ECHO_MODE=web` — the SQLite library routes are disabled (`503`) and the
  browser's IndexedDB is the only place a visitor's library lives.

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
