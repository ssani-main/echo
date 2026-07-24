# Vendored browser libraries

## jszip.min.js — JSZip 3.10.1

Used by **Export library** to build the ZIP of Markdown files client-side.

**Why it is vendored rather than loaded from a CDN.** It used to come from
`cdn.jsdelivr.net`, which meant three things: the export silently degraded to a
JSON backup whenever the CDN was unreachable (offline, blocked network, a
locked-down corporate proxy) — awkward for an app whose pitch is that it runs on
your own machine; the CSP had to allow an external script origin, which was the
widest thing left in the policy; and the tag carried no `integrity` hash, so
whatever the CDN served was executed.

Vendoring fixes all three at once. `script-src` is now `'self'` with no external
host at all.

**Provenance.** Taken from the npm package `jszip@3.10.1`, not from a CDN
download — npm verifies the tarball against the integrity hash it publishes:

```
package integrity  sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==
dist/jszip.min.js  sha256-acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e
```

**Updating.** `npm pack jszip@<version>`, unpack, copy `dist/jszip.min.js` and
the licence here, and record the new hashes above.

**Licence.** JSZip is dual-licensed MIT / GPLv3 — see `JSZIP-LICENSE.md`, copied
verbatim from the package.
