# Echo — hosted web mode (BYOK) container image.
#
# node:22-bookworm-slim tracks the latest Node 22.x patch release, which is
# well above the >=22.12 floor required by Astro / node:sqlite (see
# package.json "engines"). Pin to a specific patch (e.g.
# node:22.12-bookworm-slim) if you need reproducible builds.

# --- Stage 1: builder ---
# Installs all dependencies (including devDependencies such as astro) and
# produces the static frontend in dist/.  astro is a devDependency, so this
# stage must use a full `npm ci` rather than `--omit=dev`.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

COPY . .
RUN npm run build

# --- Stage 2: runtime ---
# Production image.  Receives only the built dist/ from the builder stage —
# the host filesystem's dist/ is excluded via .dockerignore so the builder
# output is always authoritative.
FROM node:22-bookworm-slim

WORKDIR /app

# yt-dlp is used as a transcript-fetch fallback and by the in-app Discovery
# (YouTube search/browse) feature — it is needed in every mode, web included.
# yt-dlp itself needs a python3 interpreter; python3-pip installs yt-dlp from
# PyPI so we get a current release rather than whatever Debian bookworm ships.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get purge -y --auto-remove python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Install production dependencies first so this layer is cached across source
# changes.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY . .

# Bring in the Astro-built frontend from the builder stage.  This must come
# after `COPY . .` so it is never overwritten by a stale host dist/.
COPY --from=builder /app/dist ./dist

ENV ECHO_MODE=web \
    ECHO_HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
