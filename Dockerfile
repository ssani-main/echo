# Echo — hosted web mode (BYOK) container image.
#
# node:22-bookworm-slim tracks the latest Node 22.x patch release, which is
# well above the >=22.5 floor required by node:sqlite (see package.json
# "engines"). Pin to a specific patch (e.g. node:22.9-bookworm-slim) if you
# need reproducible builds.
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

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY . .

ENV ECHO_MODE=web \
    ECHO_HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
