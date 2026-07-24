import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken, verifyToken, parseCookies, serializeCookie,
  randomToken, pkceChallenge, buildGoogleAuthUrl,
  decodeIdToken, validateIdTokenPayload, exchangeCode,
} from '../auth.js';

// ---------------------------------------------------------------------------
// Sign-in and sessions.
//
// This is the one part of Echo where a bug is a security bug rather than a
// broken feature, so the cases below are mostly about what must be REFUSED:
// forged signatures, expired tokens, tokens minted for another application,
// unverified emails, and a callback that did not come from the flow we started.
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-do-not-use';

// --- Session tokens --------------------------------------------------------

test('signToken/verifyToken: a token round-trips', () => {
  const token = signToken({ uid: 'user-1', exp: Date.now() + 60_000 }, SECRET);
  const payload = verifyToken(token, SECRET);
  assert.equal(payload.uid, 'user-1');
});

test('verifyToken: a tampered payload is refused', () => {
  const token = signToken({ uid: 'user-1', exp: Date.now() + 60_000 }, SECRET);
  const [body, mac] = token.split('.');
  // Re-encode a different uid, keep the original signature.
  const forgedBody = Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 60_000 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.notEqual(forgedBody, body);
  assert.equal(verifyToken(`${forgedBody}.${mac}`, SECRET), null);
});

test('verifyToken: a token signed with another secret is refused', () => {
  const token = signToken({ uid: 'user-1', exp: Date.now() + 60_000 }, 'other-secret');
  assert.equal(verifyToken(token, SECRET), null);
});

test('verifyToken: an expired token is refused', () => {
  const token = signToken({ uid: 'user-1', exp: Date.now() - 1 }, SECRET);
  assert.equal(verifyToken(token, SECRET), null);
});

test('verifyToken: a token with no expiry is refused', () => {
  // A session that never expires is not a session.
  const token = signToken({ uid: 'user-1' }, SECRET);
  assert.equal(verifyToken(token, SECRET), null);
});

test('verifyToken: junk input returns null instead of throwing', () => {
  for (const bad of ['', 'not-a-token', 'a.b.c', '.', 'x.', null, undefined, 42, {}]) {
    assert.equal(verifyToken(bad, SECRET), null, `should refuse: ${String(bad)}`);
  }
});

test('verifyToken: an empty secret refuses everything', () => {
  const token = signToken({ uid: 'u', exp: Date.now() + 60_000 }, SECRET);
  assert.equal(verifyToken(token, ''), null);
});

// --- Cookies ---------------------------------------------------------------

test('parseCookies: reads multiple cookies and decodes values', () => {
  const jar = parseCookies('echo_session=abc%20def; other=1;  spaced = 2 ');
  assert.equal(jar.echo_session, 'abc def');
  assert.equal(jar.other, '1');
  assert.equal(jar.spaced, '2');
});

test('parseCookies: no header yields an empty jar', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('serializeCookie: session cookies are HttpOnly and SameSite=Lax', () => {
  const cookie = serializeCookie('echo_session', 'v', { maxAgeMs: 60_000 });
  assert.match(cookie, /HttpOnly/);
  // Lax, not Strict: the browser returns from Google via a top-level redirect,
  // and Strict would withhold the cookie on exactly that navigation.
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=60/);
  assert.match(cookie, /Path=\//);
});

test('serializeCookie: Secure is set only when asked (http://localhost must work)', () => {
  assert.doesNotMatch(serializeCookie('a', 'b', {}), /Secure/);
  assert.match(serializeCookie('a', 'b', { secure: true }), /Secure/);
});

test('serializeCookie: clearing uses Max-Age=0', () => {
  assert.match(serializeCookie('echo_session', '', { maxAgeMs: 0 }), /Max-Age=0/);
});

// --- OAuth request ---------------------------------------------------------

test('randomToken: distinct, URL-safe, and long enough to be unguessable', () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 32);
});

test('pkceChallenge: is the S256 of the verifier and is stable', () => {
  const verifier = 'a-known-verifier';
  assert.equal(pkceChallenge(verifier), pkceChallenge(verifier));
  assert.notEqual(pkceChallenge(verifier), verifier);
  assert.match(pkceChallenge(verifier), /^[A-Za-z0-9_-]+$/);
});

test('buildGoogleAuthUrl: asks for the minimum, with PKCE', () => {
  const url = new URL(buildGoogleAuthUrl({
    clientId: 'client-123',
    redirectUri: 'https://echo.example.com/api/auth/callback',
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-xyz');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // Identity only. No profile, no picture, nothing needing extra justification.
  assert.equal(url.searchParams.get('scope'), 'openid email');
  // No offline access: this flow never acts for the user after sign-in, so a
  // refresh token would be a liability with no purpose.
  assert.equal(url.searchParams.get('access_type'), 'online');
});

// --- ID token --------------------------------------------------------------

/** Build an unsigned JWT-shaped string; only the payload is ever read. */
function fakeIdToken(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
}

test('decodeIdToken: reads the payload', () => {
  const payload = decodeIdToken(fakeIdToken({ sub: '123', email: 'a@b.com' }));
  assert.equal(payload.sub, '123');
  assert.equal(payload.email, 'a@b.com');
});

test('decodeIdToken: malformed input yields null', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not.a.jwt', null, 42]) {
    assert.equal(decodeIdToken(bad), null, `should refuse: ${String(bad)}`);
  }
});

test('validateIdTokenPayload: accepts a well-formed Google identity', () => {
  const result = validateIdTokenPayload({
    aud: 'client-123', iss: 'https://accounts.google.com',
    sub: 'google-sub-1', email: 'a@b.com', email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
  }, 'client-123');
  assert.equal(result.ok, true);
  assert.equal(result.sub, 'google-sub-1');
  assert.equal(result.email, 'a@b.com');
});

test('validateIdTokenPayload: refuses a token minted for a different application', () => {
  // Without this check, anyone with a Google client could mint tokens that this
  // server would accept as its own users.
  const result = validateIdTokenPayload({
    aud: 'someone-elses-client', iss: 'https://accounts.google.com', sub: 's',
  }, 'client-123');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'audience');
});

test('validateIdTokenPayload: refuses a non-Google issuer', () => {
  const result = validateIdTokenPayload({
    aud: 'client-123', iss: 'https://evil.example.com', sub: 's',
  }, 'client-123');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'issuer');
});

test('validateIdTokenPayload: accepts both spellings of the Google issuer', () => {
  for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
    const r = validateIdTokenPayload({ aud: 'c', iss, sub: 's' }, 'c');
    assert.equal(r.ok, true, `should accept issuer ${iss}`);
  }
});

test('validateIdTokenPayload: refuses an expired token', () => {
  const result = validateIdTokenPayload({
    aud: 'c', iss: 'https://accounts.google.com', sub: 's',
    exp: Math.floor(Date.now() / 1000) - 10,
  }, 'c');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('validateIdTokenPayload: refuses an unverified email', () => {
  // An unverified address would let someone sign in as an address they do not
  // control — and the address is what the UI shows as their identity.
  const result = validateIdTokenPayload({
    aud: 'c', iss: 'https://accounts.google.com', sub: 's',
    email: 'someone@else.com', email_verified: false,
  }, 'c');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'email_unverified');
});

test('validateIdTokenPayload: refuses a payload with no subject', () => {
  const result = validateIdTokenPayload({ aud: 'c', iss: 'https://accounts.google.com' }, 'c');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'subject');
});

// --- Code exchange ---------------------------------------------------------

test('exchangeCode: posts the PKCE verifier and the secret to Google', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, body: new URLSearchParams(init.body) };
    return { ok: true, json: async () => ({ id_token: 'x' }) };
  };

  await exchangeCode({
    code: 'the-code', clientId: 'c', clientSecret: 'sec',
    redirectUri: 'https://e/cb', codeVerifier: 'ver',
  }, fakeFetch);

  assert.equal(seen.url, 'https://oauth2.googleapis.com/token');
  assert.equal(seen.body.get('code'), 'the-code');
  assert.equal(seen.body.get('code_verifier'), 'ver');
  assert.equal(seen.body.get('client_secret'), 'sec');
  assert.equal(seen.body.get('grant_type'), 'authorization_code');
});

test('exchangeCode: a rejection from Google throws a tagged error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' });
  await assert.rejects(
    () => exchangeCode({ code: 'x', clientId: 'c', clientSecret: 's', redirectUri: 'r', codeVerifier: 'v' }, fakeFetch),
    (err) => err.echoCode === 'AUTH_FAILED'
  );
});
