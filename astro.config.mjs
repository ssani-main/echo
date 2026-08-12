// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Echo's page is a build artifact now; everything else about the delivery model
 * is unchanged on purpose.
 *
 * `output: 'static'` rather than SSR: the page carries no server-rendered data
 * (server.js read public/index.html once at boot and shipped the bytes
 * verbatim), so an adapter would add a Vite runtime, ~300 MB of production
 * dependencies and a second request path for exactly zero rendered content.
 * Express keeps every one of its API routes and now serves `dist/`.
 *
 * The two settings below are load-bearing for the Content-Security-Policy in
 * server.js, which names neither 'unsafe-inline' nor a hash:
 *
 *  - `inlineStylesheets: 'never'` — Astro inlines CSS chunks under 4 KB as
 *    <style> tags by default. Any one of them would be refused by
 *    `style-src 'self'`, silently, and the page would render unstyled.
 *  - `prefetch` and view transitions stay off — <ClientRouter /> injects an
 *    inline script, which `script-src 'self'` refuses for the same reason.
 *    (Astro's own `security.csp` cannot help here: it emits a <meta> tag whose
 *    hashes would have to agree with the header Express already sets, so the
 *    policy would have two owners. One owner, in server.js, is better.)
 *
 * tests/page-serving.test.js asserts all of this against the built output.
 */
export default defineConfig({
  output: 'static',
  outDir: './dist',
  publicDir: './public',
  srcDir: './src',
  compressHTML: true,
  build: {
    format: 'file',
    assets: '_astro',
    inlineStylesheets: 'never',
  },
  devToolbar: {
    // The toolbar injects inline script into the dev page; the CSP would refuse
    // it and the console would fill with violations that mean nothing.
    enabled: false,
  },

  // `npm run dev` serves the page with HMR on :4321 but owns no API. Everything
  // the page actually calls is proxied to the Express server on :8000, which
  // you run alongside it with `npm run serve`. /echo-config.js is generated per
  // deployment by that server, so it is proxied rather than built.
  vite: {
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:8000',
        '/echo-config.js': 'http://127.0.0.1:8000',
      },
    },

    // Pin what the CSS minifier is allowed to modernise. Left to its default
    // target it rewrites every `(max-width: 520px)` into the Media Queries
    // Level 4 range form `(width <= 520px)` — semantically identical, but not
    // understood by Safari before 16.4, so a hand-written stylesheet that
    // worked everywhere would quietly stop applying its breakpoints on older
    // browsers. Nothing about this migration was supposed to change what the
    // page renders on, so the transform is turned off rather than accepted.
    //
    // Selector merging (two rules with identical declarations collapsing into
    // one comma-separated rule) is left on: it is order-preserving and
    // observably equivalent.
    build: {
      cssTarget: ['chrome87', 'firefox78', 'safari14', 'edge88'],
    },
  },
});
