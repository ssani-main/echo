#!/bin/bash
# Step 6's requests through routes.sh, with the real whisper-cli (vendored), the real models (Settings'
# download cache) and ffmpeg on PATH: the status, a model's download state, a spoken WAV made by Windows'
# speech synthesis transcribed from an upload, the progress stream of that job (asked for once it has ended,
# so it sends its last event and closes), the upload's refusals, and a YouTube transcript with Whisper always
# on (on this IP yt-dlp is bot-blocked, so that is Whisper's failure). From the repo root:
#   bash seshat/check/whisper.sh
set -u
T=$(mktemp -d)
W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$s.SetOutputToWaveFile('$W/hello.wav'); \$s.Speak('Hello. This is a test of local transcription in Echo. The quick brown fox jumps over the lazy dog.'); \$s.Dispose()" || exit 1
head -c 4000 /dev/urandom > "$T/corrupt.mp3"
bash seshat/check/routes.sh \
  /api/whisper/status \
  'POST /api/whisper/model {"model":"base"}' 'POST /api/whisper/model {"model":"nope"}' 'POST /api/whisper/model {}' \
  /api/transcript/progress \
  "POST:audio/wav /api/transcript/file?name=hello.wav&jobId=j1 @$W/hello.wav" \
  '/api/transcript/progress?jobId=j1' \
  "POST:audio/wav /api/transcript/file?name=Lecture%20one.WAV&whisperModel=small @$W/hello.wav" \
  "POST:audio/wav /api/transcript/file?name=notes.txt @$W/hello.wav" \
  "POST:audio/mpeg /api/transcript/file?name=broken.mp3 @$W/corrupt.mp3" \
  'POST /api/transcript {"url":"GRzaq5AHiV8","transcribe":"always","jobId":"j2"}' \
  '/api/transcript/progress?jobId=j2'
