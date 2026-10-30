#!/bin/bash
# Step 4's requests through routes.sh: the library routes, in an order that builds a library, edits and
# searches it, syncs it to a vault and deletes from it. From the repo root: bash seshat/check/library.sh
# (the environment goes on to routes.sh, e.g. SESHAT=...). Not sent: GET /api/saved/export (streams; stays
# on Node) and a non-string field on POST /api/saved (refused here on purpose, see PORT.md).
set -u
B=$(mktemp -d)
node -e '
const fs = require("fs"), dir = process.argv[1];
const seg = (n, w) => Array.from({ length: n }, (_, i) => ({ text: `${w} ${i} learning`, offset: i * 1000, duration: 900 }));
const put = (name, v) => fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(v));
put("e1", { url: " https://www.youtube.com/watch?v=GRzaq5AHiV8 ", videoId: "GRzaq5AHiV8", title: "Straße café 🎉 deep learning",
  segments: seg(30, "alpha"), digest: "## TL;DR\n\nLearning is fun.\n\n## Detail\n\nMore.", channel: "Chan",
  channelUrl: "https://youtube.com/@chan", transcriptSource: "captions", whisperModel: null, auto: true });
put("e2", { url: "javascript:alert(1)", videoId: "bbbbbbbbbbb", title: "", digest: "", segments: [5, "str", [1, 2], {}, { text: 0 },
  { text: false }, { text: 12.5 }, { text: [1, [null, "x"], 3] }, { text: { a: 1 } }, { text: true }, { other: "y" }, { text: "  spaced  " }] });
put("e3", { videoId: "a b", segments: [{ text: "gamma ray" }], title: "Spaced id" });
put("e4", { videoId: "ddddddddddd", title: "half", segments: [{ text: "ok" }, null] });
put("e1b", { videoId: "GRzaq5AHiV8", segments: [{ text: "rewritten deep learning" }], title: "Second title", channel: "", whisperModel: "small", transcriptSource: "whisper" });
' "$(cygpath -m "$B" 2>/dev/null || echo "$B")"
bash seshat/check/routes.sh \
  /api/saved '/api/saved?limit=5' \
  "POST /api/saved @$B/e1.json" "POST /api/saved @$B/e2.json" "POST /api/saved @$B/e3.json" "POST /api/saved @$B/e4.json" \
  'POST /api/saved {"videoId":"x"}' 'POST /api/saved {"segments":[{"text":"a"}]}' 'POST /api/saved []' \
  'POST:text/plain /api/saved {"videoId":"x","segments":[{"text":"a"}]}' '!POST /api/saved {bad' \
  /api/saved '/api/saved?limit=1' '/api/saved?limit=1&offset=1' '/api/saved?limit=0' '/api/saved?limit=abc' \
  '/api/saved?limit=2&offset=-1' '/api/saved?limit=2&limit=3' '/api/saved?limit=1000' '/api/saved?limit=1.5&offset=0.5' '/api/saved?limit=' \
  /api/saved/GRzaq5AHiV8 /api/saved/nope /API/SAVED/GRzaq5AHiV8/ '/api/saved/a%20b' /api/saved/ddddddddddd \
  'PATCH /api/saved/GRzaq5AHiV8/tags {"tags":[" ai ","ml","ai",5,null,{},[1,[2]]]}' 'PATCH /api/saved/GRzaq5AHiV8/tags {"tags":"x"}' \
  'PATCH /api/saved/nope/tags {"tags":["x"]}' 'PATCH:text/plain /api/saved/GRzaq5AHiV8/tags {"tags":["x"]}' \
  /api/saved/GRzaq5AHiV8/export.md '/api/saved/GRzaq5AHiV8/export.md?transcript=0' '/api/saved/bbbbbbbbbbb/export.md?transcript=false' /api/saved/nope/export.md \
  '/api/search?q=learning' '/api/search?q=' '/api/search?q=%22bad' '/api/search?q=learning&limit=1' '/api/search?q=caf%C3%A9' '/api/search?q=gamma&q=ray' '/api/search?q=AND+OR' \
  'POST /api/vault/sync {}' 'POST /api/vault/sync {"dir":"@VAULT@/sub","includeTranscript":false}' 'POST /api/vault/sync {"dir":"  "}' \
  "POST /api/saved @$B/e1b.json" /api/saved/GRzaq5AHiV8 'POST /api/vault/sync {}' \
  'DELETE /api/saved/bbbbbbbbbbb' 'DELETE /api/saved/bbbbbbbbbbb' 'DELETE /api/saved/a%20b' /api/saved '/api/search?q=learning+OR+gamma'
