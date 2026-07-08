# ai-tell (vendored)

`patterns.js` in this directory is vendored verbatim from
[github.com/conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing)
(detector v3.14.0), licensed MIT — see [`LICENSE`](LICENSE) for the full text
and copyright notice. It is unmodified; do not reformat or edit it in place —
re-vendor from upstream instead.

## What it does

`patterns.js` is a zero-dependency CommonJS module exporting a single
`AIDetector` object with an `analyzeText(text, options?)` API:

```js
const AIDetector = require('./patterns.js');
const result = AIDetector.analyzeText(text);
// result.score                  — 0-100, higher = more AI-writing signals
// result.label                  — human-readable score band
// result.document_classification — e.g. HUMAN_ONLY, UNSCORED, ...
// result.stats.wordCount
// result.issues                 — [{ type, text, ... }, ...] flagged spans
```

It detects filler intensifiers, corporate/AI jargon ("delve", "leverage",
"robust", "actionable", ...), formulaic transitions, hedge-stacking, em-dash
overuse, and a handful of stylometric/AI-tool-fingerprint signals (see the
header comment in `patterns.js` for the full model).

This directory has its own `package.json` (`{"type":"commonjs"}`) so
`patterns.js` can be `require()`d as CommonJS from this ESM (`"type":"module"`)
repo without modification.

## `score-digests.mjs`

A dev-only eval script that scores Echo's saved digests against this
detector, to sanity-check the digest prompt isn't drifting into
AI-sounding prose (see the "Write plainly" instruction in `digest.js`).

```sh
npm run digest:aitell                 # score every saved digest in data/library.db
npm run digest:aitell -- path/to.txt  # score a single ad-hoc .txt/.md file
npm run digest:aitell -- -            # score stdin (e.g. pipe in a fresh digest)
```

Opens `data/library.db` read-only and never writes to it. Prints a
per-digest table, aggregate stats (mean/median/min/max, score-band
distribution), and a recurring-pattern-category breakdown across all
scored digests.

**Not a runtime dependency.** This tool is not imported by `server.js` or any
bundled backend module, and is not listed in `src-tauri/tauri.conf.json`'s
`bundle.resources` — it exists only to be run manually from the CLI during
development.
