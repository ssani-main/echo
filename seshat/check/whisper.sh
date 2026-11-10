#!/bin/bash
# Step 6's requests through routes.sh, in two runs. From the repo root: bash seshat/check/whisper.sh
# 1. The real whisper-cli (vendored), the real models (Settings' download cache) and ffmpeg on PATH: the
#    status, a model's download state, a spoken WAV made by Windows' speech synthesis transcribed from an
#    upload, the progress stream of that job (asked for once it has ended, so it sends its last event and
#    closes), and the upload's refusals.
# 2. YouTube transcripts with Whisper always on, against stand-ins: fake-tool.ts built here as yt-dlp and
#    whisper-cli (ECHO_YTDLP, ECHO_WHISPER) and an empty model file (ECHO_WHISPER_MODEL). A success, a
#    download refused every time (503 AUDIO_DOWNLOAD_REFUSED after the retries) and one refused once, then
#    retried; each with its progress stream. The ids are made up, so YouTube's oEmbed has no title for any
#    of them on either side, whatever the network does.
# Not checked here: a real YouTube audio download and transcription through the service (slow, and YouTube
# answered the two sides differently).
set -u
S="${SESHAT:-$(cd ../Seshat && pwd)/target/release/seshat.exe}"
T=$(mktemp -d)
W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT TERM # or a Ctrl-C in the first run (which routes.sh exits from with 130) starts the second
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$s.SetOutputToWaveFile('$W/hello.wav'); \$s.Speak('Hello. This is a test of local transcription in Echo. The quick brown fox jumps over the lazy dog.'); \$s.Dispose()" || exit 1
head -c 4000 /dev/urandom > "$T/corrupt.mp3"
mkdir -p "$T/tools"
(cd seshat/check && "$S" build fake-tool.ts -o "$W/tools/whisper-cli.exe") || exit 1
cp "$T/tools/whisper-cli.exe" "$T/tools/yt-dlp.exe"; : > "$T/tools/m-ok.bin"
fail=0
bash seshat/check/routes.sh \
  /api/whisper/status \
  'POST /api/whisper/model {"model":"base"}' 'POST /api/whisper/model {"model":"nope"}' 'POST /api/whisper/model {}' \
  /api/transcript/progress \
  "POST:audio/wav /api/transcript/file?name=hello.wav&jobId=j1 @$W/hello.wav" \
  '/api/transcript/progress?jobId=j1' \
  "POST:audio/wav /api/transcript/file?name=Lecture%20one.WAV&whisperModel=small @$W/hello.wav" \
  "POST:audio/wav /api/transcript/file?name=notes.txt @$W/hello.wav" \
  "POST:audio/mpeg /api/transcript/file?name=broken.mp3 @$W/corrupt.mp3" || fail=1
ECHO_YTDLP=$W/tools/yt-dlp.exe ECHO_WHISPER=$W/tools/whisper-cli.exe ECHO_WHISPER_MODEL=$W/tools/m-ok.bin bash seshat/check/routes.sh \
  'POST /api/transcript {"url":"standIn0001","transcribe":"always","jobId":"j2"}' '/api/transcript/progress?jobId=j2' \
  'POST /api/transcript {"url":"dl403always","transcribe":"always","jobId":"j3"}' '/api/transcript/progress?jobId=j3' \
  'POST /api/transcript {"url":"dl403once01","transcribe":"always","jobId":"j4"}' '/api/transcript/progress?jobId=j4' || fail=1
exit $fail
