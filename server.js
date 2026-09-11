import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzip, gzipSync, createGzip, brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import {
  extractVideoId,
  fetchTranscript,
  getVideoMeta,
  listCaptionTracks,
} from './transcript.js';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL, modelCacheDir, downloadState, startModelDownload } from './whisperModel.js';
import { resolveWhisperBinary, transcribeFile, LOCAL_MEDIA_EXTENSIONS } from './whisper.js';
import { forOwner, DEFAULT_OWNER, adoptDefaultLibrary, closeAllLibraries } from './store.js';
import { entryToMarkdown } from './markdown.js';
import { syncVault } from './vault.js';
import {
  generateDigest,
  suggestTags,
  thresholdCharsFor,
} from './digest.js';
import {
  signToken, verifyToken, parseCookies, serializeCookie, randomToken, pkceChallenge,
  buildGoogleAuthUrl, decodeIdToken, validateIdTokenPayload, exchangeCode,
  SESSION_COOKIE, OAUTH_COOKIE, SESSION_TTL_MS, OAUTH_TTL_MS,
} from './auth.js';
import {
  openSyncDb, upsertUser, getUser, pullEntries, pushEntries, userBytes, deleteUser,
  bumpTokenVersion, upsertAtprotoUser, saveAtprotoTokens, deleteAtprotoTokens, getAtprotoTokens,
  submitRegistration, decideRegistration, listRegistrations, setStatus,
  touchLastSeen, forceSignOut, setPdsSync, getPdsSync, closeSyncDb,
} from './syncStore.js';
import {
  resolveAccount, createSession as atprotoCreateSession, deriveKey, encryptSecret, decryptSecret,
} from './atproto.js';
import { createPdsSync } from './pdsSync.js';
import { COLLECTION as PDS_COLLECTION } from './pds.js';
import { logEvent, errLabel } from './usagelog.js';
import { validateApiKey, publicProviderList, getProviderId, getProviderLimits, getReasoningLevel, normalizeProviderId, normalizeReasoningLevel, DEFAULT_PROVIDER_ID } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = join(__dirname, 'dist');

// ---------------------------------------------------------------------------
// Mode flag — 'local' (default: npm start) vs 'web' (hosted) vs 'desktop'
// (Tauri app). Every web-only branch below is gated on `isWeb` so local/
// desktop behavior stays byte-for-byte identical to today. Desktop mode is
// otherwise identical to local (full server-side library, no rate limits,
// no payload caps) — it only additionally allows optional
// BYOK via `readApiKey`/`/api/validate-key`, purely as a fallback when the
// local `claude` CLI isn't installed/authenticated.
// ---------------------------------------------------------------------------
const ECHO_MODE = process.env.ECHO_MODE === 'web' ? 'web'
  : process.env.ECHO_MODE === 'desktop' ? 'desktop'
  : 'local';
const isWeb = ECHO_MODE === 'web';
const isDesktop = ECHO_MODE === 'desktop';

// ---------------------------------------------------------------------------
// Numeric env config validation
// ---------------------------------------------------------------------------
// Bare Number(process.env.X) silently yields NaN for malformed values (e.g.
// "200k"), which for size caps means `chars > NaN` is always false — a
// caller-controlled bypass of the cap. Fail loudly at startup instead.

/**
 * Reads a numeric env var, validating it is a finite number >= min.
 * Returns `fallback` when the env var is unset. Throws a clear startup
 * Error when the env var IS set but is not a valid number.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number }} [opts]
 * @returns {number}
 */
function numFromEnv(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(
      `Invalid value for env var ${name}: "${raw}". Expected a finite number >= ${min}.`
    );
  }
  return n;
}

const app = express();
const PORT = numFromEnv('PORT', 8000, { min: 1 });

// Bind to localhost by default — safe default for local/desktop use, where
// the server should never be reachable from the network. Hosted/web
// deployments (e.g. behind a reverse proxy) can opt in via ECHO_HOST.
const HOST = process.env.ECHO_HOST && process.env.ECHO_HOST.trim()
  ? process.env.ECHO_HOST.trim()
  : '127.0.0.1';

// Behind a reverse proxy, every request arrives from the proxy, so req.ip is
// the proxy's address for EVERYONE unless Express is told otherwise — and the
// rate limiters key on req.ip.
//
// This used to be web-mode only, which was right when web mode was the only
// deployment behind a proxy. It no longer is: `npm run serve:public` fronts a
// LOCAL instance with Holesail + Janus, and measured, twelve sign-in attempts
// from twelve different visitors shared one bucket — so one person fumbling
// their app password locked out sign-in for everybody.
//
// Opt-in rather than automatic, because trusting X-Forwarded-For when nothing
// is actually in front of the server lets any client claim any address and walk
// straight past the limiter. serve:public sets it, because it knows it put a
// tunnel there.
const TRUST_PROXY = isWeb || /^(1|true|yes)$/i.test(process.env.ECHO_TRUST_PROXY || '');
if (TRUST_PROXY) app.set('trust proxy', 1);

// Session cookies get Secure whenever the instance is actually served over
// https — which now includes a local instance behind the tunnel, not just web
// mode. Without it the cookie is also sent over plain http to the same host.
const SECURE_COOKIES = TRUST_PROXY;

app.use(express.json({ limit: '5mb' }));

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
// The page's script and CSS live in real files (content-hashed bundles under
// dist/_astro/, plus theme-init.js and echo-config.js) and it carries no
// inline <script>, <style> or style="" attribute, so NEITHER script-src nor
// style-src needs 'unsafe-inline' — the weakness the inline monolith forced is gone.
//
// Note what this does and does not cover: `el.style.width = x` is the CSSOM
// and is not governed by style-src, so dynamic styling still works. What is
// blocked is a style attribute in parsed markup, including one arriving
// through innerHTML — which is exactly the injection path worth closing.
// It also blocks framing, MIME-sniffing, and restricts every origin to self:
// JSZip is vendored (dist/vendor/) rather than pulled from a CDN, and the
// Plaintext theme loads no webfont, so the policy names no external host at
// all. The only remaining outbound origins are images from YouTube's thumbnail
// CDNs.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "font-src 'self'; " +
  "img-src 'self' data: https://i.ytimg.com https://img.youtube.com; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'self'";

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', CSP);
  next();
});

// ---------------------------------------------------------------------------
// Step 1 — read dist/index.html (the Astro build output) at startup
// ---------------------------------------------------------------------------
// index.html is read ONCE at startup and cached in memory, rather than
// re-reading on every request. Trade-off: the page is a build artifact, so
// a frontend edit needs `npm run build` and a server restart (or `npm run dev`,
// which runs the Astro dev server on :4321 and proxies `/api` and
// `/echo-config.js` to this server on :8000).
// The page's mode flag used to be injected as an inline <script> into the HTML.
// It is served as a real file instead, because that was the last inline script
// on the page — and with it gone, the CSP above can refuse inline script
// outright rather than allowing it for everything.
function buildConfigScript(mode) {
  return `window.__ECHO__=${JSON.stringify({ mode })};\n`;
}

// The page is a build artifact now. Fail loudly and early if it is missing:
// the alternative is an ENOENT stack trace from readFileSync, or worse, a
// server that boots and serves an unstyled page because only the bundles are
// absent. Both are the operator's problem to fix and neither says how.
const ASTRO_DIR = join(DIST_DIR, '_astro');
if (!existsSync(join(DIST_DIR, 'index.html')) || !existsSync(ASTRO_DIR)) {
  throw new Error(
    'dist/ is missing or incomplete — the frontend has not been built. ' +
    'Run `npm run build` before starting the server.'
  );
}

const CACHED_INDEX_HTML = readFileSync(join(DIST_DIR, 'index.html'), 'utf8');

/**
 * True when the client actually accepts `coding`. Honours an explicit `q=0`
 * ("gzip;q=0" means *not* acceptable), which a naive substring test would
 * misread as support and then serve an encoding the client rejects.
 *
 * @param {import('express').Request} req
 * @param {string} coding - a content-coding token, e.g. 'gzip' or 'br'
 * @returns {boolean}
 */
function acceptsEncoding(req, coding) {
  const header = req.get('Accept-Encoding') || '';
  // The (?![\w-]) guard matters: without it "br" would match the first two
  // characters of a longer token and report support for an encoding the client
  // never offered.
  const match = header.match(
    new RegExp(String.raw`(?:^|,)\s*${coding}(?![\w-])\s*(?:;\s*q=([0-9.]+))?`, 'i')
  );
  if (!match) return false;
  return match[1] === undefined || parseFloat(match[1]) > 0;
}

/** @param {import('express').Request} req */
function acceptsGzip(req) {
  return acceptsEncoding(req, 'gzip');
}

// Brotli at maximum quality, which is worth 17% over gzip -9 on this app's
// assets (index.html + the content-hashed bundles in dist/_astro/).
//
// Compressed in the BACKGROUND, just after this module finishes loading —
// neither at boot nor on demand, because both of those make somebody wait.
// q=11 costs ~455 ms for the page shell files: doing it inline more than doubles a
// 208 ms startup, on every dev restart, every Tauri sidecar launch and in CI's
// boot job, none of which ever ask for brotli. Doing it on first request
// instead just moves the same cost onto whoever loads the page first, which
// measured at 431 ms on app.js alone against 6 ms warm.
//
// So: schedule it with setImmediate (boot is not delayed), run it through the
// async zlib binding (it lands on the libuv threadpool, so the event loop keeps
// serving), and have the request path use the buffer only if it is already
// there. Anyone who arrives during the warm-up gets gzip — correct, fast, and
// nobody blocks on a compressor.
//
// Lower qualities were measured and are not worth a knob: q=9 costs 55 ms for
// only 9%, and the whole point of a cached-forever buffer is that the CPU is
// amortised to nothing.
const BROTLI_QUALITY = 11;
const brotliAsync = promisify(brotliCompress);

/** @type {Array<() => Promise<void>>} One warm-up per cached asset. */
const brotliWarmups = [];

/**
 * Serve a boot-time-cached, pre-compressed asset.
 *
 * index.html, the content-hashed bundles in dist/_astro/, theme-init.js, and
 * vendor/jszip.min.js are all read once from dist/ and gzipped once, for the
 * same reason: they are byte-identical on every request, so per-response
 * compression would burn CPU to produce the same bytes. That is also why this
 * is a hand-rolled Content-Encoding rather than a compression middleware —
 * a middleware would re-compress the same bytes on every page load, which on a
 * small hosted VM is real CPU for an identical result, and in local mode is CPU
 * spent compressing loopback traffic that never hits a network.
 *
 * The trade-off: the page is a build artifact, so a frontend edit needs
 * `npm run build` and a server restart to take effect.
 *
 * Registered BEFORE express.static so these win over the on-disk copies, which
 * would otherwise be served uncompressed.
 */
function serveCached(path, contentType, text) {
  const raw = Buffer.from(text, 'utf8');
  const gzipped = gzipSync(raw, { level: 9 });
  /** @type {Buffer|null} Filled in by the background warm-up below. */
  let brotli = null;

  brotliWarmups.push(async () => {
    if (brotli) return;
    try {
      brotli = await brotliAsync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      });
    } catch {
      // A failed warm-up is not an error worth taking the server down for —
      // gzip stays available and every request still gets a correct response.
    }
  });

  app.get(path, (req, res) => {
    res.set('Content-Type', contentType);
    res.set('Vary', 'Accept-Encoding');

    // Note the `brotli &&`: this path never compresses, it only serves what the
    // warm-up has already produced. That is what guarantees no request waits.
    if (brotli && acceptsEncoding(req, 'br')) {
      res.set('Content-Encoding', 'br');
      return res.send(brotli);
    }

    if (acceptsGzip(req)) {
      res.set('Content-Encoding', 'gzip');
      return res.send(gzipped);
    }
    return res.send(raw);
  });
}

const THEME_INIT_JS = readFileSync(join(DIST_DIR, 'theme-init.js'), 'utf8');
const JSZIP_JS = readFileSync(join(DIST_DIR, 'vendor', 'jszip.min.js'), 'utf8');
const CONFIG_JS = buildConfigScript(ECHO_MODE);

serveCached('/', 'text/html; charset=utf-8', CACHED_INDEX_HTML);
serveCached('/theme-init.js', 'text/javascript; charset=utf-8', THEME_INIT_JS);
serveCached('/echo-config.js', 'text/javascript; charset=utf-8', CONFIG_JS);
serveCached('/vendor/jszip.min.js', 'text/javascript; charset=utf-8', JSZIP_JS);

// Scan dist/_astro/ and register each entry for cached serving. The
// filenames carry a content hash chosen by the bundler (e.g.
// _astro/main.Abc123.js), so the server cannot know them ahead of time —
// a static list would break on every rebuild. The hash is also what makes
// these files safe to cache: a new build produces a new name, so CDNs and
// browsers never serve stale bytes from a previous deploy.
// (ASTRO_DIR and its existence are established above, next to index.html.)
for (const name of readdirSync(ASTRO_DIR)) {
  const ext = name.slice(name.lastIndexOf('.'));
  let contentType;
  if (ext === '.js') {
    contentType = 'text/javascript; charset=utf-8';
  } else if (ext === '.css') {
    contentType = 'text/css; charset=utf-8';
  } else {
    // Fonts, images, and other binary assets that Astro may emit under
    // _astro/ are already compressed and binary — skip them and let
    // express.static serve them from dist/.
    continue;
  }
  serveCached('/_astro/' + name, contentType,
    readFileSync(join(ASTRO_DIR, name), 'utf8'));
}

/**
 * Resolves once every cached asset has its brotli buffer.
 *
 * Kicked off with setImmediate so importing this module — which every mode and
 * every test does — returns first and the server can start listening. The
 * warm-ups run one after another rather than all at once, so a small hosted VM
 * sees one busy threadpool slot instead of five.
 *
 * Exported because tests need a deterministic point to wait for: without it, an
 * assertion about brotli would race the warm-up and flake.
 */
const brotliReady = new Promise((resolve) => {
  setImmediate(async () => {
    for (const warm of brotliWarmups) await warm();
    resolve();
  });
});

// ---------------------------------------------------------------------------
// Response compression (API JSON + markdown export)
// ---------------------------------------------------------------------------
// The app shell above is compressed once at boot, but API responses are built
// per request and some are big: a 45-minute transcript is ~166 KB of JSON that
// gzips to ~14 KB — 11.7x — in ~2 ms at level 6. Level 9 buys another 2% for 3x
// the CPU, so 6 it is (the same default zlib and the `compression` middleware
// use). At 2 ms per response this earns its place in every mode, including the
// loopback ones, rather than being gated to hosted web mode.
//
// This wraps res.send() instead of pulling in a compression middleware because
// every response Echo would compress is ALREADY a fully-buffered string or
// Buffer — res.json() serialises before it sends — so there is no streaming
// case to handle and no reason to carry a dependency for one. The SSE route
// never goes through res.send(), so it is untouched by this and keeps
// streaming uncompressed, which is what an event stream needs.

const gzipAsync = promisify(gzip);
const RESPONSE_GZIP_LEVEL = 6;

// Under roughly one network packet, compressing spends CPU and two extra
// headers to save nothing.
const RESPONSE_GZIP_MIN_BYTES = 1024;

const COMPRESSIBLE_TYPE_RE = /^(?:application\/json|text\/)/i;

app.use((req, res, next) => {
  const rawSend = res.send.bind(res);

  res.send = function compressedSend(body) {
    // Already encoded (the pre-gzipped app shell), or the client can't take it.
    if (res.get('Content-Encoding') || !acceptsGzip(req)) return rawSend(body);
    // Objects are left alone: res.json() stringifies first and calls back into
    // here with the serialised string, so compressing here too would be double
    // work on a body Express is about to replace.
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return rawSend(body);
    if (!COMPRESSIBLE_TYPE_RE.test(res.get('Content-Type') || '')) return rawSend(body);

    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (buf.length < RESPONSE_GZIP_MIN_BYTES) return rawSend(body);

    res.set('Vary', 'Accept-Encoding');
    gzipAsync(buf, { level: RESPONSE_GZIP_LEVEL }).then(
      (gz) => {
        // The client can disconnect while we compress — writing then would
        // throw inside a promise nobody is awaiting.
        if (res.writableEnded) return;
        res.set('Content-Encoding', 'gzip');
        rawSend(gz);
      },
      (err) => {
        // Compression is an optimisation, never a reason to fail a response.
        console.error('[echo] response compression failed, sending uncompressed:', err.message);
        if (!res.writableEnded) rawSend(body);
      }
    );
    return res;
  };

  next();
});

app.use(express.static(DIST_DIR));

// ---------------------------------------------------------------------------
// Structured error helpers
// ---------------------------------------------------------------------------

// HTTP status codes to use for each error code
const ECHO_ERROR_STATUS = {
  INVALID_URL:            400,
  // The request named a provider that does not exist. 400, not 500: the
  // request is the thing that is wrong, and a typo must not read as an outage.
  PROVIDER_UNKNOWN:       400,
  THINKING_INVALID:       400,
  TRANSCRIPT_UNAVAILABLE: 422,
  CLAUDE_NOT_INSTALLED:   503,
  CLAUDE_NOT_AUTHED:      503,
  CLAUDE_FAILED:          502,
  YTDLP_MISSING:          503,
  MEMBERS_ONLY:           422,
  RATE_LIMITED:           429,
  INTERNAL:               500,
  API_NOT_AUTHED:         401,
  API_RATE_LIMITED:       429,
  API_FAILED:             502,
  WEB_MODE_UNSUPPORTED:   503,
  FFMPEG_MISSING:  503,
  // ffmpeg ran and could not decode the file. 422, not 500: the request is
  // well-formed but its payload is unusable, and the fix is the user's.
  MEDIA_UNREADABLE:       422,
  // YouTube refused the audio download after retries. 503 + Retry-After
  // semantics: nothing is wrong with the request or the video, the upstream is
  // just saying not now.
  AUDIO_DOWNLOAD_REFUSED: 503,
  WHISPER_MISSING:        503,
  WHISPER_MODEL_MISSING:  503,
  WHISPER_FAILED:         502,
  WHISPER_AUDIO_TOO_LONG: 422,
  WHISPER_TIMEOUT:        504,
  WHISPER_MODEL_UNKNOWN:         400,
  WHISPER_MODEL_DOWNLOAD_FAILED: 502,
  WHISPER_MODEL_VERIFY_FAILED:   502,
  // The model returned something unparseable. 502 because the failure is
  // upstream, not in the request — and being in this map at all is what stops
  // it falling through to a generic "unexpected server error".
  MODEL_BAD_JSON:         502,
  AUTH_FAILED:            502,
};

/**
 * Send a structured JSON error envelope: { error: { code, message, hint } }
 * Logs the raw message server-side.
 *
 * @param {import('express').Response} res
 * @param {string} code     - one of the ECHO_ERROR codes or any uppercase string
 * @param {string} message  - human-readable short description
 * @param {string} [hint]   - optional remediation hint shown to the user
 * @param {number} [status] - override HTTP status (defaults via ECHO_ERROR_STATUS)
 * @param {{ reason?: string, detail?: string }} [extra] - optional classification fields
 */
function sendError(res, code, message, hint = '', status = null, extra = {}) {
  console.error(`[echo] ${code}: ${message}`);
  const httpStatus = status ?? ECHO_ERROR_STATUS[code] ?? 500;
  const error = { code, message, hint };
  if (extra.reason) error.reason = extra.reason;
  if (extra.detail) error.detail = extra.detail;
  return res.status(httpStatus).json({ error });
}

/**
 * Convert a caught Error (potentially tagged with echoCode / hint) into
 * a structured API response. Falls back to INTERNAL if no echoCode is set.
 *
 * @param {import('express').Response} res
 * @param {Error} err
 */
function sendCaughtError(res, err) {
  console.error('[echo] caught error:', err);
  const code = err.echoCode;
  if (code && Object.prototype.hasOwnProperty.call(ECHO_ERROR_STATUS, code)) {
    return sendError(res, code, err.message, err.hint || '', null, { reason: err.reason, detail: err.detail });
  }
  // Unexpected error — log detail, send generic message to client
  return sendError(res, 'INTERNAL', 'An unexpected server error occurred.', '');
}

/**
 * Validate that `value` is a non-empty (post-trim) string, sending a
 * structured 400 INTERNAL error via sendError() and returning false if not.
 * Callers should `if (!requireText(...)) return;` immediately after.
 *
 * @param {import('express').Response} res
 * @param {*} value
 * @param {string} message - error message to send when validation fails
 * @param {string} [hint]  - optional remediation hint
 * @returns {boolean} true if value is valid text (caller should proceed)
 */
function requireText(res, value, message, hint = '') {
  if (!value || !value.trim()) {
    sendError(res, 'INTERNAL', message, hint, 400);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 2 — BYOK (bring-your-own-key) header threading
// ---------------------------------------------------------------------------
// Honored in web mode (required there) and desktop mode (optional there —
// the Tauri app lets a user without the `claude` CLI add their own
// Anthropic key in Settings). In local mode this always returns undefined,
// so getProvider() falls through to the default ClaudeCliProvider —
// unchanged. In desktop mode a keyless request also falls through to the
// CLI provider; the header is just an optional override.

function readApiKey(req) {
  const k = req.get('X-Echo-Api-Key');
  if (!k || !k.trim()) return undefined;
  // web/desktop: a key is accepted unconditionally — BYOK is the whole point
  // of those modes.
  if (isWeb || isDesktop) return k.trim();
  // local: only when the request NAMES a provider. A key turning up on its own
  // must not silently move a local install off the keyless CLI, which is the
  // surprise the original web/desktop-only rule existed to prevent. But
  // "use DeepSeek, here is its key" is a deliberate act, and without this the
  // provider toggle would be unusable in the mode this app is actually run in.
  return requestedProvider(req).named ? k.trim() : undefined;
}

/**
 * The provider a request explicitly named, if any.
 *
 * Distinguishes ABSENT from INVALID, which the two callers need to treat
 * differently: absent means "resolve it normally" and must stay a no-op, while
 * invalid is a client bug that deserves a 400 rather than a silent
 * substitution to some other provider's bill.
 *
 * @param {import('express').Request} req
 * @returns {{ named: boolean, id: string|null, raw: string }}
 */
function requestedProvider(req) {
  const raw = req.get('X-Echo-Provider');
  if (!raw || !raw.trim()) return { named: false, id: null, raw: '' };
  return { named: true, id: normalizeProviderId(raw), raw: raw.trim() };
}

/**
 * The reasoning level a request asked for, if any.
 *
 * Same absent-vs-invalid distinction as the provider header: absent means
 * "resolve it from the environment", invalid is a client bug and gets a 400
 * rather than silently running with the operator's default instead.
 *
 * @param {import('express').Request} req
 * @returns {{ named: boolean, level: string|undefined, raw: string }}
 */
function requestedReasoning(req) {
  const raw = req.get('X-Echo-Thinking');
  if (!raw || !raw.trim()) return { named: false, level: undefined, raw: '' };
  return { named: true, level: normalizeReasoningLevel(raw) || undefined, raw: raw.trim() };
}

/**
 * The provider/apiKey pair to run this request with, in the shape providers.js
 * expects. One place builds it so the digest and validate-key routes cannot
 * disagree about which provider a request meant.
 *
 * @param {import('express').Request} req
 */
function providerRequest(req) {
  const { named, id, raw } = requestedProvider(req);
  const think = requestedReasoning(req);
  return {
    named,
    invalid: named && !id,
    raw,
    // `undefined`, never null/'' — providers.js treats a falsy provider as
    // "not specified" and resolves from apiKey / ECHO_PROVIDER / the default.
    provider: id || undefined,
    apiKey: readApiKey(req),
    // Likewise undefined when absent, so providers.js falls back to ECHO_THINKING.
    reasoning: think.level,
    reasoningInvalid: think.named && !think.level,
    rawReasoning: think.raw,
  };
}

/**
 * Guards AI endpoints in web mode: every AI call must be billed to a
 * user-supplied Anthropic API key, never to the operator's own credentials.
 * Without this, a keyless request in web mode would silently fall back to
 * ClaudeCliProvider (or ApiKeyProvider's process.env.ANTHROPIC_API_KEY
 * fallback), billing the operator. NO-OP in local/desktop mode — the CLI
 * provider continues to work with no key, unchanged.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true if the response was already sent (caller must return)
 */
function requireWebKey(req, res) {
  if (!isWeb) return false;
  if (readApiKey(req)) return false;
  sendError(
    res,
    'API_NOT_AUTHED',
    'An Anthropic API key is required for this hosted instance.',
    'Add your own Anthropic API key in Settings to use AI features here, or run Echo locally/desktop for unlimited use.'
  );
  return true;
}

// ---------------------------------------------------------------------------
// Step 6 — abuse / cost guards (web-gated no-ops in local mode)
// ---------------------------------------------------------------------------

// Max transcript length (characters) accepted in web mode before rejecting.
const ECHO_MAX_TRANSCRIPT_CHARS = numFromEnv('ECHO_MAX_TRANSCRIPT_CHARS', 200_000, { min: 1 });

// Max text/segments payload size (characters) accepted by AI endpoints in web mode.
const ECHO_MAX_AI_PAYLOAD_CHARS = numFromEnv('ECHO_MAX_AI_PAYLOAD_CHARS', 200_000, { min: 1 });

/**
 * Pure sliding-window rate-limit check. Records a hit for `key` in `store`
 * (a Map<string, number[]> of hit timestamps) and reports whether that key
 * has exceeded `maxPerWindow` hits within the trailing `windowMs`.
 *
 * Mutates `store` in place: prunes timestamps older than the window, then
 * appends the current hit (`now`) — even when the limit is exceeded, so
 * callers can decide whether to still count rejected attempts (they do here,
 * which keeps a sustained-abuse client rate-limited rather than resetting).
 *
 * @param {string} key
 * @param {number} maxPerWindow
 * @param {number} windowMs
 * @param {Map<string, number[]>} store
 * @param {number} [now]
 * @returns {boolean} true if this hit exceeds the limit
 */
function rateLimitHit(key, maxPerWindow, windowMs, store, now = Date.now()) {
  const cutoff = now - windowMs;
  const existing = store.get(key) || [];
  const recent = existing.filter((ts) => ts > cutoff);
  recent.push(now);
  store.set(key, recent);
  return recent.length > maxPerWindow;
}

/**
 * Express middleware factory — NO-OP unless running in web mode. Keys by
 * req.ip, enforces `max` requests per `windowMs` per IP, and responds with
 * the structured error envelope at 429 when exceeded.
 *
 * @param {number} max
 * @param {number} windowMs
 * @returns {import('express').RequestHandler}
 */
// How often (ms) each webLimit() store is swept for fully-stale IP entries,
// to bound memory growth from the otherwise-never-shrinking Map of hits.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Removes entries from `store` whose most recent hit already fell outside
 * `windowMs` — i.e. keys with no timestamps left after pruning. Called
 * opportunistically (time-gated) rather than on every request, to keep the
 * hot path cheap.
 *
 * @param {Map<string, number[]>} store
 * @param {number} windowMs
 * @param {number} now
 */
function sweepStaleEntries(store, windowMs, now) {
  const cutoff = now - windowMs;
  for (const [key, timestamps] of store) {
    const hasRecent = timestamps.some((ts) => ts > cutoff);
    if (!hasRecent) store.delete(key);
  }
}

function webLimit(max, windowMs) {
  const store = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    if (!isWeb) return next();
    const now = Date.now();
    if (now - lastSweep > RATE_LIMIT_SWEEP_INTERVAL_MS) {
      lastSweep = now;
      sweepStaleEntries(store, windowMs, now);
    }
    const key = req.ip || 'unknown';
    if (rateLimitHit(key, max, windowMs, store)) {
      return sendError(
        res,
        'RATE_LIMITED',
        'Too many requests — please slow down.',
        `Limit is ${max} requests per ${Math.round(windowMs / 1000)}s. Try again shortly.`
      );
    }
    next();
  };
}

/**
 * Like webLimit, but applies in EVERY mode.
 *
 * webLimit exists to protect a hosted multi-tenant deployment and correctly
 * no-ops in local mode, where the only caller is the person at the keyboard.
 * Sign-in breaks that assumption: a local instance published over a tunnel is
 * reachable by anyone, and the thing being guessed is somebody else's Bluesky
 * app password. A limiter that switches itself off in the mode this instance
 * actually runs in would guard nothing.
 *
 * @param {number} max
 * @param {number} windowMs
 */
function alwaysLimit(max, windowMs) {
  const store = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > RATE_LIMIT_SWEEP_INTERVAL_MS) {
      lastSweep = now;
      sweepStaleEntries(store, windowMs, now);
    }
    if (rateLimitHit(req.ip || 'unknown', max, windowMs, store)) {
      return sendError(
        res,
        'RATE_LIMITED',
        'Too many sign-in attempts — please slow down.',
        `Limit is ${max} per ${Math.round(windowMs / 60_000)} minutes. Try again shortly.`
      );
    }
    next();
  };
}

/**
 * Guards AI endpoints in web mode against oversize payloads before they ever
 * reach digest.js. NO-OP in local mode (returns false). `text` and/or
 * `segments` may be passed; whichever is present is measured.
 *
 * @param {import('express').Response} res
 * @param {{ text?: string, segments?: Array<{text?:string}> }} payload
 * @returns {boolean} true if the response was already sent (caller must return)
 */
function rejectOversizeAiPayload(res, { text, segments } = {}) {
  if (!isWeb) return false;

  const textChars = typeof text === 'string' ? text.length : 0;
  const segChars = Array.isArray(segments)
    ? segments.reduce((sum, s) => sum + String(s?.text || '').length, 0)
    : 0;
  const totalChars = textChars + segChars;

  if (totalChars > ECHO_MAX_AI_PAYLOAD_CHARS) {
    sendError(
      res,
      'TRANSCRIPT_UNAVAILABLE',
      `Payload is too large (${totalChars} characters, limit is ${ECHO_MAX_AI_PAYLOAD_CHARS}).`,
      'This hosted instance caps AI request size. Try a shorter transcript, or run Echo locally for unlimited length.'
    );
    return true;
  }
  return false;
}

/**
 * Express middleware — blocks a route entirely in web mode with a 503.
 * NO-OP in local/desktop mode. Used to disable server-side library/search
 * routes in hosted web mode, where persistence lives client-side (IndexedDB)
 * and the server-side SQLite store must never be reachable by visitors.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function blockInWeb(req, res, next) {
  if (isWeb) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'This feature is not available in hosted web mode.',
      'Your library is stored in your browser.'
    );
  }
  next();
}

// Per-account budgets, defined here rather than beside the other account config
// because the route registrations below reference them at module-eval time and
// a `const` declared later would still be in its temporal dead zone.
//
// The defaults are deliberately generous: this is a backstop against one person
// running away with the operator's Claude quota, not a metering scheme.
const USER_DIGEST_LIMIT = numFromEnv('ECHO_USER_DIGEST_LIMIT', 30, { min: 1 });
const USER_FETCH_LIMIT = numFromEnv('ECHO_USER_FETCH_LIMIT', 90, { min: 1 });
const USER_LIMIT_WINDOW_MS = 60 * 60_000;

/**
 * Whose library is this request about?
 *
 * With no identity provider configured there is one person — the one at the
 * keyboard — and they get DEFAULT_OWNER, which is the original database file at
 * the original path. Nothing about a plain local install changes.
 *
 * With accounts on, every approved account gets its own library FILE. That is
 * why this returns an id rather than adding a filter: the isolation is the file
 * boundary, so a route that forgets to scope cannot leak anything — it simply
 * has no handle on anyone else's data. requireApproved has already run and set
 * echoUserId by the time any library route reaches this.
 *
 * @param {import('express').Request} req
 */
function libraryFor(req) {
  return forOwner(ACCOUNTS_ENABLED ? (req.echoUserId || DEFAULT_OWNER) : DEFAULT_OWNER);
}

/**
 * The access gate: only approved accounts may use the instance.
 *
 * NO-OPS ENTIRELY when no identity provider is configured, which is the default
 * everywhere. That is not a convenience — it is the hard constraint. A personal
 * local install must keep working exactly as it always has, with no sign-in and
 * no gate, and the only way to be sure of that is for this to return before it
 * touches anything.
 *
 * Once accounts ARE configured the gate is real, and it applies to anonymous
 * visitors too: an instance published over a tunnel is reachable by anyone, and
 * "signed out" is the state every stranger arrives in. The alternative — gating
 * only signed-in users — would leave the front door open and put a lock on the
 * inside of it.
 *
 * The refusal carries a machine-readable `reason` so the client can say
 * something useful (sign in / finish your request / it was declined) rather
 * than showing one generic error for four different situations.
 */
function requireApproved(req, res, next) {
  if (!ACCOUNTS_ENABLED) return next();

  const uid = sessionUserId(req);
  const user = uid ? getUser(uid) : null;

  if (!user) {
    return sendError(
      res,
      'API_NOT_AUTHED',
      'Sign in to use this Echo.',
      'Open Settings and sign in with your Bluesky handle.',
      401,
      { reason: 'signed_out' }
    );
  }

  if (user.status === 'approved') {
    req.echoUserId = uid;
    // Throttled to one write per user per 15 minutes — see touchLastSeen. A
    // write on every authorised request would put SQLite on the hot path of an
    // app that streams long transcripts.
    try { touchLastSeen(uid); } catch { /* never fail a request over telemetry */ }
    return next();
  }

  if (user.status === 'rejected') {
    return sendError(
      res,
      'API_NOT_AUTHED',
      'Your request for access was declined.',
      user.adminNote || '',
      403,
      { reason: 'rejected' }
    );
  }

  return sendError(
    res,
    'API_NOT_AUTHED',
    user.submitted ? 'Your request is still awaiting approval.' : 'Ask for access first.',
    user.submitted
      ? 'The admin has your request — nothing more to do for now.'
      : 'Open Settings and tell the admin why you would like access.',
    403,
    { reason: user.submitted ? 'pending' : 'unsubmitted' }
  );
}

/**
 * Per-ACCOUNT rate limit for the expensive paths.
 *
 * webLimit keys on IP, which is the right key for a hosted multi-tenant
 * deployment and the wrong one here: the resources being protected are the
 * operator's Claude quota and their residential IP's standing with YouTube, and
 * both are spent per person, not per address. Two approved users behind one NAT
 * should not share a budget, and one user on a phone plus a laptop should not
 * get two.
 *
 * Only enforced when accounts exist. With them off there is exactly one user —
 * the person at the keyboard — and rate-limiting them would be new behaviour in
 * a mode that must not change.
 *
 * @param {number} max
 * @param {number} windowMs
 */
function userLimit(max, windowMs) {
  const store = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    if (!ACCOUNTS_ENABLED) return next();

    const now = Date.now();
    if (now - lastSweep > RATE_LIMIT_SWEEP_INTERVAL_MS) {
      lastSweep = now;
      sweepStaleEntries(store, windowMs, now);
    }
    // requireApproved runs first and sets echoUserId; the IP fallback only
    // matters if this is ever mounted on its own.
    const key = req.echoUserId || `ip:${req.ip || 'unknown'}`;
    if (rateLimitHit(key, max, windowMs, store)) {
      return sendError(
        res,
        'RATE_LIMITED',
        'You have hit your limit for now.',
        `This Echo allows ${max} of these per ${Math.round(windowMs / 60_000)} minutes. Try again a bit later.`
      );
    }
    next();
  };
}

// ONE limiter instance per budget, shared across every route that spends it.
// Calling userLimit() separately at each route would give each its own store,
// so "90 fetches an hour" would silently become 90 transcripts AND 90 metadata
// lookups AND 90 language probes — three budgets wearing one number's name.
// What is being protected is the IP's standing with YouTube, and YouTube does
// not care which endpoint spent it.
const userFetchLimit = userLimit(USER_FETCH_LIMIT, USER_LIMIT_WINDOW_MS);
const userDigestLimit = userLimit(USER_DIGEST_LIMIT, USER_LIMIT_WINDOW_MS);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
// Unauthenticated, unrated-limited liveness check for container/proxy
// healthchecks (e.g. Docker HEALTHCHECK, load balancer probes). Works
// identically in local and web mode.

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mode: ECHO_MODE });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
// What the Settings and Options controls are BUILT from, so the browser never
// holds a second copy of these facts. A hardcoded <option> list in the markup
// would be a copy, and a copied list drifts silently — the lesson recorded
// twice in this codebase (extractSummary, and the duplicated reading controls).
//
// Unauthenticated on purpose, like /api/health: labels, model names and context
// sizes are not secrets, and the gate screens need no provider data. It carries
// no key material and no account information.
app.get('/api/providers', (_req, res) => {
  const available = publicProviderList({ isWeb });
  const list = available.map((p) => ({
    ...p,
    // The length at which THIS provider switches to map-reduce. Served rather
    // than recomputed in the browser because the client's progress message used
    // to carry its own hardcoded 480 000, which is only Claude's answer.
    longPathThresholdChars: thresholdCharsFor({ provider: p.id }),
  }));

  // The env-selected provider is not always ON OFFER — ECHO_PROVIDER=cli is
  // meaningless in web mode, where the list has no CLI. Falling back to the
  // first available entry keeps the client from being handed a default it
  // cannot select.
  const preferred = getProviderId({});
  const fallback = available[0] ? available[0].id : DEFAULT_PROVIDER_ID;
  const defaultId = list.some((p) => p.id === preferred) ? preferred : fallback;

  // defaultThinking is the operator's ECHO_THINKING, served so the picker starts
  // from it rather than overriding it by always sending its own idea of "off".
  res.json({ providers: list, default: defaultId, defaultThinking: getReasoningLevel({}) });
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

// Live Whisper progress, keyed by a client-supplied jobId. The POST /api/transcript
// handler updates the entry as yt-dlp downloads + whisper-cli transcribes; the SSE
// route below streams it to the browser. Entries self-expire shortly after the job
// ends so a late-connecting stream can still observe the terminal 'done'/'error'.
const whisperJobs = new Map();
function setJobProgress(jobId, data) {
  if (jobId) whisperJobs.set(jobId, { ...data, updatedAt: Date.now() });
}
function finishJob(jobId, status) {
  if (!jobId) return;
  const prev = whisperJobs.get(jobId) || {};
  whisperJobs.set(jobId, { ...prev, phase: status === 'done' ? 'done' : prev.phase, status, updatedAt: Date.now() });
  setTimeout(() => whisperJobs.delete(jobId), 15_000).unref?.();
}

// How often the job state is polled for a connected stream, and how often a
// comment heartbeat goes out while no job entry exists yet. Polling stays at
// 500 ms so the progress bar moves smoothly; the heartbeat is far slower
// because it carries no information — it only keeps the connection warm.
const PROGRESS_POLL_MS = 500;
const PROGRESS_PING_MS = 10_000;

// A stream holds an open socket and a repeating timer, so bound both dimensions.
// The cap is per-process and deliberately generous: one page holds exactly one
// stream and closes it as soon as its POST settles, so reaching this means
// something is looping, not that a user has too many tabs open.
const PROGRESS_MAX_STREAMS = 32;

// Absolute lifetime for a single stream. A client that vanishes without closing
// the socket (crashed tab, network dropped with no FIN) would otherwise hold its
// timer until the process restarts. A browser EventSource simply reconnects
// (`retry: 2000` below) and picks the job's state back up, so a genuinely
// long-running Whisper job is unaffected by being cut here.
const PROGRESS_MAX_STREAM_MS = 30 * 60_000;

let openProgressStreams = 0;

// SSE: stream a job's Whisper progress to the browser until it reaches a terminal
// status. No job entry yet → heartbeats (the POST may not have hit its first
// progress tick). blockInWeb because Whisper never runs in web mode — POST
// /api/transcript ignores `jobId` there and forces transcription off, so this
// route could only ever heartbeat at a hosted visitor, while still costing a
// socket and a timer per connection. Gating it removes that sink outright.
app.get('/api/transcript/progress', blockInWeb, requireApproved, (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) { res.status(400).end(); return; }

  if (openProgressStreams >= PROGRESS_MAX_STREAMS) {
    return sendError(
      res,
      'RATE_LIMITED',
      'Too many progress streams are already open.',
      'Close some Echo tabs, or wait for the running transcriptions to finish.'
    );
  }
  openProgressStreams++;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let done = false;
  let sinceLastPing = 0;

  // Single teardown path for every exit (terminal status, lifetime cap, client
  // disconnect), so the open-stream count can never drift. Idempotent: res.end()
  // re-enters this via the 'close' listener below.
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(iv);
    clearTimeout(maxTimer);
    openProgressStreams--;
    res.end();
  };

  const tick = () => {
    if (done) return;
    const st = whisperJobs.get(jobId);
    if (!st) {
      sinceLastPing += PROGRESS_POLL_MS;
      if (sinceLastPing >= PROGRESS_PING_MS) {
        sinceLastPing = 0;
        res.write(': ping\n\n');
      }
      return;
    }
    sinceLastPing = 0;
    res.write(`data: ${JSON.stringify({ phase: st.phase, pct: st.pct ?? 0, status: st.status || 'running' })}\n\n`);
    if (st.status && st.status !== 'running') finish();
  };

  const iv = setInterval(tick, PROGRESS_POLL_MS);
  const maxTimer = setTimeout(finish, PROGRESS_MAX_STREAM_MS);
  tick();

  // Listen on `res`, not `req`: for a GET there is no request body whose end
  // could be confused with a disconnect, and res 'close' is the signal that
  // covers both a vanished client and our own res.end().
  res.on('close', finish);
});

app.post('/api/transcript', requireApproved, userFetchLimit, webLimit(20, 60_000), async (req, res) => {
  const { url, lang, transcribe, whisperModel } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }

  // Cancel the (potentially long, CPU-heavy) transcription if the client goes
  // away — e.g. the user closes the tab or navigates off. Without this, the
  // yt-dlp audio download and the whisper-cli process keep running to
  // completion server-side, pinning the CPU long after nobody is waiting.
  // NB: listen on `res`, not `req` — req 'close' fires as soon as the POST
  // body is consumed, which would abort the job the instant it started.
  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  // Optional live-progress channel: the client sends a jobId and subscribes to
  // GET /api/transcript/progress?jobId=… . Only meaningful when Whisper runs.
  const jobId = (!isWeb && typeof req.body.jobId === 'string' && req.body.jobId) ? req.body.jobId : null;
  // First entry is created by the first real progress tick (only when Whisper
  // actually runs) — so caption-only fetches never flash a progress card.
  const onProgress = jobId
    // Spread rather than destructure: the pipeline attaches extra fields to
    // some phases (which model it switched to, and why), and a fixed
    // {phase, pct} shape would silently drop them before the SSE channel.
    ? (p) => setJobProgress(jobId, { ...p, status: 'running' })
    : undefined;

  const t0 = Date.now();
  try {
    // Whisper is local/desktop only; force it off in web mode regardless of the body.
    const whisperMode = isWeb ? 'off' : (transcribe || 'fallback');
    const segments = await fetchTranscript(videoId, { lang, transcribe: whisperMode, modelName: whisperModel, signal: ac.signal, onProgress });
    const { title, channel, channelUrl } = await getVideoMeta(videoId);
    // `langUsed` is stamped onto the segments array by fetchTranscript() and
    // reflects the caption track actually loaded (not just what was asked
    // for) — the language picker uses this to pre-select the right option.
    const langCode = segments.langUsed || lang || null;

    if (isWeb) {
      const totalChars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
      if (totalChars > ECHO_MAX_TRANSCRIPT_CHARS) {
        return sendError(
          res,
          'TRANSCRIPT_UNAVAILABLE',
          `Transcript is too long (${totalChars} characters, limit is ${ECHO_MAX_TRANSCRIPT_CHARS}).`,
          'This hosted instance caps transcript length. Try a shorter video, or run Echo locally for unlimited length.'
        );
      }
    }

    const chars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
    logEvent('transcript', { videoId, chars, langCode, ok: true, ms: Date.now() - t0 });
    finishJob(jobId, 'done');
    const transcriptSource = segments.source || 'captions';
    // `modelUsed` is stamped by the whisper pipeline and can differ from the
    // model the client asked for: a non-English video on `base` is upgraded to
    // `small`, which `base` transcribes badly (see WHISPER.md). Reporting it
    // means the library records what actually ran, not what was requested.
    return res.json({
      videoId, url: req.body.url, title, channel, channelUrl, segments, langCode, transcriptSource,
      whisperModel: segments.modelUsed || null,
    });
  } catch (err) {
    // Client already disconnected — the abort we triggered surfaces here; there
    // is no live response to write to, so just record it and stop.
    if (clientGone) {
      logEvent('transcript', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return;
    }
    logEvent('transcript', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    finishJob(jobId, 'error');
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Local media transcription (local/desktop only)
// ---------------------------------------------------------------------------
// The same Whisper stage the YouTube path uses, pointed at a file the user
// supplies: a podcast download, a lecture recording, a meeting capture. This is
// the one route that isn't about YouTube at all.
//
// The body is the raw file bytes rather than multipart/form-data, which is why
// there is no upload dependency here: the browser can `fetch(url, {body: file})`
// a File object directly, and express.raw() hands us a Buffer. The filename
// rides in a query param because a raw body has nowhere else to put it.

// Cap on an uploaded file. Generous — an hour of lecture video is easily 500 MB
// — but bounded, since this writes to the machine's temp dir.
const ECHO_MAX_UPLOAD_BYTES = numFromEnv('ECHO_MAX_UPLOAD_BYTES', 2_000_000_000, { min: 1 });

/**
 * Synthetic, stable id for a local file so it can live in the same library as
 * YouTube entries without a schema change. Derived from name + size + content
 * length so re-uploading the same file updates its entry instead of duplicating
 * it. Shaped to satisfy vault.js's `^[A-Za-z0-9_-]{1,20}$` filename guard.
 *
 * @param {string} name
 * @param {Buffer} buf
 * @returns {string}
 */
function localMediaId(name, buf) {
  const hash = createHash('sha256')
    .update(String(name || ''))
    .update(String(buf.length))
    // Hash a bounded slice, not the whole file: a 500 MB hash costs seconds and
    // buys nothing here — name + size + head + tail is plenty to tell two
    // uploads apart.
    .update(buf.subarray(0, 1 << 20))
    .update(buf.subarray(Math.max(0, buf.length - (1 << 20))))
    .digest('hex');
  return `file_${hash.slice(0, 14)}`;
}

app.post(
  '/api/transcript/file',
  blockInWeb,
  requireApproved,
  userFetchLimit,
  express.raw({ type: '*/*', limit: ECHO_MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const rawName = typeof req.query.name === 'string' ? req.query.name : '';
    // Only ever used as a display title and as hash input — never as a path.
    const displayName = rawName.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || 'Untitled recording';
    const ext = (displayName.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return sendError(res, 'INTERNAL', 'No file was uploaded.', 'Choose an audio or video file.', 400);
    }
    if (ext && !LOCAL_MEDIA_EXTENSIONS.has(ext)) {
      return sendError(
        res,
        'INTERNAL',
        `Unsupported file type: ${ext}`,
        'Echo reads audio and video files — mp3, m4a, wav, flac, ogg, mp4, mov, mkv, webm and similar.',
        400
      );
    }

    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) { clientGone = true; ac.abort(); }
    });

    const jobId = (typeof req.query.jobId === 'string' && req.query.jobId) ? req.query.jobId : null;
    const onProgress = jobId
      ? (p) => setJobProgress(jobId, { ...p, status: 'running' })
      : undefined;

    const t0 = Date.now();
    const videoId = localMediaId(displayName, req.body);
    // Written to the OS temp dir under a generated name, never under anything
    // derived from the upload's own filename.
    const tmpPath = join(tmpdir(), `echo-upload-${videoId}${ext}`);

    try {
      await writeFile(tmpPath, req.body);
      const segments = await transcribeFile(tmpPath, {
        modelName: typeof req.query.whisperModel === 'string' ? req.query.whisperModel : undefined,
        signal: ac.signal,
        onProgress,
      });

      const chars = segments.reduce((sum, s) => sum + String(s.text || '').length, 0);
      logEvent('transcript-file', { videoId, chars, bytes: req.body.length, ok: true, ms: Date.now() - t0 });
      finishJob(jobId, 'done');

      // Same envelope the YouTube path returns, so the frontend renders it with
      // the same code. `url` is empty: there is nowhere to link back to.
      return res.json({
        videoId,
        url: '',
        title: displayName.replace(/\.[A-Za-z0-9]+$/, ''),
        channel: null,
        channelUrl: null,
        segments,
        langCode: segments.langUsed || null,
        transcriptSource: 'whisper',
        localFile: true,
      });
    } catch (err) {
      if (clientGone) {
        logEvent('transcript-file', { videoId, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
        finishJob(jobId, 'error');
        return;
      }
      logEvent('transcript-file', { videoId, ok: false, err: errLabel(err), ms: Date.now() - t0 });
      finishJob(jobId, 'error');
      return sendCaughtError(res, err);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }
);

// --- Whisper model management (local/desktop only) ---
app.get('/api/whisper/status', blockInWeb, requireApproved, (req, res) => {
  const binaryPresent = !!resolveWhisperBinary();
  const models = Object.keys(WHISPER_MODELS).map((n) => {
    const m = WHISPER_MODELS[n];
    return { name: m.name, label: m.label, sizeBytes: m.sizeBytes, ...downloadState(n) };
  });
  return res.json({ binaryPresent, defaultModel: DEFAULT_WHISPER_MODEL, cacheDir: modelCacheDir(), models });
});

app.post('/api/whisper/model', blockInWeb, requireApproved, (req, res) => {
  const { model } = req.body || {};
  if (!model || !WHISPER_MODELS[model]) {
    return sendError(res, 'WHISPER_MODEL_UNKNOWN', `Unknown model: ${model}`, 'Choose base or small.');
  }
  try {
    startModelDownload(model);
    return res.json(downloadState(model));
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

app.get('/api/languages', requireApproved, userFetchLimit, webLimit(20, 60_000), async (req, res) => {
  const { videoId: rawId } = req.query;
  if (!rawId) {
    return sendError(res, 'INTERNAL', 'videoId query parameter is required.', '', 400);
  }
  const videoId = extractVideoId(rawId);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }
  try {
    const tracks = await listCaptionTracks(videoId);
    return res.json({ tracks });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Video meta (lightweight, keyless oEmbed lookup — used to backfill channel
// info on saved library entries created before channelUrl was stored)
// ---------------------------------------------------------------------------

app.get('/api/video-meta', requireApproved, userFetchLimit, webLimit(20, 60_000), async (req, res) => {
  const { videoId: rawId, url: rawUrl } = req.query;
  const videoId = extractVideoId(rawId || rawUrl);
  if (!videoId) {
    return sendError(
      res,
      'INVALID_URL',
      'Could not find a valid YouTube video ID in that URL.',
      'Paste a full YouTube URL (e.g. youtube.com/watch?v=…) or an 11-character video ID.'
    );
  }
  try {
    const { title, channel, channelUrl } = await getVideoMeta(videoId);
    return res.json({ videoId, title, channel, channelUrl });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

// Auto-tagging must never delay or break the digest response. It runs in
// parallel with generateDigest() (on the raw transcript text, same input the
// digest itself reads, so there's no extra serialization cost) under its own
// try/catch + bounded timeout — any failure, timeout, or missing tags just
// resolves to an empty array. See CLAUDE.md "never break the digest path".
const AUTO_TAG_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function suggestTagsBestEffort(text, { apiKey, provider, language, videoId, signal } = {}) {
  const t0 = Date.now();
  try {
    // reasoning: 'off' is set HERE rather than plumbed from the request, on
    // purpose. Tagging is metadata extraction, not a reasoning task — the prompt
    // is capped at 6 000 chars precisely to keep it cheap — and threading the
    // user's thinking level through would spend reasoning tokens per save while
    // also letting an API's DEFAULT decide the shape of a call we want to be
    // deterministic. Setting it in the one place that makes the call means it
    // cannot be forgotten at a call site.
    const result = await withTimeout(
      suggestTags(text, { apiKey, provider, language, signal, reasoning: 'off' }),
      AUTO_TAG_TIMEOUT_MS
    );
    logEvent('tags-suggest', {
      videoId: videoId || null,
      chars: (text || '').length,
      tagCount: Array.isArray(result.tags) ? result.tags.length : 0,
      costUsd: result.usage && result.usage.costUsd,
      ok: true, ms: Date.now() - t0,
    });
    return Array.isArray(result.tags) ? result.tags : [];
  } catch (err) {
    logEvent('tags-suggest', { videoId: videoId || null, chars: (text || '').length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return [];
  }
}

/**
 * Server-sent-events transport for a digest.
 *
 * Opened only when the client asks for it (`?stream=1`), because the JSON shape
 * is what the Obsidian plugin and every other caller expect, and because a
 * provider that cannot stream should degrade to exactly the behaviour it had.
 *
 * Four event types:
 *   phase  — map-reduce progress, before any digest text exists
 *   token  — a chunk of digest text
 *   done   — the full JSON payload the non-streaming route returns
 *   error  — the same structured envelope, since headers are already sent by
 *            the time most failures happen and a 500 is no longer available
 *
 * The last point is the one that shapes the client: an SSE response is a 200
 * the moment it opens, so a failure has to arrive as a message rather than a
 * status. The client renders it through the same classified error card.
 */
function openDigestStream(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends will happily sit on an un-flushed proxy buffer and
    // hand the client the whole "stream" at the end, which looks exactly like
    // streaming being broken.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let open = true;
  res.on('close', () => { open = false; });

  return {
    get open() { return open; },
    send(event, data) {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!open) return;
      open = false;
      res.end();
    },
  };
}

app.post('/api/digest', requireApproved, userDigestLimit, webLimit(20, 60_000), async (req, res) => {
  const { text, length, format, language, title, videoId } = req.body;

  if (!requireText(res, text, 'No transcript text provided.', 'Load a transcript before generating a digest.')) return;

  if (rejectOversizeAiPayload(res, { text })) return;
  if (requireWebKey(req, res)) return;

  const prov = providerRequest(req);
  if (prov.invalid) {
    return sendError(
      res,
      'PROVIDER_UNKNOWN',
      `Unknown provider "${prov.raw}".`,
      'Pick a provider in Options.',
      400
    );
  }
  if (prov.reasoningInvalid) {
    return sendError(
      res,
      'THINKING_INVALID',
      `Unknown thinking level "${prov.rawReasoning}".`,
      'Use off, low, medium or high.',
      400
    );
  }
  const providerId = getProviderId(prov);

  // Cancel the digest (and its best-effort auto-tagging sibling — it spends
  // real tokens too) if the client goes away, e.g. the user hits Stop or
  // closes the tab mid-digest. Without this the `claude` spawn / Anthropic
  // API call keeps running to completion server-side for nobody.
  // NB: listen on `res`, not `req` — see the /api/transcript comment for why
  // (req 'close' fires as soon as the POST body is consumed).
  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  const wantsStream = req.query.stream === '1' || req.query.stream === 'true';
  if (wantsStream) {
    return digestStreaming(req, res, {
      text, length, format, language, title, videoId, signal: ac.signal,
      provider: prov.provider, apiKey: prov.apiKey, reasoning: prov.reasoning,
    });
  }

  const t0 = Date.now();
  const { apiKey } = prov;
  try {
    const [result, suggestedTags] = await Promise.all([
      generateDigest(text, { length, format, language, title, apiKey, provider: prov.provider, reasoning: prov.reasoning, signal: ac.signal }),
      suggestTagsBestEffort(text, { apiKey, provider: prov.provider, language, videoId, signal: ac.signal }),
    ]);
    logEvent('digest', {
      videoId: videoId || null,
      chars: (text || '').length,
      length, format, language,
      strategy: result.strategy,
      // Which provider actually ran, not a hardcoded 'sonnet'. The usage meter
      // is the only place a provider comparison can be read off after the fact,
      // so it has to be true.
      provider: providerId,
      model: getProviderLimits(prov).defaultModel,
      // Logged because two runs of the same video on the same provider are not
      // comparable if one of them reasoned first.
      thinking: getReasoningLevel(prov),
      truncated: Boolean(result.truncated),
      costUsd: result.usage && result.usage.costUsd,
      tokIn: result.usage && result.usage.inputTokens,
      tokOut: result.usage && result.usage.outputTokens,
      ok: true, ms: Date.now() - t0,
    });
    return res.json({ ...result, suggestedTags });
  } catch (err) {
    // Client already disconnected — the abort we triggered surfaces here; there
    // is no live response to write to, so just record it and stop.
    if (clientGone) {
      logEvent('digest', { videoId: videoId || null, chars: (text || '').length, length, format, ok: false, err: 'client_aborted', ms: Date.now() - t0 });
      return;
    }
    logEvent('digest', { videoId: videoId || null, chars: (text || '').length, length, format, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

/**
 * The streaming half of POST /api/digest.
 *
 * Mirrors the JSON route exactly — same generateDigest call, same concurrent
 * best-effort tagging, same usage log — and differs only in delivery. The
 * `done` event carries the identical payload, so a client can treat streaming
 * as a progressive rendering of a response it already knows how to handle.
 *
 * `signal` is the caller's AbortController.signal, wired to `res.on('close')`
 * one level up (so it fires on Stop / tab-close / navigation exactly like the
 * JSON path). Cancellation is detected here via `!stream.open` rather than a
 * separate flag: openDigestStream() already tracks its own `res` 'close'
 * listener for that, and stream.send()/stream.end() are no-ops once closed —
 * so an abort mid-stream can never attempt to write to the dead socket.
 */
async function digestStreaming(req, res, { text, length, format, language, title, videoId, signal, provider, apiKey, reasoning }) {
  const t0 = Date.now();
  // Both come from the route, which already resolved and validated them — so
  // the streamed and buffered paths cannot disagree about which provider is
  // running, which is the whole point of doing the resolution once.
  const providerId = getProviderId({ provider, apiKey });
  const stream = openDigestStream(res);

  try {
    const [result, suggestedTags] = await Promise.all([
      generateDigest(text, {
        length, format, language, title, apiKey, provider, reasoning, signal,
        onToken: (chunk) => stream.send('token', { text: chunk }),
        onPhase: (info) => stream.send('phase', info),
      }),
      suggestTagsBestEffort(text, { apiKey, provider, language, videoId, signal }),
    ]);

    logEvent('digest', {
      videoId: videoId || null,
      chars: (text || '').length,
      length, format, language,
      strategy: result.strategy,
      provider: providerId,
      model: getProviderLimits({ provider, apiKey }).defaultModel,
      thinking: getReasoningLevel({ provider, reasoning }),
      truncated: Boolean(result.truncated),
      streamed: true,
      costUsd: result.usage && result.usage.costUsd,
      tokIn: result.usage && result.usage.inputTokens,
      tokOut: result.usage && result.usage.outputTokens,
      ok: true, ms: Date.now() - t0,
    });

    stream.send('done', { ...result, suggestedTags });
    stream.end();
  } catch (err) {
    // Client already disconnected — the abort we triggered surfaces here as
    // the rejection; there is no live SSE connection to send an `error` event
    // to (stream.send()/end() would already be no-ops), so just record it.
    if (!stream.open) {
      logEvent('digest', {
        videoId: videoId || null, chars: (text || '').length, length, format,
        provider: providerId, streamed: true, ok: false, err: 'client_aborted', ms: Date.now() - t0,
      });
      return;
    }

    logEvent('digest', {
      videoId: videoId || null, chars: (text || '').length, length, format,
      provider: providerId, streamed: true, ok: false, err: errLabel(err), ms: Date.now() - t0,
    });

    // Same envelope sendError builds, delivered as an event because the 200 is
    // already on the wire.
    const code = err && err.echoCode ? err.echoCode : 'INTERNAL';
    const payload = {
      code,
      message: (err && err.message) || 'Digest failed.',
      hint: (err && err.hint) || '',
    };
    if (err && err.detail) payload.detail = err.detail;
    console.error(`[echo] ${code}: ${payload.message}`);

    stream.send('error', { error: payload });
    stream.end();
  }
}

// ---------------------------------------------------------------------------
// Key validation (web mode only)
// ---------------------------------------------------------------------------
// Lets the Settings UI validate a candidate Anthropic API key immediately
// (via a cheap, token-free models.list() call) instead of the user only
// finding out it's invalid on their first AI call.

app.post('/api/validate-key', requireApproved, webLimit(20, 60_000), async (req, res) => {
  const prov = providerRequest(req);

  if (prov.invalid) {
    return sendError(
      res,
      'PROVIDER_UNKNOWN',
      `Unknown provider "${prov.raw}".`,
      'Pick a provider in Options.',
      400
    );
  }

  // Key validation is meaningful wherever a BYOK key can be used. That used to
  // mean web/desktop only; a named provider makes it meaningful in local mode
  // too (see readApiKey), and refusing there would leave the mode this app is
  // actually run in unable to validate the key it just accepted.
  if (!isWeb && !isDesktop && !prov.named) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Key validation is only available when using your own API key.',
      ''
    );
  }

  const { apiKey } = prov;
  if (!apiKey) {
    return sendError(res, 'API_NOT_AUTHED', 'No API key provided.', 'Enter your API key in Settings.');
  }

  try {
    const result = await validateApiKey(apiKey, prov.provider);
    return res.json(result);
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Accounts + library sync (web mode only, and only when configured)
// ---------------------------------------------------------------------------
// Sign in with Google so a library follows you between devices. Everything here
// is off unless all three env vars below are set, so a deployment that does not
// want accounts gets exactly today's behaviour and never creates a database.
//
// What is NOT here, on purpose: no password storage, no sessions table, no
// refresh tokens, and no API keys. Signing in does not change where an
// Anthropic key lives — it stays in the browser and rides per-request in
// X-Echo-Api-Key, so the promise that the server never sees a key survives
// accounts intact.

const GOOGLE_CLIENT_ID = process.env.ECHO_GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.ECHO_GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.ECHO_SESSION_SECRET || '';
const SYNC_DB_PATH = process.env.ECHO_SYNC_DB_PATH || '/data/echo-sync.db';

// Public origin, needed to build the OAuth redirect_uri Google will match
// against its allow-list. Falls back to the request's own origin.
const PUBLIC_URL = (process.env.ECHO_PUBLIC_URL || '').replace(/\/+$/, '');

const AUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && SESSION_SECRET);

// Sign in with Bluesky. Config-gated exactly like the Google path and entirely
// independent of it: with these unset — the default everywhere — there is no
// sign-in route, no database file and no behaviour change of any kind, which is
// what keeps local mode's promise intact.
//
// ECHO_ATPROTO_SECRET is separate from ECHO_SESSION_SECRET because it protects
// something categorically different: session cookies are Echo's own and expire,
// while these seal other people's Bluesky refresh tokens. Rotating one should
// not have to mean rotating the other.
const ATPROTO_SECRET = process.env.ECHO_ATPROTO_SECRET || '';
const ATPROTO_ENABLED = Boolean(
  /^(1|true|yes)$/i.test(process.env.ECHO_ATPROTO_ENABLED || '') && SESSION_SECRET && ATPROTO_SECRET
);
const ATPROTO_KEY = ATPROTO_ENABLED ? deriveKey(ATPROTO_SECRET) : null;

// Sign-in attempts per IP. Bluesky's own ceiling is 30 per 5 minutes per
// ACCOUNT; this is the per-caller half, so one IP cannot walk a list of handles
// and burn every one of their rate limits for them.
const ATPROTO_SIGNIN_LIMIT = numFromEnv('ECHO_ATPROTO_SIGNIN_LIMIT', 10, { min: 1 });

/** Either provider being configured means accounts exist on this instance. */
const ACCOUNTS_ENABLED = AUTH_ENABLED || ATPROTO_ENABLED;

// Mirroring a library into its owner's own atproto repository (ATPROTO.md
// Phase 5). Off unless Bluesky sign-in is on, because it is the same
// credentials — and off in web mode, where there is no server-side library to
// mirror in the first place.
const PDS_SYNC_ENABLED = ATPROTO_ENABLED && !isWeb
  && /^(1|true|yes)$/i.test(process.env.ECHO_PDS_SYNC || '');

const pdsSync = PDS_SYNC_ENABLED
  ? createPdsSync({
    getTokens: (userId) => getAtprotoTokens(userId),
    saveTokens: ({ userId, did, pdsUrl, refreshJwt }) => saveAtprotoTokens({ userId, did, pdsUrl, refreshJwt }),
    seal: (plain) => encryptSecret(plain, ATPROTO_KEY),
    open: (blob) => decryptSecret(blob, ATPROTO_KEY),
  })
  : null;

/**
 * Mirror a library change into the owner's repository, in the background.
 *
 * Deliberately NOT awaited by the routes. Saving a video must not get slower,
 * or fail, because someone else's PDS is slow or down — the library write has
 * already succeeded and is the thing the user asked for. A failure here is
 * logged and the next save re-pushes, because putRecord is idempotent on the
 * video id.
 *
 * @param {string|null} userId
 * @param {'push'|'remove'} action
 * @param {object|string} payload an entry to push, or a videoId to remove
 */
/**
 * Entries that must NEVER leave this machine, whatever the account says.
 *
 * Local media gets a synthetic `file_<hash>` id — the feature's own docs say
 * "podcast, lecture, meeting". Publishing a recording someone made of a private
 * conversation is a different order of harm from publishing which YouTube talk
 * they watched, and no toggle buried in a settings panel is informed consent
 * for it. There is deliberately no override.
 *
 * @param {string} videoId
 */
function neverMirror(videoId) {
  return String(videoId || '').startsWith('file_');
}

function mirrorToPds(userId, action, payload) {
  if (!pdsSync || !userId || userId === DEFAULT_OWNER) return;

  const videoId = action === 'push' ? payload.videoId : payload;
  if (neverMirror(videoId)) return;

  // Per-account, and read fresh on every write rather than cached: switching it
  // off has to take effect on the very next save, not whenever a cache expires.
  if (!getPdsSync(userId)) return;
  const run = action === 'push'
    // Re-read the entry rather than mirroring the request body: the stored
    // entry is the canonical one — it carries the tags, the normalised URL and
    // the updatedAt the client never sent.
    ? payload.lib.getEntry(payload.videoId).then((entry) => (
      entry ? pdsSync.pushEntry(userId, entry) : { ok: false, reason: 'gone' }
    ))
    : pdsSync.removeEntry(userId, payload);

  run.then((r) => {
    if (r && r.ok === false && r.reason !== 'no_credentials') {
      console.warn(`[echo] pds ${action} skipped: ${r.reason}`);
    }
  }).catch((err) => {
    console.warn(`[echo] pds ${action} failed: ${err?.message || err}`);
  });
}

// Who may approve people. Comma-separated DIDs — the operator's own Bluesky
// account(s). Held in the environment rather than a database flag so that no
// sequence of requests can promote anyone: becoming an admin requires access to
// the machine, which is the property that makes the approval gate worth having.
const ADMIN_DIDS = new Set(
  (process.env.ECHO_ADMIN_DIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** @param {{did?: string}|null} user */
function isAdmin(user) {
  return Boolean(user && user.did && ADMIN_DIDS.has(user.did));
}

// An approval queue with no approver is a locked door with no key: every
// Bluesky account would sit at 'pending' forever, including the operator's.
// Loud at boot, because the symptom otherwise is "sign-in works but nothing
// does", which reads as a bug rather than as missing configuration.
if (ATPROTO_ENABLED && ADMIN_DIDS.size === 0) {
  console.warn(
    '[echo] Bluesky sign-in is on but ECHO_ADMIN_DIDS is empty — nobody can approve '
    + 'anyone, so every account will stay pending. Set it to your own DID.'
  );
}

// Per-user storage ceiling. A synced library is transcripts, which are text but
// not small; this keeps one account from filling the volume.
const ECHO_MAX_SYNC_BYTES = numFromEnv('ECHO_MAX_SYNC_BYTES', 100_000_000, { min: 1 });

if (ACCOUNTS_ENABLED) openSyncDb(SYNC_DB_PATH);

function redirectUri(req) {
  const origin = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/auth/callback`;
}

/** Blocks a route unless SOME identity provider is configured. */
function requireAuthConfigured(req, res, next) {
  if (!ACCOUNTS_ENABLED) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Accounts are not enabled on this instance.',
      'Your library is stored in this browser. Set ECHO_SESSION_SECRET plus either the ECHO_GOOGLE_* pair or ECHO_ATPROTO_ENABLED + ECHO_ATPROTO_SECRET to enable sign-in.'
    );
  }
  next();
}

/** Blocks the Google-specific routes, which need Google's own credentials. */
function requireGoogleConfigured(req, res, next) {
  if (!AUTH_ENABLED) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Google sign-in is not enabled on this instance.',
      'Set ECHO_GOOGLE_CLIENT_ID, ECHO_GOOGLE_CLIENT_SECRET and ECHO_SESSION_SECRET to enable it.'
    );
  }
  next();
}

/** Blocks the Bluesky routes when that provider is not configured. */
function requireAtprotoConfigured(req, res, next) {
  if (!ATPROTO_ENABLED) {
    return sendError(
      res,
      'WEB_MODE_UNSUPPORTED',
      'Bluesky sign-in is not enabled on this instance.',
      'Set ECHO_ATPROTO_ENABLED=1, ECHO_ATPROTO_SECRET and ECHO_SESSION_SECRET to enable it.'
    );
  }
  next();
}

/**
 * The signed-in user id, or null.
 *
 * The signature proves the cookie is ours and unexpired; `tv` then proves it
 * has not been revoked. Without that second check a stateless session cannot
 * be ended early — which is the whole cost of having no sessions table, and
 * one integer buys it back.
 */
function sessionUserId(req) {
  if (!ACCOUNTS_ENABLED) return null;
  const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
  const payload = verifyToken(token, SESSION_SECRET);
  if (!payload || !payload.uid) return null;

  const user = getUser(String(payload.uid));
  if (!user) return null;
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) return null;
  return user.id;
}

/** Guards the sync routes: 401 rather than silently syncing nothing. */
function requireSession(req, res, next) {
  const uid = sessionUserId(req);
  if (!uid) {
    return sendError(res, 'API_NOT_AUTHED', 'Sign in to sync your library.', 'Sign in to use sync.', 401);
  }
  req.echoUserId = uid;
  next();
}

/**
 * Guards the admin routes.
 *
 * Deliberately answers 404 rather than 403 to a signed-in non-admin: a 403
 * confirms the route exists and that admins exist, which is a small thing to
 * hand someone probing an instance. The admin already knows where it is.
 */
function requireAdmin(req, res, next) {
  const uid = sessionUserId(req);
  const user = uid ? getUser(uid) : null;
  if (!isAdmin(user)) {
    return sendError(res, 'NOT_FOUND', 'Not found.', '', 404);
  }
  req.echoUserId = uid;
  req.echoAdminDid = user.did;
  next();
}

app.get('/api/auth/google', requireGoogleConfigured, (req, res) => {
  const state = randomToken();
  const verifier = randomToken();

  // state + PKCE verifier ride in a short-lived signed cookie rather than in
  // server memory, so sign-in survives a restart and needs no shared store if
  // the deployment ever runs more than one machine.
  const tx = signToken({ state, verifier, exp: Date.now() + OAUTH_TTL_MS }, SESSION_SECRET);
  res.set('Set-Cookie', serializeCookie(OAUTH_COOKIE, tx, { maxAgeMs: OAUTH_TTL_MS, secure: SECURE_COOKIES }));

  return res.redirect(buildGoogleAuthUrl({
    clientId: GOOGLE_CLIENT_ID,
    redirectUri: redirectUri(req),
    state,
    codeChallenge: pkceChallenge(verifier),
  }));
});

app.get('/api/auth/callback', requireGoogleConfigured, async (req, res) => {
  const fail = (why) => {
    console.error(`[echo] sign-in failed: ${why}`);
    // Back to the app with a flag rather than a bare error page — the UI can
    // say "sign-in didn't complete" in its own voice.
    res.set('Set-Cookie', serializeCookie(OAUTH_COOKIE, '', { maxAgeMs: 0, secure: SECURE_COOKIES }));
    return res.redirect('/?signin=failed');
  };

  const tx = verifyToken(parseCookies(req.get('cookie'))[OAUTH_COOKIE], SESSION_SECRET);
  if (!tx) return fail('missing or expired transaction cookie');
  // CSRF: the state we handed Google must be the state coming back.
  if (!req.query.state || req.query.state !== tx.state) return fail('state mismatch');
  if (!req.query.code) return fail(`no code (${req.query.error || 'unknown'})`);

  try {
    const tokens = await exchangeCode({
      code: String(req.query.code),
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(req),
      codeVerifier: tx.verifier,
    });

    const payload = decodeIdToken(tokens.id_token);
    const check = validateIdTokenPayload(payload, GOOGLE_CLIENT_ID);
    if (!check.ok) return fail(`id token rejected (${check.reason})`);

    const user = upsertUser({ sub: check.sub, email: check.email });
    const session = signToken({
      uid: user.id,
      tv: user.tokenVersion || 0,
      exp: Date.now() + SESSION_TTL_MS,
    }, SESSION_SECRET);

    res.set('Set-Cookie', [
      serializeCookie(SESSION_COOKIE, session, { maxAgeMs: SESSION_TTL_MS, secure: SECURE_COOKIES }),
      serializeCookie(OAUTH_COOKIE, '', { maxAgeMs: 0, secure: SECURE_COOKIES }),
    ]);
    logEvent('signin', { ok: true });
    return res.redirect('/?signin=ok');
  } catch (err) {
    return fail(err.message);
  }
});

/**
 * Sign in with Bluesky.
 *
 * One POST rather than a redirect pair: there is no third-party consent screen
 * on this path, so there is nothing to redirect to. The app password is used
 * once — resolve the account, exchange it for tokens — and is never written
 * anywhere, not to the database, not to the log, and not into an error detail.
 * What survives the request is a sealed refresh token.
 */
app.post('/api/auth/atproto', requireAtprotoConfigured, alwaysLimit(ATPROTO_SIGNIN_LIMIT, 5 * 60_000), async (req, res) => {
  const identifier = String(req.body?.identifier || '');
  const password = String(req.body?.password || '');

  try {
    const { did, pdsUrl } = await resolveAccount(identifier);
    const session = await atprotoCreateSession({ pdsUrl, identifier: did, password });

    const user = upsertAtprotoUser({ did: session.did, handle: session.handle });

    // An admin never waits in their own queue. Without this, the first sign-in
    // on a fresh instance lands the operator in 'pending' with nobody able to
    // approve them — the gate locked from the inside.
    if (isAdmin({ did: session.did })) {
      setStatus(user.id, 'approved');

      // The operator's pre-accounts library becomes theirs, once. Without this,
      // switching accounts on looks exactly like data loss: they sign in, get a
      // brand-new empty library, and everything they ever saved is sitting in
      // the default owner's file with nothing left to show it to them.
      // No-op in web mode, where the whole library layer is blockInWeb'd.
      if (!isWeb) {
        try {
          const adopted = adoptDefaultLibrary(user.id);
          if (adopted.adopted) console.log(`[echo] moved the existing library to @${session.handle}`);
        } catch (err) {
          console.error(`[echo] could not adopt the existing library: ${err.message}`);
        }
      }
    }

    // Persisted before the cookie is issued: a session the server cannot act
    // through later is worse than a sign-in that visibly failed.
    saveAtprotoTokens({
      userId: user.id,
      did: session.did,
      pdsUrl,
      refreshJwt: encryptSecret(session.refreshJwt, ATPROTO_KEY),
    });

    const cookie = signToken({
      uid: user.id,
      tv: user.tokenVersion || 0,
      exp: Date.now() + SESSION_TTL_MS,
    }, SESSION_SECRET);
    res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, cookie, { maxAgeMs: SESSION_TTL_MS, secure: SECURE_COOKIES }));

    logEvent('signin', { ok: true, provider: 'atproto' });
    return res.json({ ok: true, user: { provider: 'atproto', did: session.did, handle: session.handle } });
  } catch (err) {
    logEvent('signin', { ok: false, provider: 'atproto', err: errLabel(err) });
    return sendError(
      res,
      err?.echoCode || 'API_FAILED',
      err?.message || 'Sign-in failed.',
      err?.hint || '',
      err?.status || 502,
      err?.detail ? { detail: err.detail } : {}
    );
  }
});

app.get('/api/auth/me', (req, res) => {
  // `providers` is additive: existing clients read `enabled` and `user.email`,
  // both of which still mean what they always did.
  const providers = { google: AUTH_ENABLED, atproto: ATPROTO_ENABLED };
  if (!ACCOUNTS_ENABLED) return res.json({ enabled: false, providers, user: null });

  const uid = sessionUserId(req);
  if (!uid) return res.json({ enabled: true, providers, user: null });
  const user = getUser(uid);
  return res.json({
    enabled: true,
    providers,
    user: user
      ? {
        provider: user.provider,
        email: user.email,
        did: user.did,
        handle: user.handle,
        // What the client needs to decide which screen to show: the app, the
        // registration form, or "we have your request".
        status: user.status,
        submitted: user.submitted,
        adminNote: user.adminNote,
        isAdmin: isAdmin(user),
      }
      : null,
  });
});

/**
 * Ask for access.
 *
 * Separate from sign-in because they answer different questions: sign-in
 * establishes who someone is, this says why they should be let in. Somebody can
 * be signed in and still have no access, which is exactly the state the pending
 * screen renders.
 */
app.post('/api/auth/register', requireAuthConfigured, requireSession, alwaysLimit(20, 60 * 60_000), (req, res) => {
  const result = submitRegistration(req.echoUserId, {
    motivation: req.body?.motivation,
    referralSource: req.body?.referralSource,
    contact: req.body?.contact,
  });

  if (!result.ok) {
    const messages = {
      motivation_required: ['Tell us a little about why you want access.', 'A sentence or two is plenty.', 400],
      rejected: ['This request has already been decided.', '', 403],
      already_approved: ['You already have access.', 'Try reloading the page.', 400],
      no_such_user: ['That account no longer exists.', '', 401],
    };
    const [message, hint, status] = messages[result.reason] || ['Could not submit your request.', '', 400];
    return sendError(res, 'API_FAILED', message, hint, status);
  }

  logEvent('register', { ok: true });
  return res.json({ ok: true, status: 'pending' });
});

// ---------------------------------------------------------------------------
// Admin: the approval queue
// ---------------------------------------------------------------------------

app.get('/api/admin/registrations', requireAuthConfigured, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  try {
    return res.json(listRegistrations({
      status,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }));
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

app.post('/api/admin/registrations/:userId', requireAuthConfigured, requireAdmin, (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return sendError(res, 'API_FAILED', 'Decision must be approve or reject.', '', 400);
  }

  // An admin rejecting themselves would lock the instance's only operator out
  // of the queue that could undo it.
  if (req.params.userId === req.echoUserId && decision === 'reject') {
    return sendError(res, 'API_FAILED', 'You cannot reject your own account.', '', 400);
  }

  const result = decideRegistration(req.params.userId, {
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedBy: req.echoAdminDid,
    adminNote: req.body?.note,
  });
  if (!result.ok) {
    return sendError(res, 'API_FAILED', 'That request could not be decided.', '', result.reason === 'no_such_user' ? 404 : 400);
  }

  logEvent('admin-decision', { ok: true, decision });
  return res.json({ ok: true });
});

/**
 * End every session an account has, everywhere.
 *
 * Separate from revoking access on purpose: they answer different questions.
 * Revoking says "you may not use this any more"; this says "whatever is holding
 * a session right now, stop" — the move for a laptop left in a cafe, or for
 * making a revocation take effect immediately rather than when a stateless
 * cookie happens to expire.
 */
// ---------------------------------------------------------------------------
// Repository mirror (ATPROTO.md Phase 5)
// ---------------------------------------------------------------------------

app.get('/api/pds/status', requireApproved, (req, res) => {
  if (!pdsSync) return res.json({ available: false, on: false, collection: null, connected: false });
  return res.json({
    available: true,
    on: Boolean(req.echoUserId && getPdsSync(req.echoUserId)),
    collection: PDS_COLLECTION,
    connected: Boolean(req.echoUserId && getAtprotoTokens(req.echoUserId)),
  });
});

/**
 * Switch mirroring on or off for the calling account.
 *
 * Turning it ON requires `acknowledged: true` in the body. That is not a
 * formality: mirroring publishes a library to the open internet under a real
 * identity, and a switch that can be flipped by a stray click is not consent.
 * The server refuses rather than trusting the UI to have asked.
 */
app.post('/api/pds/sync', requireApproved, (req, res) => {
  if (!pdsSync) {
    return sendError(res, 'WEB_MODE_UNSUPPORTED', 'Repository mirroring is not enabled on this instance.', '', 503);
  }
  const on = req.body?.on === true;
  if (on && req.body?.acknowledged !== true) {
    return sendError(
      res,
      'API_FAILED',
      'Turning this on needs an explicit acknowledgement.',
      'Mirroring publishes your library publicly — the client must confirm you were told.',
      400
    );
  }

  const result = setPdsSync(req.echoUserId, on);
  if (!result.ok) return sendError(res, 'API_FAILED', 'That account no longer exists.', '', 401);
  logEvent('pds-sync-toggle', { ok: true, on });
  return res.json({ ok: true, on: result.enabled });
});

/**
 * Pull a library back out of the owner's repository.
 *
 * The portability payoff: everything Echo knows can be rebuilt from records the
 * person owns. Writes each entry as it arrives rather than collecting them —
 * a library is the biggest thing in this app and holding one in memory with
 * transcripts attached is the unbounded read this codebase has got wrong seven
 * times.
 */
app.post('/api/pds/restore', requireApproved, async (req, res) => {
  if (!pdsSync) {
    return sendError(res, 'WEB_MODE_UNSUPPORTED', 'Repository sync is not enabled on this instance.', '', 503);
  }

  const lib = libraryFor(req);
  try {
    const result = await pdsSync.pullAll(req.echoUserId, {
      onEntry: async (entry) => {
        await lib.saveEntry(entry);
        // NOT mirrored back: these entries came FROM the repository, and
        // pushing them straight back would be a write per restored video for
        // no change at all.
      },
    });
    if (result.reason === 'no_credentials') {
      return sendError(res, 'API_NOT_AUTHED', 'Sign in with Bluesky again to restore.', '', 401);
    }
    logEvent('pds-restore', { ok: true, restored: result.restored });
    return res.json(result);
  } catch (err) {
    return sendError(
      res,
      err?.echoCode || 'API_FAILED',
      err?.message || 'Could not restore from your repository.',
      err?.hint || '',
      err?.status || 502,
      err?.detail ? { detail: err.detail } : {}
    );
  }
});

app.post('/api/admin/users/:userId/signout', requireAuthConfigured, requireAdmin, (req, res) => {
  const result = forceSignOut(req.params.userId);
  if (!result.ok) {
    return sendError(res, 'API_FAILED', 'That account could not be signed out.', '', 404);
  }
  logEvent('admin-signout', { ok: true, self: req.params.userId === req.echoUserId });
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  // Clears THIS browser's cookie and nothing else — deliberately.
  //
  // An earlier version also deleted the stored Bluesky token here, on the
  // reasoning that signing out should leave no live credential behind. That was
  // wrong: the token is per-ACCOUNT, not per-device, so logging out on one
  // machine would have silently revoked Echo's ability to act for that account
  // everywhere else. "Sign out everywhere" is the route that means it, and it
  // deletes the token there.
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: SECURE_COOKIES }));
  return res.json({ ok: true });
});

app.post('/api/auth/signout-everywhere', requireAuthConfigured, requireSession, (req, res) => {
  // Every session for this account, on every device, stops working now — and
  // the stored Bluesky token goes with them, since "everywhere" that excluded
  // the server's own copy would not mean what it says.
  bumpTokenVersion(req.echoUserId);
  try { deleteAtprotoTokens(req.echoUserId); } catch { /* nothing to forget */ }
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: SECURE_COOKIES }));
  logEvent('signout-all', { ok: true });
  return res.json({ ok: true });
});

app.delete('/api/auth/account', requireAuthConfigured, requireSession, (req, res) => {
  // Deleting the account deletes the synced library with it (ON DELETE
  // CASCADE). The browser's own copy is untouched — this removes what the
  // server holds, which is the only thing the user is asking about.
  deleteUser(req.echoUserId);
  res.set('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: SECURE_COOKIES }));
  return res.json({ ok: true });
});

// Gated like everything else: sync writes transcripts into server storage, so
// an unapproved account filling the volume is exactly the abuse the gate is
// for. requireSession alone would have let a rejected user keep syncing.
app.get('/api/sync/pull', requireAuthConfigured, requireApproved, requireSession, webLimit(60, 60_000), (req, res) => {
  try {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    return res.json(pullEntries(req.echoUserId, since));
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

app.post('/api/sync/push', requireAuthConfigured, requireApproved, requireSession, webLimit(60, 60_000), (req, res) => {
  const entries = req.body && req.body.entries;
  if (!Array.isArray(entries)) {
    return sendError(res, 'INTERNAL', 'entries must be an array.', '', 400);
  }
  try {
    if (userBytes(req.echoUserId) > ECHO_MAX_SYNC_BYTES) {
      return sendError(
        res,
        'TRANSCRIPT_UNAVAILABLE',
        'Your synced library has reached this instance\'s storage limit.',
        'Delete some saved videos, or export and remove older ones.',
        413
      );
    }
    const result = pushEntries(req.echoUserId, entries);
    logEvent('sync-push', { applied: result.applied, skipped: result.skipped, ok: true });
    return res.json({ ...result, serverTime: new Date().toISOString() });
  } catch (err) {
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Library / saved routes
// ---------------------------------------------------------------------------

// IMPORTANT: /api/saved/export must be defined BEFORE /api/saved/:videoId
// so Express does not capture "export" as a videoId parameter.

/**
 * GET /api/saved
 *
 * Without a `limit`, returns the bare metadata array it always has — the shape
 * every existing caller expects, and what the export and vault sync want.
 *
 * With `?limit=&offset=`, returns `{ entries, total, hasMore }` instead. The
 * page opens on a windowed list that paints 60 cards, so it does not need the
 * other 440 before showing anything; it takes a page, renders, and fetches the
 * rest in the background. `total` is sent so the library count is right from
 * the first paint rather than climbing as pages land.
 */
app.get('/api/saved', blockInWeb, requireApproved, async (req, res) => {
  try {
    const limit = req.query.limit === undefined ? null : Number(req.query.limit);
    if (limit === null) return res.json(await libraryFor(req).listEntries());

    if (!Number.isFinite(limit) || limit < 1) {
      return sendError(res, 'INTERNAL', 'limit must be a positive number.', '', 400);
    }
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isFinite(offset) || offset < 0) {
      return sendError(res, 'INTERNAL', 'offset must be zero or a positive number.', '', 400);
    }

    const capped = Math.min(limit, 500);
    const [entries, total] = await Promise.all([
      libraryFor(req).listEntries({ limit: capped, offset }),
      libraryFor(req).countEntries(),
    ]);
    res.json({ entries, total, hasMore: offset + entries.length < total });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

/**
 * Whole-library export, streamed one entry at a time.
 *
 * It used to load every entry, hold them all in an array, and hand that to
 * res.json() — which serialises the lot into a second copy before writing a
 * byte. Measured on a 300-entry library: +68 MB of heap to load, +102 MB by the
 * time the 42 MB payload existed as a string. That is a real risk on a small
 * machine, and it grows with the user's library rather than with anything the
 * operator controls.
 *
 * Streaming bounds it to roughly one entry at a time. The trade-off is that
 * once the first byte is out, a mid-stream failure cannot become a structured
 * error — the response is already 200 — so the connection is destroyed instead,
 * which the client sees as a failed download rather than a truncated file it
 * might mistake for a good one.
 */
app.get('/api/saved/export', blockInWeb, requireApproved, async (req, res) => {
  // Resolved once, not per entry: the export streams the WHOLE library, and
  // re-resolving inside the loop would be a lookup per row for no reason.
  const lib = libraryFor(req);
  let meta;
  try {
    meta = await lib.listEntries();
  } catch (err) {
    return sendCaughtError(res, err);
  }

  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');

  // Piped through gzip rather than the res.send() wrapper, which only sees
  // fully-buffered bodies — the very thing being avoided here.
  let out = res;
  let gzipStream = null;
  if (acceptsGzip(req)) {
    res.set('Content-Encoding', 'gzip');
    gzipStream = createGzip({ level: 6 });
    gzipStream.pipe(res);
    out = gzipStream;
  }

  /** Write, respecting backpressure — otherwise the buffer grows unbounded. */
  const write = (chunk) => new Promise((resolve, reject) => {
    if (out.write(chunk)) return resolve();
    out.once('drain', resolve);
    out.once('error', reject);
  });

  try {
    await write('{"entries":[');
    let first = true;
    for (const m of meta) {
      const entry = await lib.getEntry(m.videoId);
      if (!entry) continue;
      await write(first ? '' : ',');
      await write(JSON.stringify(entry));
      first = false;
    }
    await write(']}');
    out.end();
  } catch (err) {
    console.error('[echo] export stream failed:', err);
    if (gzipStream) gzipStream.destroy();
    res.destroy();
  }
});

// Sub-routes for a saved entry — all before the bare /:videoId GET/DELETE

app.patch('/api/saved/:videoId/tags', blockInWeb, requireApproved, async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return sendError(res, 'INTERNAL', 'tags must be an array.', '', 400);
    }
    const lib = libraryFor(req);
    const entry = await lib.setTags(req.params.videoId, tags);
    if (entry) mirrorToPds(req.echoUserId, 'push', { lib, videoId: req.params.videoId });
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(entry);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/:videoId', blockInWeb, requireApproved, async (req, res) => {
  try {
    const e = await libraryFor(req).getEntry(req.params.videoId);
    if (!e) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    res.json(e);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.get('/api/saved/:videoId/export.md', blockInWeb, requireApproved, async (req, res) => {
  try {
    const entry = await libraryFor(req).getEntry(req.params.videoId);
    if (!entry) return sendError(res, 'INTERNAL', 'Not found.', '', 404);

    const transcriptParam = req.query.transcript;
    const includeTranscript = !(transcriptParam === '0' || transcriptParam === 'false');

    const md = entryToMarkdown(entry, { includeTranscript });
    const slug = (entry.title || 'echo-entry').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'echo-entry';

    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${slug}.md"`);
    res.send(md);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

/**
 * POST /api/vault/sync
 * Writes the full saved library to a folder on disk as one Markdown file
 * per entry (Obsidian-friendly). Blocked in web mode — hosted instances
 * have no writable/durable filesystem to sync into; the frontend there
 * should use the existing ZIP export instead.
 * Body: { dir?: string, includeTranscript?: boolean }
 */
app.post('/api/vault/sync', blockInWeb, requireApproved, async (req, res) => {
  const { dir, includeTranscript } = req.body || {};
  const resolvedDir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : process.env.ECHO_VAULT_DIR;

  if (!resolvedDir) {
    return sendError(
      res,
      'INVALID_URL',
      'No vault folder configured.',
      'Choose a folder in Settings, or set ECHO_VAULT_DIR.',
      400
    );
  }

  const t0 = Date.now();
  try {
    const result = await syncVault(resolvedDir, { includeTranscript, library: libraryFor(req) });
    logEvent('vault-sync', {
      total: result.total, written: result.written, unchanged: result.unchanged, failed: result.failed,
      ok: true, ms: Date.now() - t0,
    });
    res.json(result);
  } catch (err) {
    logEvent('vault-sync', { ok: false, err: errLabel(err), ms: Date.now() - t0 });
    sendCaughtError(res, err);
  }
});

app.post('/api/saved', blockInWeb, requireApproved, async (req, res) => {
  const t0 = Date.now();
  try {
    const { url, videoId, title, segments, digest, channel, channelUrl, transcriptSource, whisperModel } = req.body;
    if (!videoId || !Array.isArray(segments) || segments.length === 0) {
      return sendError(res, 'INTERNAL', 'videoId and segments are required.', '', 400);
    }
    const lib = libraryFor(req);
    const meta = await lib.saveEntry({ url, videoId, title, segments, digest, channel, channelUrl, transcriptSource, whisperModel });
    mirrorToPds(req.echoUserId, 'push', { lib, videoId });
    logEvent('save', { videoId, hadDigest: Boolean(digest), ok: true, ms: Date.now() - t0 });
    res.json(meta);
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.delete('/api/saved/:videoId', blockInWeb, requireApproved, async (req, res) => {
  const t0 = Date.now();
  try {
    const ok = await libraryFor(req).deleteEntry(req.params.videoId);
    if (ok) mirrorToPds(req.echoUserId, 'remove', req.params.videoId);
    if (!ok) return sendError(res, 'INTERNAL', 'Not found.', '', 404);
    logEvent('unsave', { videoId: req.params.videoId, ok: true, ms: Date.now() - t0 });
    res.json({ ok: true });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

app.get('/api/search', blockInWeb, requireApproved, async (req, res) => {
  const q     = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const t0 = Date.now();

  if (!q) return res.json({ results: [], mode: 'keyword' });

  try {
    // searchSummaries() returns exactly the fields a result row shows, with the
    // snippet cut inside SQLite. The previous shape hydrated every hit into a
    // full entry — transcript and all — purely to slice ~200 characters out of
    // it, which on a 300-entry library meant reading 2.0 MB of transcript per
    // search to produce about 4 KB of output.
    const results = await libraryFor(req).searchSummaries(q, limit);
    logEvent('search', { qLen: q.length, mode: 'keyword', results: results.length, ok: true, ms: Date.now() - t0 });
    return res.json({ results, mode: 'keyword' });
  } catch (err) {
    logEvent('search', { qLen: q.length, ok: false, err: errLabel(err), ms: Date.now() - t0 });
    return sendCaughtError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Body-parser and last-resort error handling
// ---------------------------------------------------------------------------
// Registered after every route, which is what makes Express treat it as error
// middleware. Without it, express.json() rejecting an oversize or malformed
// body produced Express's own HTML error page rather than the structured
// envelope every client here knows how to read — so a client hitting the size
// limit got an unparseable response and reported a generic failure.
//
// The four-argument signature is load-bearing: drop `next` and Express
// registers this as ordinary middleware and never routes errors to it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.too.large') {
    return sendError(
      res,
      'TRANSCRIPT_UNAVAILABLE',
      'That request is too large.',
      'Echo sends large libraries in batches — if you are seeing this, try syncing again.',
      413
    );
  }

  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendError(res, 'INTERNAL', 'That request body was not valid JSON.', '', 400);
  }

  return sendCaughtError(res, err);
});

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const server = app.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Listening on http://${displayHost}:${PORT} (bound to ${HOST})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${PORT} is already in use (host ${HOST}).`);
      console.error(`Another instance may still be running. Stop it, or start on a different port with:  PORT=<free-port> node server.js`);
      process.exit(1);
    }
    throw err;
  });

  // Fly/Docker send SIGTERM on every deploy and hard-kill shortly after if the
  // process hasn't exited — with no handler here that hard-kill was landing
  // mid-write. Evidence: this machine's own data/library.db sits at 4 KB next
  // to a 1.6 MB WAL file that has never been checkpointed. Registered only
  // inside isDirectRun (never on import) so `node --test` — which imports this
  // module in every worker — never attaches a handler that would outlive the
  // test and leak into the next process's signal handling.
  let shuttingDown = false;
  function shutdown(signal) {
    // A second SIGTERM (or SIGINT following a SIGTERM) must not re-run the
    // close calls — closing an already-closed DatabaseSync handle throws, and
    // closing an already-closed server callback twice is likewise unsafe.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    // Belt-and-braces: if a connection is hung open, `server.close()`'s
    // callback never fires and the process would sit there until Fly's own
    // hard-kill timeout. Force the exit ourselves so the deploy's kill signal
    // is never the thing that ends this cleanly.
    // Close the databases here too, not only in the happy path: a hung
    // connection is precisely the case where the WAL would otherwise be left
    // uncheckpointed, which is the whole reason this handler exists. Whichever
    // branch runs first exits the process, so these can never both fire.
    const forceExit = setTimeout(() => {
      closeAllLibraries();
      closeSyncDb();
      process.exit(1);
    }, 5000);
    forceExit.unref();

    server.close(() => {
      closeAllLibraries();
      closeSyncDb();
      clearTimeout(forceExit);
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { app, rateLimitHit, buildConfigScript, localMediaId, ECHO_MODE, isWeb, isDesktop, ECHO_ERROR_STATUS, brotliReady };
