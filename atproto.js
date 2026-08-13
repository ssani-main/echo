// Sign in with Bluesky (atproto), using app passwords.
//
// Why app passwords and not atproto OAuth — the short version, with the long
// one in ATPROTO.md: OAuth's `client_id` must be a public https URL, and that
// URL becomes part of every session and refresh token it issues. Echo's public
// origin is a Holesail/Janus tunnel today and is meant to move to a P2P host
// later, so an origin change would sign everybody out permanently. App
// passwords carry no origin binding and survive the move.
//
// The tradeoff being accepted: app passwords are deprecated for new projects
// and grant broad account access. That is tolerable only because access here is
// allowlisted rather than open. Revisit if Echo ever admits strangers.
//
// Scope of this file, deliberately narrow:
//   - No database access. Callers persist what they need (see syncStore.js).
//   - No Express. Every function is pure or a plain fetch, so the whole flow is
//     testable against a mock PDS with no server running.
//   - The password is used once, here, and never returned or stored. What the
//     caller keeps is the refresh token, encrypted.
//
// No atproto SDK dependency. This is four HTTP calls and an AES envelope; the
// official client exists to carry OAuth's DPoP/PAR machinery, none of which
// applies on this path.

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Overridable so the flow can be exercised against a mock PDS in tests. Unset —
// the normal case — these are the public network's own endpoints. Pointing them
// anywhere requires control of the server's environment, so this is a test seam
// rather than an attack surface. Mirrors auth.js's ECHO_GOOGLE_*_ENDPOINT.
const HANDLE_RESOLVER = (process.env.ECHO_ATPROTO_RESOLVER || 'https://public.api.bsky.app').replace(/\/+$/, '');
const PLC_DIRECTORY = (process.env.ECHO_ATPROTO_PLC || 'https://plc.directory').replace(/\/+$/, '');

// Every outbound call is bounded. A PDS that accepts the connection and then
// never answers would otherwise hold a sign-in request open indefinitely.
const FETCH_TIMEOUT_MS = 10_000;

export { HANDLE_RESOLVER, PLC_DIRECTORY, FETCH_TIMEOUT_MS };

/**
 * App passwords are `xxxx-xxxx-xxxx-xxxx`, lowercase alphanumeric.
 *
 * This is checked BEFORE anything is sent anywhere, and it is a safety feature
 * rather than a formatting nicety: the PDS will happily accept an account's
 * real password here, and a user pasting one into a stranger's server has
 * handed over their whole account — including the ability to change the
 * password and lock them out. An app password can be revoked from Bluesky's
 * settings, cannot manage the account, and sidesteps 2FA. Refusing anything
 * that is not one is the single highest-value line in this file.
 */
export const APP_PASSWORD_RE = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i;

/** @param {string} pw */
export function looksLikeAppPassword(pw) {
  return typeof pw === 'string' && APP_PASSWORD_RE.test(pw.trim());
}

/**
 * Tag an Error the way the routes expect: a message safe to show a user, a
 * next-step hint, and an HTTP status. `detail` carries the raw upstream text
 * for the error card's "Show technical details" disclosure.
 */
function fail(message, { hint = '', status = 502, detail = '' } = {}) {
  const err = new Error(message);
  err.echoCode = 'ATPROTO_FAILED';
  err.hint = hint;
  err.status = status;
  if (detail) err.detail = String(detail).slice(0, 500);
  return err;
}

/**
 * Normalise what someone typed into a handle or DID.
 *
 * Accepts `@alice.bsky.social`, `alice.bsky.social`, `did:plc:...`, and tolerates
 * the whitespace a copy-paste leaves behind. Email addresses are rejected on
 * purpose: the PDS accepts them for createSession, but an email cannot be
 * resolved to a DID, so there would be no way to find which PDS to ask.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeIdentifier(raw) {
  const s = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
  if (!s) throw fail('Enter your Bluesky handle.', { hint: 'For example: alice.bsky.social', status: 400 });
  if (s.includes('@')) {
    throw fail('Sign in with your handle, not your email address.', {
      hint: 'Your handle looks like alice.bsky.social and is shown on your Bluesky profile.',
      status: 400,
    });
  }
  if (s.startsWith('did:')) {
    if (!/^did:(plc:[a-z2-7]+|web:[a-z0-9.:%-]+)$/i.test(s)) {
      throw fail('That does not look like a valid DID.', { status: 400 });
    }
    return s;
  }
  // A handle is a domain name. Anything without a dot is not one, and catching
  // it here produces a better message than a 400 from the resolver.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    throw fail('That does not look like a Bluesky handle.', {
      hint: 'A handle looks like alice.bsky.social — no @ and no spaces.',
      status: 400,
    });
  }
  return s;
}

/** fetch with a timeout, and a uniform failure message when the host is unreachable. */
async function req(url, init, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw fail('Could not reach the Bluesky server.', {
      hint: 'Check this machine\'s internet connection and try again.',
      detail: `${url}: ${err?.message || err}`,
    });
  }
}

/**
 * Resolve a handle to a DID.
 *
 * Uses the public AppView rather than DNS or the PDS: it answers for every
 * account on the network regardless of where that account is hosted, which is
 * exactly the lookup needed before we know which PDS to talk to.
 *
 * @param {string} identifier handle or DID (a DID passes straight through)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>} did
 */
export async function resolveDid(identifier, fetchImpl) {
  const id = normalizeIdentifier(identifier);
  if (id.startsWith('did:')) return id;

  const url = `${HANDLE_RESOLVER}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(id)}`;
  const res = await req(url, {}, fetchImpl);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw fail(`No Bluesky account found for @${id}.`, {
      hint: 'Check the spelling — a handle looks like alice.bsky.social.',
      status: 404,
      detail,
    });
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body.did !== 'string' || !body.did.startsWith('did:')) {
    throw fail('The handle lookup returned something unexpected.', { detail: JSON.stringify(body).slice(0, 200) });
  }
  return body.did;
}

/**
 * Find the PDS that hosts a DID, by reading its DID document.
 *
 * Not hardcoded to bsky.social on purpose: a self-hosted account's credentials
 * are only valid against its own PDS, and hardcoding would silently exclude
 * exactly the people most likely to be running their own infrastructure.
 *
 * @param {string} did
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>} PDS origin, no trailing slash
 */
export async function resolvePdsUrl(did, fetchImpl) {
  let docUrl;
  if (did.startsWith('did:plc:')) {
    docUrl = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
  } else if (did.startsWith('did:web:')) {
    // did:web:example.com -> https://example.com/.well-known/did.json. The
    // percent-encoded-colon form carries a port; anything with path segments
    // (extra colons after that) is out of scope here.
    const host = did.slice('did:web:'.length).replace(/%3A/gi, ':');
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
      throw fail('That did:web identifier is not supported.', { status: 400 });
    }
    docUrl = `https://${host}/.well-known/did.json`;
  } else {
    throw fail('Only did:plc and did:web accounts are supported.', { status: 400 });
  }

  const res = await req(docUrl, {}, fetchImpl);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw fail('Could not look up that account\'s server.', { status: 502, detail: `${docUrl}: ${detail}` });
  }
  const doc = await res.json().catch(() => null);

  const services = Array.isArray(doc?.service) ? doc.service : [];
  const pds = services.find((s) => (
    s?.type === 'AtprotoPersonalDataServer' || String(s?.id || '').endsWith('#atproto_pds')
  ));
  const endpoint = String(pds?.serviceEndpoint || '');

  // Scheme check before use, never a host check. `new URL('javascript:x').host`
  // is the empty string, so host-based filtering waves through javascript:,
  // file: and data: URLs — the trap recorded in CLAUDE.md. A PDS is https.
  if (!/^https:\/\//i.test(endpoint)) {
    throw fail('That account\'s server could not be verified.', {
      hint: 'Its DID document does not publish a valid https endpoint.',
      detail: endpoint.slice(0, 200),
    });
  }
  return endpoint.replace(/\/+$/, '');
}

/**
 * handle-or-DID -> everything needed to talk to the right PDS.
 *
 * @param {string} identifier
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ did: string, pdsUrl: string }>}
 */
export async function resolveAccount(identifier, fetchImpl) {
  const did = await resolveDid(identifier, fetchImpl);
  return { did, pdsUrl: await resolvePdsUrl(did, fetchImpl) };
}

/** Pull the machine-readable error name out of an XRPC error body. */
async function xrpcError(res) {
  const text = await res.text().catch(() => '');
  let name = '';
  try { name = String(JSON.parse(text)?.error || ''); } catch { /* not JSON */ }
  return { name, text };
}

/**
 * Exchange a handle + app password for tokens.
 *
 * The password does not leave this function: what comes back is a DID, a
 * handle, and two JWTs. Callers persist the refresh token (encrypted) and throw
 * the password away — see ATPROTO.md.
 *
 * @param {{ pdsUrl: string, identifier: string, password: string }} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{did: string, handle: string, accessJwt: string, refreshJwt: string}>}
 */
export async function createSession({ pdsUrl, identifier, password }, fetchImpl) {
  if (!looksLikeAppPassword(password)) {
    throw fail('That is not an app password.', {
      hint: 'Create one at Bluesky → Settings → Privacy and security → App passwords. It looks like abcd-efgh-ijkl-mnop. Never enter your real Bluesky password here.',
      status: 400,
    });
  }

  const res = await req(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: password.trim() }),
  }, fetchImpl);

  if (!res.ok) {
    const { name, text } = await xrpcError(res);

    if (name === 'AuthFactorTokenRequired') {
      // 2FA is on for the account. App passwords bypass it by design, so this
      // means they typed the real password despite the shape check — or the
      // account has an app password that has since been revoked.
      throw fail('This account needs an app password.', {
        hint: 'Two-factor is enabled, so only an app password will work. Create one in Bluesky → Settings → Privacy and security → App passwords.',
        status: 401,
        detail: text,
      });
    }
    if (res.status === 401 || name === 'AuthenticationRequired') {
      throw fail('That handle and app password did not match.', {
        hint: 'App passwords are revoked from Bluesky\'s settings — if you deleted this one, create a new one.',
        status: 401,
        detail: text,
      });
    }
    if (res.status === 429) {
      throw fail('Bluesky is rate-limiting sign-ins for this account.', {
        hint: 'Bluesky allows 30 sign-ins per 5 minutes. Wait a few minutes and try again.',
        status: 429,
        detail: text,
      });
    }
    throw fail('Bluesky rejected the sign-in.', { status: 502, detail: text });
  }

  const body = await res.json().catch(() => null);
  if (!body?.did || !body?.accessJwt || !body?.refreshJwt) {
    throw fail('Bluesky returned an incomplete sign-in response.', { detail: JSON.stringify(body).slice(0, 200) });
  }

  // A deactivated or suspended account authenticates fine but cannot read or
  // write its repo, so letting it through would produce confusing failures
  // later rather than a clear one now.
  if (body.active === false) {
    throw fail('That Bluesky account is not active.', {
      hint: body.status ? `Bluesky reports its status as "${body.status}".` : '',
      status: 403,
    });
  }

  return {
    did: String(body.did),
    handle: String(body.handle || ''),
    accessJwt: String(body.accessJwt),
    refreshJwt: String(body.refreshJwt),
  };
}

/**
 * Trade a refresh token for a fresh pair.
 *
 * Refresh tokens rotate: the old one stops working the moment this succeeds, so
 * a caller that fails to persist the new one has signed the user out. Persist
 * before using the access token for anything.
 *
 * @param {{ pdsUrl: string, refreshJwt: string }} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{did: string, handle: string, accessJwt: string, refreshJwt: string}>}
 */
export async function refreshSession({ pdsUrl, refreshJwt }, fetchImpl) {
  const res = await req(`${pdsUrl}/xrpc/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshJwt}` },
  }, fetchImpl);

  if (!res.ok) {
    const { text } = await xrpcError(res);
    // Expired, revoked, or already rotated. All of them mean the same thing to
    // the caller: this session is over, sign them out rather than retrying.
    throw fail('Your Bluesky session has expired.', {
      hint: 'Sign in again with your handle and an app password.',
      status: 401,
      detail: text,
    });
  }

  const body = await res.json().catch(() => null);
  if (!body?.accessJwt || !body?.refreshJwt) {
    throw fail('Bluesky returned an incomplete refresh response.', { status: 401 });
  }
  return {
    did: String(body.did || ''),
    handle: String(body.handle || ''),
    accessJwt: String(body.accessJwt),
    refreshJwt: String(body.refreshJwt),
  };
}

/**
 * Confirm an access token is live, and read the current handle off it.
 *
 * Handles are rented and can change or be reassigned, which is exactly why the
 * DID is the join key everywhere else. This is how the displayed handle stays
 * honest.
 *
 * @param {{ pdsUrl: string, accessJwt: string }} spec
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{did: string, handle: string}>}
 */
export async function getSession({ pdsUrl, accessJwt }, fetchImpl) {
  const res = await req(`${pdsUrl}/xrpc/com.atproto.server.getSession`, {
    headers: { Authorization: `Bearer ${accessJwt}` },
  }, fetchImpl);
  if (!res.ok) {
    const { text } = await xrpcError(res);
    throw fail('Your Bluesky session has expired.', { status: 401, detail: text });
  }
  const body = await res.json().catch(() => null);
  if (!body?.did) throw fail('Bluesky returned an incomplete session.', { status: 401 });
  return { did: String(body.did), handle: String(body.handle || '') };
}

// ---------------------------------------------------------------------------
// Token encryption at rest
// ---------------------------------------------------------------------------
// Refresh tokens are long-lived credentials for someone else's Bluesky account.
// Stored in the clear, a stolen copy of the sync database would be a stolen set
// of accounts, so they are sealed with a key that lives in the environment
// rather than in the file. Losing the key signs everyone out; it does not lose
// any Echo data.

/** @param {string} secret @returns {Buffer} 32-byte key */
export function deriveKey(secret) {
  if (!secret) throw new Error('ECHO_ATPROTO_SECRET is required to store Bluesky tokens.');
  return createHash('sha256').update(String(secret)).digest();
}

/**
 * Seal a token as `iv.tag.ciphertext`, base64url.
 *
 * AES-256-GCM rather than CBC or a bare cipher: the auth tag makes tampering
 * detectable, so a modified row fails closed at decrypt instead of yielding
 * plausible garbage that gets sent to a PDS.
 *
 * @param {string} plain
 * @param {Buffer} key
 * @returns {string}
 */
export function encryptSecret(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

/**
 * Open a sealed token. Returns null for anything malformed, tampered with, or
 * sealed under a different key — callers treat null as "signed out" and never
 * inspect why, exactly as verifyToken() does in auth.js.
 *
 * @param {string} blob
 * @param {Buffer} key
 * @returns {string|null}
 */
export function decryptSecret(blob, key) {
  if (typeof blob !== 'string') return null;
  const parts = blob.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
