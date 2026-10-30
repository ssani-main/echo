#!/bin/bash
# Step 5's requests through routes.sh, on the real YouTube (and yt-dlp): transcripts with Whisper off, the
# language list, oEmbed metadata. From the repo root: bash seshat/check/transcripts.sh, and in web mode
# (every transcript is forwarded there; the transcript cap is set low to reach its error):
#   ECHO_MODE=web ECHO_MAX_TRANSCRIPT_CHARS=5000 bash seshat/check/transcripts.sh web
# Not sent: a non-string `lang` (refused here on purpose, see PORT.md). Web mode limits an IP to 20 requests
# a minute, so its list is short.
set -u
if [ "${1:-}" = web ]; then
  exec bash seshat/check/routes.sh \
    'POST /api/transcript {"url":"GRzaq5AHiV8"}' \
    'POST /api/transcript {"url":"https://youtu.be/GRzaq5AHiV8","transcribe":"always"}' \
    'POST /api/transcript {"url":"nope"}' \
    '/api/video-meta?videoId=GRzaq5AHiV8'
fi
bash seshat/check/routes.sh \
  'POST /api/transcript {"url":"GRzaq5AHiV8","transcribe":"off"}' \
  'POST /api/transcript {"url":"https://www.youtube.com/watch?v=GRzaq5AHiV8&t=30s","lang":"id","transcribe":"off"}' \
  'POST /api/transcript {"url":"GRzaq5AHiV8","lang":"xx","transcribe":"off"}' \
  'POST /api/transcript {"url":"nope","transcribe":"off"}' \
  'POST /api/transcript {"transcribe":"off"}' \
  '!POST /api/transcript {"url":"GRzaq5AHiV8"}' \
  '/api/languages?videoId=GRzaq5AHiV8' '/api/languages' '/api/languages?videoId=bad' '/api/languages?videoId=GRzaq5AHiV8&videoId=x' \
  '/api/video-meta?videoId=GRzaq5AHiV8' '/api/video-meta?url=https%3A%2F%2Fyoutu.be%2FGRzaq5AHiV8' \
  '/api/video-meta?videoId=aaaaaaaaaa0' '/api/video-meta'
