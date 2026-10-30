#!/bin/bash
# The Node suite with forwarding to the Seshat service on. Every test file but the three that read the library
# over HTTP runs against one service, sharing its usage log (ECHO_TEST_USAGE_LOG); those three each get a
# service of their own on their own database (ECHO_TEST_DB_PATH), since they count what they saved. From the
# repo root: bash seshat/check/suite.sh   (SESHAT names the compiler)
set -u
S="${SESHAT:-$(cd ../Seshat && pwd)/target/release/seshat.exe}"
SEC=0123456789abcdef0123456789abcdef
T=$(mktemp -d)
W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
LIBRARY_TESTS="tests/api.test.js tests/saved-pagination.test.js tests/page-serving.test.js"
"$S" build seshat/server.ts -o "$W/service.exe" > /dev/null || exit 1
export ECHO_SESHAT_URL=http://127.0.0.1:8001 ECHO_SESHAT_SECRET=$SEC

# start <name>: a service on <name>.db and <name>.jsonl, waited for.
start() {
  ECHO_DB_PATH=$W/$1.db ECHO_USAGE_LOG_PATH=$W/$1.jsonl "$W/service.exe" > "$T/$1.service.log" 2>&1 & SP=$!
  for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8001/ && return; sleep 0.5; done
  echo "the service didn't start"; cat "$T/$1.service.log"; exit 1
}
stop() { kill $SP 2>/dev/null; wait $SP 2>/dev/null; }

fail=0
start rest
rest=$(ls tests/*.test.js | grep -vxF -f <(tr ' ' '\n' <<< "$LIBRARY_TESTS"))
ECHO_TEST_USAGE_LOG=$W/rest.jsonl node --test $rest > "$T/rest.out" 2>&1 || fail=1
stop
echo "rest: $(grep -E '^ℹ (pass|fail|skipped) ' "$T/rest.out" | tr '\n' ' ')"
for f in $LIBRARY_TESTS; do
  name=$(basename "$f" .test.js)
  start "$name"
  ECHO_TEST_DB_PATH=$W/$name.db ECHO_TEST_USAGE_LOG=$W/$name.jsonl node --test "$f" > "$T/$name.out" 2>&1 || fail=1
  stop
  echo "$name: $(grep -E '^ℹ (pass|fail|skipped) ' "$T/$name.out" | tr '\n' ' ')"
done
grep -h -B2 -A12 '^not ok' "$T"/*.out | head -80
echo "logs: $T"
exit $fail
