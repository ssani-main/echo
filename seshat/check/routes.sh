#!/bin/bash
# The same requests to server.js alone (:8100) and to server.js forwarding to the Seshat service (:8101):
# status, headers (names case-insensitively, minus date) and body must be identical, plain and gzipped.
# Afterwards the usage logs must hold the same lines (ts masked): server.js alone writes one, the service
# (and the forwarding server.js) the other.
# From the repo root, one request per argument; the environment (ECHO_MODE, ECHO_PROVIDER, ...) goes to
# all three processes:
#   bash seshat/check/routes.sh /api/health /api/providers
#   bash seshat/check/routes.sh 'POST /api/event {"event":"digest-copy"}' 'POST /api/event @/tmp/body.json'
#   bash seshat/check/routes.sh 'POST:text/plain /api/event {"event":"digest-copy"}'   (default application/json)
#   bash seshat/check/routes.sh '!POST /api/event {bad'
#   ECHO_MODE=web SESHAT=/path/to/seshat.exe bash seshat/check/routes.sh /api/health
# A leading `!` marks a request server.js answers before forwarding (its JSON parser, its gates): then
# neither answer comes from the service, and the service is also asked directly (with the secret), whose
# status and body must be server.js's: its own copy of that check, for when it is the front door.
set -u
S="${SESHAT:-$(cd ../Seshat && pwd)/target/release/seshat.exe}"
SEC=0123456789abcdef0123456789abcdef
T=$(mktemp -d)
ECHO_USAGE_LOG_PATH=$T/fwd.jsonl ECHO_SESHAT_SECRET=$SEC "$S" run seshat/server.ts > $T/svc.log 2>&1 & SP=$!
ECHO_USAGE_LOG_PATH=$T/plain.jsonl PORT=8100 node server.js > $T/plain.log 2>&1 & P1=$!
ECHO_USAGE_LOG_PATH=$T/fwd.jsonl PORT=8101 ECHO_SESHAT_URL=http://127.0.0.1:8001 ECHO_SESHAT_SECRET=$SEC node server.js > $T/fwd.log 2>&1 & P2=$!
for p in 8001 8100 8101; do for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:$p/ && break; sleep 0.5; done; done
fail=0
for spec in "$@"; do
  node_only=; [ "${spec:0:1}" = '!' ] && node_only=1 && spec=${spec:1}
  if [ "${spec:0:1}" = / ]; then method=GET; path=$spec; body=; else method=${spec%% *}; rest=${spec#* }; path=${rest%% *}; body=${rest#"$path"}; body=${body# }; fi
  type=application/json; case $method in *:*) type=${method#*:}; method=${method%%:*};; esac
  args=(-X "$method"); [ "$method" != GET ] && args+=(-H "content-type: $type" --data-binary "$body")
  label="$method $path${body:+ $(printf %.60s "$body")}"
  for enc in identity gzip; do
    for p in 8100 8101; do curl -s -D $T/h$p -o $T/b$p -H "accept-encoding: $enc" "${args[@]}" http://127.0.0.1:$p$path; grep -viE '^(date|x-served-by|keep-alive|connection):' $T/h$p | tr -d '\r' | awk -F': ' '{ $1 = tolower($1); print }' OFS=': ' > $T/hh$p; done
    served=$(grep -i '^x-served-by' $T/h8101 | tr -d '\r')
    ok=; if cmp -s $T/b8100 $T/b8101 && cmp -s $T/hh8100 $T/hh8101; then [ -n "$node_only" ] && [ -z "$served" ] && ok=1; [ -z "$node_only" ] && [ -n "$served" ] && ok=1; fi
    direct=
    if [ -n "$ok" ] && [ -n "$node_only" ] && [ $enc = identity ]; then
      curl -s -D $T/hs -o $T/bs -H "x-echo-forward: $SEC" "${args[@]}" http://127.0.0.1:8001$path
      if [ "$(head -1 $T/hs | tr -d '\r')" = "$(head -1 $T/h8100 | tr -d '\r')" ] && cmp -s $T/bs $T/b8100; then direct=", service direct: same status and body"; else ok=; direct=", service direct: $(head -1 $T/hs | tr -d '\r') $(head -c 200 $T/bs)"; fi
    fi
    if [ -n "$ok" ]; then echo "same  $label ($enc, ${served:-server.js}, $(wc -c < $T/b8101) bytes$direct)"; else echo "DIFF  $label ($enc) served='$served'$direct"; diff $T/hh8100 $T/hh8101; cmp $T/b8100 $T/b8101; fail=1; fi
  done
done
sleep 1 # the usage log is written fire-and-forget
mask() { sed -E 's/"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"/"ts":"<iso>"/' "$1" 2>/dev/null; }
for f in .jsonl .1.jsonl; do
  if [ "$(mask $T/plain$f)" = "$(mask $T/fwd$f)" ]; then [ -e $T/plain$f ] && echo "same  usage log$f ($(wc -l < $T/plain$f) lines)"; else echo "DIFF  usage log$f"; diff <(mask $T/plain$f) <(mask $T/fwd$f); fail=1; fi
done
kill $SP $P1 $P2 2>/dev/null; wait 2>/dev/null
grep -i "unreachable\|error" $T/fwd.log $T/svc.log | grep -vE "NOT_FOUND|\[echo\] (INTERNAL|TRANSCRIPT_UNAVAILABLE):"
exit $fail
