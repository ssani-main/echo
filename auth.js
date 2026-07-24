// Google sign-in and stateless sessions.
//
// Scope, deliberately narrow:
//   - Google is the only identity provider. No passwords, no reset flow, no
//     email delivery, nothing to leak.
//   - Sessions are a signed cookie, NOT a sessions table. The only thing the
//     server stores about a person is a row mapping Google's `sub` to a user
//     id, which is what makes library sync possible at all.
//   - No Anthropic API key ever reaches the server. Signing in does not change
//     that: keys stay in the browser's localStorage and ride per-request in
//     X-Echo-Api-Key, exactly as DEPLOY.md promises.
//
// No auth dependency. The whole flow is one redirect, one POST to Google, and
// an HMAC — a library here would be more surface area than code.

import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

const SESSION_COOKIE = 'echo_session';
const OAUTH_COOKIE = 'echo_oauth';

// A month. Long enough that a personal library does not nag; short enough that
// a leaked cookie expires on its own.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The sign-in round trip. Ten minutes is generous for choosing an account.
const OAUTH_TTL_MS = 10 * 60 * 1000;

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export { SESSION_COOKIE, OAUTH_COOKIE, SESSION_TTL_MS, OAUTH_TTL_MS, GOOGLE_TOKEN_ENDPOINT };

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

// ---------------------------------------------------------------------------
// Signed, stateless tokens
// ---------------------------------------------------------------------------

/**
 * Sign a small JSON payload into `<payload>.<hmac>`.
 *
 * Stateless on purpose: verifying a session is a hash, not a database read, so
 * the deployment needs no sessions table and no session store to keep warm.
 * The cost is that a session cannot be revoked server-side before it expires —
 * acceptable for a personal library, and the reason the TTL is a month rather
 * than a year.
 *
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
export function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify and decode a token produced by signToken(). Returns null for anything
 * that is malformed, tampered with, or expired — callers treat null as
 * "signed out" and never inspect why.
 *
 * @param {string} token
 * @param {string} secret
 * @param {number} [now]
 * @returns {object|null}
 */
export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Parse a Cookie header. Tolerant of stray whitespace and of values containing
 * '=' (a signed token does not, but a future one might).
 *
 * @param {string} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Serialise a Set-Cookie value.
 *
 * SameSite=Lax rather than Strict: the browser arrives back at the callback via
 * a top-level redirect FROM Google, and Strict would withhold the cookie on
 * that navigation, breaking sign-in. Lax sends cookies on top-level GETs, which
 * is exactly this case and nothing riskier.
 *
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeMs?: number, secure?: boolean, expires?: boolean }} [opts]
 * @returns {string}
 */
export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeMs === 0) parts.push('Max-Age=0');
  else if (opts.maxAgeMs) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Google OAuth 2.0 / OIDC
// ---------------------------------------------------------------------------

/** Cryptographically random URL-safe string, for `state` and the PKCE verifier. */
export function randomToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

/**
 * Build the URL to send the browser to.
 *
 * `scope` is the minimum that identifies a person: openid for the `sub`, email
 * so the UI can show who is signed in. No profile, no picture, nothing that
 * would need a privacy policy paragraph to justify.
 *
 * @param {{ clientId: string, redirectUri: string, state: string, codeChallenge: string }} spec
 * @returns {string}
 */
export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Ask for no refresh token: this flow never acts on the user's behalf after
    // sign-in, so a long-lived Google credential would be a liability with no use.
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Decode an ID token's payload WITHOUT verifying its signature.
 *
 * That is safe here, and only here, because of where the token comes from: it
 * is read out of the response to our own server-to-server POST to Google's
 * token endpoint, over TLS, authenticated with the client secret. Google's own
 * guidance says a token obtained that way needs no local validation — the TLS
 * channel already proves the issuer.
 *
 * It would NOT be safe for a token handed to us by a browser. If this ever
 * grows a path that accepts an ID token from a client, that path must verify
 * the signature against Google's JWKS instead of calling this.
 *
 * @param {string} idToken
 * @returns {object|null}
 */
export function decodeIdToken(idToken) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Is this ID token payload usable as an identity?
 *
 * Checks the audience is us (a token minted for a different client must not be
 * accepted), that Google issued it, that it has not expired, and that the email
 * is verified — an unverified email would let someone claim an address they do
 * not control.
 *
 * @param {object} payload
 * @param {string} clientId
 * @param {number} [now]
 * @returns {{ ok: true, sub: string, email: string } | { ok: false, reason: string }}
 */
export function validateIdTokenPayload(payload, clientId, now = Date.now()) {
  if (!payload) return { ok: false, reason: 'missing' };
  if (payload.aud !== clientId) return { ok: false, reason: 'audience' };
  if (!/^(https:\/\/)?accounts\.google\.com$/.test(String(payload.iss || ''))) {
    return { ok: false, reason: 'issuer' };
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (!payload.sub) return { ok: false, reason: 'subject' };
  if (payload.email && payload.email_verified === false) {
    return { ok: false, reason: 'email_unverified' };
  }
  return { ok: true, sub: String(payload.sub), email: String(payload.email || '') };
}

/**
 * Exchange an authorization code for tokens. Injectable fetch so tests never
 * touch the network.
 *
 * @param {object} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object>} Google's token response
 */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error('Google rejected the sign-in code exchange.');
    err.echoCode = 'AUTH_FAILED';
    err.detail = detail.slice(0, 500);
    throw err;
  }
  return res.json();
}
