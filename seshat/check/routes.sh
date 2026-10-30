#!/bin/bash
# The same requests to server.js alone (:8100) and to server.js forwarding to the Seshat service (:8101):
# status, headers (names case-insensitively, minus date, in any order: the forwarding copies them through
# fetch's Headers, which lists them sorted) and body must be identical, plain and gzipped.
# Afterwards the usage logs must hold the same lines (ts and ms masked): server.js alone writes one, the
# service (and the forwarding server.js) the other. Each side has its own library database and vault folder
# (ECHO_DB_PATH, ECHO_VAULT_DIR), which must hold the same rows and files afterwards. Timestamps in bodies,
# rows and notes are masked, and so is the vault path in a sync's answer; a body that needed masking is
# compared unzipped and without its etag and content-length. In a body, @VAULT@ is that side's vault folder.
# From the repo root, one request per argument; the environment (ECHO_MODE, ECHO_PROVIDER, ...) goes to
# all three processes:
#   bash seshat/check/routes.sh /api/health /api/providers
#   bash seshat/check/routes.sh 'POST /api/event {"event":"digest-copy"}' 'POST /api/event @/tmp/body.json'
#   bash seshat/check/routes.sh 'POST:text/plain /api/event {"event":"digest-copy"}'   (default application/json)
#   bash seshat/check/routes.sh '!POST /api/event {bad'
#   bash seshat/check/routes.sh 'POST /api/saved @/tmp/entry.json' /api/saved 'POST /api/vault/sync {"dir":"@VAULT@/x"}'
#   ECHO_MODE=web SESHAT=/path/to/seshat.exe bash seshat/check/routes.sh /api/health
# A leading `!` marks a request server.js answers before forwarding (its JSON parser, its gates): then
# neither answer comes from the service, and the service is also asked directly (with the secret), whose
# status and body must be server.js's: its own copy of that check, for when it is the front door.
set -u
S="${SESHAT:-$(cd ../Seshat && pwd)/target/release/seshat.exe}"
SEC=0123456789abcdef0123456789abcdef
T=$(mktemp -d)
W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
mkdir -p $T/plain-vault $T/fwd-vault
ECHO_DB_PATH=$W/fwd.db ECHO_VAULT_DIR=$W/fwd-vault ECHO_USAGE_LOG_PATH=$W/fwd.jsonl ECHO_SESHAT_SECRET=$SEC "$S" run seshat/server.ts > $T/svc.log 2>&1 & SP=$!
ECHO_DB_PATH=$W/plain.db ECHO_VAULT_DIR=$W/plain-vault ECHO_USAGE_LOG_PATH=$W/plain.jsonl PORT=8100 node server.js > $T/plain.log 2>&1 & P1=$!
ECHO_DB_PATH=$W/fwd.db ECHO_VAULT_DIR=$W/fwd-vault ECHO_USAGE_LOG_PATH=$W/fwd.jsonl PORT=8101 ECHO_SESHAT_URL=http://127.0.0.1:8001 ECHO_SESHAT_SECRET=$SEC node server.js > $T/fwd.log 2>&1 & P2=$!
for p in 8001 8100 8101; do for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:$p/ && break; sleep 0.5; done; done
ISO='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z'
# A body as compared once it differs: unzipped, timestamps and a sync's folder masked.
norm() { if grep -qi '^content-encoding: gzip' "$2"; then gzip -dc "$1"; else cat "$1"; fi | sed -E "s/$ISO/<iso>/g; s/\"dir\":\"[^\"]*\"/\"dir\":\"<dir>\"/g"; }
vault() { [ $1 = 8100 ] && echo "$W/plain-vault" || echo "$W/fwd-vault"; }
fail=0
for spec in "$@"; do
  node_only=; [ "${spec:0:1}" = '!' ] && node_only=1 && spec=${spec:1}
  if [ "${spec:0:1}" = / ]; then method=GET; path=$spec; body=; else method=${spec%% *}; rest=${spec#* }; path=${rest%% *}; body=${rest#"$path"}; body=${body# }; fi
  type=application/json; case $method in *:*) type=${method#*:}; method=${method%%:*};; esac
  label="$method $path${body:+ $(printf %.60s "$body")}"
  for enc in identity gzip; do
    for p in 8100 8101; do
      args=(-X "$method"); [ "$method" != GET ] && args+=(-H "content-type: $type" --data-binary "${body//@VAULT@/$(vault $p)}")
      curl -s -D $T/h$p -o $T/b$p -H "accept-encoding: $enc" "${args[@]}" http://127.0.0.1:$p$path
      grep -viE '^(date|x-served-by|keep-alive|connection):' $T/h$p | tr -d '\r' | awk -F': ' '{ $1 = tolower($1); print }' OFS=': ' | sort > $T/hh$p
    done
    served=$(grep -i '^x-served-by' $T/h8101 | tr -d '\r')
    masked=
    if cmp -s $T/b8100 $T/b8101; then same_body=1; else
      same_body=; masked=" masked"
      norm $T/b8100 $T/h8100 > $T/n8100; norm $T/b8101 $T/h8101 > $T/n8101
      cmp -s $T/n8100 $T/n8101 && same_body=1
      for p in 8100 8101; do grep -viE '^(etag|content-length):' $T/hh$p > $T/hx$p; mv $T/hx$p $T/hh$p; done
    fi
    ok=; if [ -n "$same_body" ] && cmp -s $T/hh8100 $T/hh8101; then [ -n "$node_only" ] && [ -z "$served" ] && ok=1; [ -z "$node_only" ] && [ -n "$served" ] && ok=1; fi
    direct=
    if [ -n "$ok" ] && [ -n "$node_only" ] && [ $enc = identity ]; then
      args=(-X "$method"); [ "$method" != GET ] && args+=(-H "content-type: $type" --data-binary "${body//@VAULT@/$(vault 8101)}")
      curl -s -D $T/hs -o $T/bs -H "x-echo-forward: $SEC" "${args[@]}" http://127.0.0.1:8001$path
      if [ "$(head -1 $T/hs | tr -d '\r')" = "$(head -1 $T/h8100 | tr -d '\r')" ] && [ "$(norm $T/bs $T/hs)" = "$(norm $T/b8100 $T/h8100)" ]; then direct=", service direct: same status and body"; else ok=; direct=", service direct: $(head -1 $T/hs | tr -d '\r') $(head -c 200 $T/bs)"; fi
    fi
    if [ -n "$ok" ]; then echo "same  $label ($enc, ${served:-server.js}, $(wc -c < $T/b8101) bytes$masked$direct)"; else echo "DIFF  $label ($enc) served='$served'$direct"; diff $T/hh8100 $T/hh8101; if [ -n "$masked" ]; then diff $T/n8100 $T/n8101 | head -6; else cmp $T/b8100 $T/b8101; fi; fail=1; fi
  done
done
sleep 1 # the usage log is written fire-and-forget
mask() { sed -E "s/$ISO/<iso>/g; s/\"ms\":[0-9]+/\"ms\":0/g" "$1" 2>/dev/null; }
for f in .jsonl .1.jsonl; do
  if [ "$(mask $T/plain$f)" = "$(mask $T/fwd$f)" ]; then [ -e $T/plain$f ] && echo "same  usage log$f ($(wc -l < $T/plain$f) lines)"; else echo "DIFF  usage log$f"; diff <(mask $T/plain$f) <(mask $T/fwd$f); fail=1; fi
done
kill $SP $P1 $P2 2>/dev/null; wait 2>/dev/null
if [ -e $T/plain.db ] || [ -e $T/fwd.db ]; then
  if node --no-warnings seshat/check/dbdump.mjs $W/plain.db > $T/dplain 2>&1 && node --no-warnings seshat/check/dbdump.mjs $W/fwd.db > $T/dfwd 2>&1 && cmp -s $T/dplain $T/dfwd; then
    echo "same  library database ($(grep -c '^videos' $T/dplain) videos, $(grep -c '^tags' $T/dplain) tags, $(grep -c '^fts' $T/dplain) fts rows)"
  else echo "DIFF  library database"; diff $T/dplain $T/dfwd | head -20; fail=1; fi
fi
files=$(cd $T/plain-vault && find . -type f | sort)
if [ -n "$files$(cd $T/fwd-vault && find . -type f)" ]; then
  vok=1; [ "$files" = "$(cd $T/fwd-vault && find . -type f | sort)" ] || vok=
  while IFS= read -r f; do [ "$(mask "$T/plain-vault/$f")" = "$(mask "$T/fwd-vault/$f")" ] || { vok=; echo "  differs: $f"; diff <(mask "$T/plain-vault/$f") <(mask "$T/fwd-vault/$f") | head -6; }; done <<< "$files"
  if [ -n "$vok" ]; then echo "same  vault folder ($(echo "$files" | wc -l) files)"; else echo "DIFF  vault folder"; diff <(echo "$files") <(cd $T/fwd-vault && find . -type f | sort); fail=1; fi
fi
grep -i "unreachable\|error" $T/fwd.log $T/svc.log | grep -vE "^[^:]*:\s+name: |NOT_FOUND|\[echo\] (INTERNAL|TRANSCRIPT_UNAVAILABLE|INVALID_URL|WEB_MODE_UNSUPPORTED):|caught error|searchSummariesFor query failed"
exit $fail
