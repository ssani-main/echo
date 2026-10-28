#!/bin/bash
# The same requests to server.js alone (:8100) and to server.js forwarding to the Seshat service (:8101):
# status, headers (names case-insensitively, minus date) and body must be identical, plain and gzipped.
# From the repo root, with the routes as arguments; the environment (ECHO_MODE, ECHO_PROVIDER, ...) goes
# to all three processes:
#   bash seshat/check/routes.sh /api/health /api/providers
#   ECHO_MODE=web SESHAT=/path/to/seshat.exe bash seshat/check/routes.sh /api/health
set -u
S="${SESHAT:-$(cd ../Seshat && pwd)/target/release/seshat.exe}"
SEC=0123456789abcdef0123456789abcdef
T=$(mktemp -d)
ECHO_SESHAT_SECRET=$SEC "$S" run seshat/server.ts > $T/svc.log 2>&1 & SP=$!
PORT=8100 node server.js > $T/plain.log 2>&1 & P1=$!
PORT=8101 ECHO_SESHAT_URL=http://127.0.0.1:8001 ECHO_SESHAT_SECRET=$SEC node server.js > $T/fwd.log 2>&1 & P2=$!
for p in 8001 8100 8101; do for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:$p/ && break; sleep 0.5; done; done
fail=0
for path in "$@"; do for enc in identity gzip; do
  for p in 8100 8101; do curl -s -D $T/h$p -o $T/b$p -H "accept-encoding: $enc" http://127.0.0.1:$p$path; grep -viE '^(date|x-served-by|keep-alive|connection):' $T/h$p | tr -d '\r' | awk -F': ' '{ $1 = tolower($1); print }' OFS=': ' > $T/hh$p; done
  served=$(grep -i '^x-served-by' $T/h8101 | tr -d '\r')
  if cmp -s $T/b8100 $T/b8101 && cmp -s $T/hh8100 $T/hh8101 && [ -n "$served" ]; then echo "same  $path ($enc, $served, $(wc -c < $T/b8101) bytes)"; else echo "DIFF  $path ($enc) served='$served'"; diff $T/hh8100 $T/hh8101; cmp $T/b8100 $T/b8101; fail=1; fi
done; done
kill $SP $P1 $P2 2>/dev/null; wait 2>/dev/null
grep -i "unreachable\|error" $T/fwd.log $T/svc.log | grep -v NOT_FOUND
exit $fail
