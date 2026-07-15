# Self-hosting Echo on a VPS

This guide is for deploying Echo to your own Ubuntu/Debian server running
Docker and Caddy. If you prefer a managed platform with automatic TLS and zero
ops, see [`DEPLOY.md`](DEPLOY.md) for the Fly.io path (one command after
account setup).

A VPS trades convenience for control: you own the box, you manage updates and
restarts, and you provision your own TLS. Concretely, it replaces Fly's two
conveniences — the remote image build and the automatic certificate — with
Docker and Caddy. Everything else about the app is identical, because both
paths build the same `Dockerfile`.

## Pick your mode first

**You must use `ECHO_MODE=web` on a public VPS.** This is non-negotiable.

The temptation is to run `ECHO_MODE=local` (keyless `claude` CLI + real
server-side SQLite library) because it feels simpler — no per-request API key
hassle, full library in one place. **Do not do this.** Local mode has zero rate
limiting, zero authentication, and leaves all library routes open. Anyone who
finds your VPS URL can read your complete library, access your saved videos,
and exhaust your Claude subscription by hammering the digest endpoint.

**Web mode** (`ECHO_MODE=web`) is what you want: each visitor supplies their
own Anthropic API key from the browser (sent per-request as `X-Echo-Api-Key`,
stored in their `localStorage`), their library lives in their browser's
IndexedDB, and the server never sees an API key. The server has per-IP rate
limits and payload caps that guard the AI and transcript endpoints. This is
BYOK (bring-your-own-key) — no secrets to secure on the server, no persistent
volume needed unless you enable optional public digest shares.

**The one exception:** a *private* local-on-VPS setup where you bind
`127.0.0.1`, reach it over SSH tunnel or Tailscale, and never expose ports
80/443. That's legitimate but requires a custom image (the Dockerfile installs
neither the `claude` CLI nor its auth toolchain), so it's out of scope for this
guide. Stick with web mode.

## Prerequisites

- A VPS (any cloud provider: Hetzner, DigitalOcean, Vultr, AWS Lightsail, etc.)
  running **Ubuntu 22.04 LTS or later** or **Debian 12+**.
- **Docker Engine** and the **Compose plugin** installed (see
  [docker.com/docs](https://docs.docker.com/engine/install/)).
- **Caddy** installed and running as a systemd service (see
  [caddyserver.com](https://caddyserver.com/docs/install)).
- A **domain name** with an **A record** pointing at your VPS's public IP
  address.

## The compose file

Create a file named `compose.yaml` in the repo root (where you cloned Echo):

```yaml
services:
  echo:
    build: .
    container_name: echo
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      ECHO_MODE: web
      ECHO_HOST: 0.0.0.0
      PORT: 8080
      ECHO_SHARES: "1"
      ECHO_DB_PATH: /data/library.db
    volumes:
      - echo_data:/data

volumes:
  echo_data:
```

A few details matter here:

**`ECHO_HOST=0.0.0.0` is not exposure.** It makes the server bind all
interfaces *inside the container*, which is required — the default
`127.0.0.1` would make it unreachable even from Docker's own network. What
actually controls public access is the `127.0.0.1:8080:8080` publish spec:
the host-side `127.0.0.1` prefix binds the published port to loopback only,
so the sole route in is Caddy on the host. Writing `8080:8080` instead drops
that prefix, publishes Echo on every interface, and lets anyone reach it over
plain HTTP while bypassing your TLS entirely.

**`echo_data` volume:** This is the VPS equivalent of Fly's
`[mounts]` block (see `fly.toml`). It persists share data across restarts and
container rebuilds. Drop both the volume and the `ECHO_SHARES` env var if you
want to run fully stateless (shares won't survive a restart).

**`ECHO_SHARES=1` and `ECHO_DB_PATH`:** Optional; enable public digest shares.
If you don't want this feature, omit them and drop the `volumes` block. See
[`DEPLOY.md`](DEPLOY.md#optional-enable-public-digest-shares) for the
full share configuration (same environment variables work here).

## Deploy

```bash
# 1. Clone the repo (if you haven't already)
git clone https://github.com/yourusername/echo.git && cd echo

# 2. Build and start the container
docker compose up -d --build

# 3. Watch the startup logs (Ctrl-C detaches; the container keeps running)
docker compose logs -f echo

# 4. Verify the container is running
docker compose ps

# 5. Health check (should return {"status":"ok","mode":"web"})
curl -s http://127.0.0.1:8080/api/health
```

The `-d` flag runs in the background; `-f` on `logs` streams in real-time.
Leave the logs running for the first deploy so you can spot any errors at
startup.

## TLS with Caddy

Caddy handles HTTPS provisioning and renewal automatically — once your A record
propagates, it uses the ACME protocol to fetch a Let's Encrypt certificate and
keeps it renewed. No certbot, no manual key rotation.

Edit `/etc/caddy/Caddyfile` and add a new block (or replace the existing one):

```
echo.yourdomain.com {
	reverse_proxy 127.0.0.1:8080
}
```

Replace `echo.yourdomain.com` with your actual domain or subdomain.

Then reload Caddy:

```bash
sudo systemctl reload caddy
```

Verify the reverse proxy is working:

```bash
curl https://echo.yourdomain.com/api/health
# → {"status":"ok","mode":"web"}
```

Caddy attempts to issue the certificate when it loads the config, not on the
first visitor request — so if the A record hasn't propagated yet, issuance
fails at reload and `curl` errors on TLS. Caddy retries on its own, but the
authoritative answer is in `sudo journalctl -u caddy -f`, which names the
actual ACME failure (unresolved DNS, port 80 unreachable, rate limit). Check
there rather than guessing from the `curl` output.

**Firewall:** Make sure ports **80** and **443** are open in your VPS's firewall
(`ufw allow 80/tcp && ufw allow 443/tcp` on Ubuntu, or the equivalent in your
cloud provider's console). Port 80 is needed for the ACME HTTP-01 challenge and
for the redirect from HTTP → HTTPS.

## Redeploying

When you pull new code from the repo:

```bash
git pull && docker compose up -d --build
```

Docker Compose rebuilds the image, stops the old container, and starts the new
one. This is **not** zero-downtime: there's a gap of a few seconds between stop
and start where Caddy has nothing to proxy to and returns `502`. That's fine
for a personal deployment — just don't redeploy mid-digest. Scaling to a second
container to cover the gap would break the rate limiter (see below).

You can wrap this in a shell alias or a tiny script to save typing:

```bash
# Example: add to ~/.bashrc or ~/.zshrc
alias echo-update='cd /path/to/echo && git pull && docker compose up -d --build'
```

## Scaling note

The per-IP rate limiter in `ECHO_MODE=web` keeps its counters in one process's
memory. It is **not** shared across containers.

If you scale this to multiple containers (e.g., `docker compose up -d --scale
echo=2`), each container enforces the rate limit independently — a visitor
effectively gets `N ×` the intended request budget, whichever container Caddy
routes them to. Keep this at one container (`docker compose up -d`, no scale
flag) until the limiter moves to a shared store (e.g., Redis). See
[`DEPLOY.md`](DEPLOY.md#scaling-note-read-this-before-changing-machine-count)
for the same reasoning applied to Fly.

## YouTube blocks datacenter IPs

This is the most likely reason a deployment that builds and health-checks
cleanly still fails to do its actual job.

Transcript fetch happens **server-side** — `transcript.js` tries the npm
`youtube-transcript` package first and falls back to shelling `yt-dlp`, and
both reach YouTube from the server's IP, not the visitor's. Datacenter and
cloud IP ranges are increasingly met with **"Sign in to confirm you're not a
bot"** instead of a transcript. This is not specific to VPS hosting; Fly is
subject to the same thing.

Echo ships no workaround for this, and this guide won't pretend otherwise. A
VPS does leave you better positioned than a managed platform — one long-lived
box is somewhere you *can* attach a proxy or supply `yt-dlp` cookies, whereas
an ephemeral Fly machine largely isn't — but wiring either into Echo is work
that doesn't exist yet.

So treat it as the acceptance test rather than an afterthought: **before
calling the deployment done, open the site and digest a real video.** Use the
repo's test video, `youtube.com/watch?v=GRzaq5AHiV8`. A green `/api/health`
only proves the process is up; it says nothing about whether YouTube will talk
to your server.

## What NOT to do

- **Don't set `ANTHROPIC_API_KEY` on the server.** This is a BYOK deployment
  — visitors bring their own key from the browser Settings. Setting a
  server-side key isn't needed and defeats the whole model.
- **Don't run `ECHO_MODE=local` on a public box.** It has no rate limiting and
  leaves your API key and library exposed. If you want local mode, bind to
  `127.0.0.1` and access via tunnel/Tailscale — that's legitimate but requires
  a custom image.
- **Don't publish the container port directly** (e.g., `8080:8080` in the
  compose file without `127.0.0.1:`). This exposes Echo over unencrypted HTTP
  and bypasses Caddy's TLS. Always use the `127.0.0.1:8080:8080` form.
- **Don't commit a real `.env` file.** Only `.env.example` is tracked in this
  repo (see `.gitignore`) — it documents every variable but ships with no real
  values. Configure this deployment through the compose file's `environment:`
  block instead.
- **Don't expect "Include visuals" / frame-augmented digests to work.** The
  Dockerfile doesn't install ffmpeg, which frames need. Even if you add it, the
  feature is local/desktop-only and is not intended for web mode anyway.

## A note on verification

Docker was not available in the environment this config was authored in, so
the image itself could not be test-built or deployed to a real VPS. The
`compose.yaml` and Caddy config above were written by static inspection of the
existing `Dockerfile` and `fly.toml`:

| | `Dockerfile` | `compose.yaml` |
|---|---|---|
| Image | `FROM node:22-bookworm-slim` | (same, built from `Dockerfile`) |
| Internal port | `EXPOSE 8080`, `PORT=8080` | `ports: 127.0.0.1:8080:8080` |
| Health check path | `HEALTHCHECK` → `/api/health` | (used in curl verify) |
| Mode | `ECHO_MODE=web` | `environment: ECHO_MODE: web` |
| Bind address | `ECHO_HOST=0.0.0.0` | `environment: ECHO_HOST: 0.0.0.0` |

Before relying on this in production, run a real `docker compose up -d --build`
and watch `docker compose logs -f echo` on the first deploy, then digest a real
video per the YouTube section above.
