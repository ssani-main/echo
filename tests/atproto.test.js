import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeAppPassword, normalizeIdentifier, resolveDid, resolvePdsUrl, resolveAccount,
  createSession, refreshSession, getSession, deriveKey, encryptSecret, decryptSecret,
} from '../atproto.js';

// ---------------------------------------------------------------------------
// Sign in with Bluesky.
//
// The suite never touches the network: every call takes an injected fetch, the
// same seam auth.js uses for Google. What is worth testing here is not the
// happy path — it is the refusals. Handing a stranger's server your real
// Bluesky password gives away your whole account, and a serviceEndpoint is a
// URL read out of a document someone else controls.
// ---------------------------------------------------------------------------

const KEY = deriveKey('test-secret');
const APP_PW = 'abcd-efgh-ijkl-mnop';
const DID = 'did:plc:abc234xyz';

/** A fetch that answers from a map of url-substring -> response spec. */
function mockFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, spec] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {});
        return {
          ok: (spec.status ?? 200) < 400,
          status: spec.status ?? 200,
          json: async () => JSON.parse(body),
          text: async () => body,
        };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const PLC_DOC = {
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
};

// ---------------------------------------------------------------------------
// App password shape — the highest-value refusal in the module
// ---------------------------------------------------------------------------

test('accepts an app password and rejects anything else', () => {
  assert.equal(looksLikeAppPassword(APP_PW), true);
  assert.equal(looksLikeAppPassword('ABCD-EFGH-IJKL-MNOP'), true, 'case-insensitive');
  assert.equal(looksLikeAppPassword(' abcd-efgh-ijkl-mnop '), true, 'tolerates paste whitespace');

  // The ones that matter: a real password must never be accepted.
  assert.equal(looksLikeAppPassword('hunter2'), false);
  assert.equal(looksLikeAppPassword('correct-horse-battery-staple'), false, 'right shape, wrong length');
  assert.equal(looksLikeAppPassword('abcd-efgh-ijkl'), false, 'too few groups');
  assert.equal(looksLikeAppPassword('abcd-efgh-ijkl-mnop-qrst'), false, 'too many groups');
  assert.equal(looksLikeAppPassword(''), false);
  assert.equal(looksLikeAppPassword(undefined), false);
});

test('a non-app-password never reaches the network', async () => {
  const calls = [];
  const fetchImpl = mockFetch({}, calls);
  await assert.rejects(
    () => createSession({ pdsUrl: 'https://pds.example.com', identifier: DID, password: 'my-real-password' }, fetchImpl),
    /not an app password/i
  );
  assert.equal(calls.length, 0, 'the password must not be sent anywhere to be rejected');
});

// ---------------------------------------------------------------------------
// Identifier normalisation
// ---------------------------------------------------------------------------

test('normalises handles and rejects what cannot be resolved', () => {
  assert.equal(normalizeIdentifier('@Alice.bsky.social'), 'alice.bsky.social');
  assert.equal(normalizeIdentifier('  alice.bsky.social \n'), 'alice.bsky.social');
  assert.equal(normalizeIdentifier(DID), DID);

  // An email is accepted by the PDS but cannot be resolved to a DID, so there
  // would be no way to know which PDS to ask.
  assert.throws(() => normalizeIdentifier('alice@example.com'), /handle, not your email/i);
  assert.throws(() => normalizeIdentifier('alice'), /does not look like a Bluesky handle/i);
  assert.throws(() => normalizeIdentifier(''), /Enter your Bluesky handle/i);
  assert.throws(() => normalizeIdentifier('did:key:zzz'), /valid DID/i);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('resolves a handle to a DID, and passes a DID straight through', async () => {
  const calls = [];
  const fetchImpl = mockFetch({ resolveHandle: { body: { did: DID } } }, calls);

  assert.equal(await resolveDid('@alice.bsky.social', fetchImpl), DID);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /handle=alice\.bsky\.social/);

  assert.equal(await resolveDid(DID, fetchImpl), DID);
  assert.equal(calls.length, 1, 'a DID needs no lookup');
});

test('reports an unknown handle as not found, not as a server error', async () => {
  const fetchImpl = mockFetch({ resolveHandle: { status: 400, body: { error: 'InvalidRequest' } } });
  await assert.rejects(
    () => resolveDid('nobody.bsky.social', fetchImpl),
    (err) => err.status === 404 && /No Bluesky account found/.test(err.message)
  );
});

test('finds the PDS in a DID document', async () => {
  const fetchImpl = mockFetch({ 'plc.directory': { body: PLC_DOC } });
  assert.equal(await resolvePdsUrl(DID, fetchImpl), 'https://pds.example.com');
});

test('finds the PDS for a self-hosted account rather than assuming bsky.social', async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    'plc.directory': { body: { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://my-own-pds.example/' }] } },
  }, calls);
  const { pdsUrl } = await resolveAccount(DID, fetchImpl);
  assert.equal(pdsUrl, 'https://my-own-pds.example', 'trailing slash trimmed');
});

test('refuses a serviceEndpoint that is not https', async () => {
  // The CLAUDE.md trap: `new URL('javascript:alert(1)').host` is the empty
  // string, so a host-based check would wave this through. The scheme is what
  // has to be validated, and a DID document is attacker-controlled input.
  for (const endpoint of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://pds.example.com']) {
    const fetchImpl = mockFetch({
      'plc.directory': { body: { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint }] } },
    });
    await assert.rejects(
      () => resolvePdsUrl(DID, fetchImpl),
      /could not be verified/i,
      `${endpoint} must be refused`
    );
  }
});

test('refuses a DID document with no PDS service at all', async () => {
  const fetchImpl = mockFetch({ 'plc.directory': { body: { service: [] } } });
  await assert.rejects(() => resolvePdsUrl(DID, fetchImpl), /could not be verified/i);
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

test('exchanges an app password for tokens', async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    createSession: { body: { did: DID, handle: 'alice.bsky.social', accessJwt: 'access', refreshJwt: 'refresh', active: true } },
  }, calls);

  const session = await createSession({ pdsUrl: 'https://pds.example.com', identifier: DID, password: APP_PW }, fetchImpl);
  assert.deepEqual(session, { did: DID, handle: 'alice.bsky.social', accessJwt: 'access', refreshJwt: 'refresh' });

  // The password goes to the PDS and nowhere else, and nothing is returned that
  // could leak it back to a caller.
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).password, APP_PW);
  assert.equal(Object.values(session).includes(APP_PW), false);
});

test('classifies the sign-in failures a person can act on', async () => {
  const cases = [
    { status: 401, body: { error: 'AuthenticationRequired' }, status_: 401, match: /did not match/i },
    { status: 401, body: { error: 'AuthFactorTokenRequired' }, status_: 401, match: /needs an app password/i },
    { status: 429, body: { error: 'RateLimitExceeded' }, status_: 429, match: /rate-limiting/i },
    { status: 500, body: { error: 'InternalServerError' }, status_: 502, match: /rejected the sign-in/i },
  ];
  for (const c of cases) {
    const fetchImpl = mockFetch({ createSession: { status: c.status, body: c.body } });
    await assert.rejects(
      () => createSession({ pdsUrl: 'https://pds.example.com', identifier: DID, password: APP_PW }, fetchImpl),
      (err) => err.status === c.status_ && c.match.test(err.message),
      `${c.body.error} should map to ${c.status_}`
    );
  }
});

test('refuses a deactivated account rather than failing later', async () => {
  const fetchImpl = mockFetch({
    createSession: { body: { did: DID, handle: 'a.b', accessJwt: 'a', refreshJwt: 'r', active: false, status: 'suspended' } },
  });
  await assert.rejects(
    () => createSession({ pdsUrl: 'https://pds.example.com', identifier: DID, password: APP_PW }, fetchImpl),
    (err) => err.status === 403 && /not active/i.test(err.message)
  );
});

test('a PDS that is unreachable reads as unreachable, not as bad credentials', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => createSession({ pdsUrl: 'https://pds.example.com', identifier: DID, password: APP_PW }, fetchImpl),
    /Could not reach the Bluesky server/i
  );
});

// ---------------------------------------------------------------------------
// refresh / verify
// ---------------------------------------------------------------------------

test('refreshes a session and returns the rotated pair', async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    refreshSession: { body: { did: DID, handle: 'alice.bsky.social', accessJwt: 'a2', refreshJwt: 'r2' } },
  }, calls);
  const out = await refreshSession({ pdsUrl: 'https://pds.example.com', refreshJwt: 'r1' }, fetchImpl);
  assert.equal(out.refreshJwt, 'r2', 'the NEW refresh token is what the caller must persist');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer r1');
});

test('a revoked refresh token signs the user out rather than retrying', async () => {
  const fetchImpl = mockFetch({ refreshSession: { status: 400, body: { error: 'ExpiredToken' } } });
  await assert.rejects(
    () => refreshSession({ pdsUrl: 'https://pds.example.com', refreshJwt: 'stale' }, fetchImpl),
    (err) => err.status === 401 && /session has expired/i.test(err.message)
  );
});

test('getSession reads the current handle off a live token', async () => {
  const fetchImpl = mockFetch({ getSession: { body: { did: DID, handle: 'renamed.bsky.social' } } });
  assert.deepEqual(
    await getSession({ pdsUrl: 'https://pds.example.com', accessJwt: 'a' }, fetchImpl),
    { did: DID, handle: 'renamed.bsky.social' }
  );
});

// ---------------------------------------------------------------------------
// Token sealing
// ---------------------------------------------------------------------------

test('seals and opens a refresh token', () => {
  const sealed = encryptSecret('refresh-token-value', KEY);
  assert.doesNotMatch(sealed, /refresh-token-value/, 'the plaintext must not survive in the envelope');
  assert.equal(decryptSecret(sealed, KEY), 'refresh-token-value');
});

test('a fresh IV is used every time', () => {
  assert.notEqual(encryptSecret('same', KEY), encryptSecret('same', KEY));
});

test('a tampered or wrongly-keyed token fails closed', () => {
  const sealed = encryptSecret('refresh-token-value', KEY);

  assert.equal(decryptSecret(sealed, deriveKey('different-secret')), null, 'wrong key');
  assert.equal(decryptSecret('not.an.envelope', KEY), null, 'malformed');
  assert.equal(decryptSecret('only-one-part', KEY), null, 'malformed');
  assert.equal(decryptSecret(undefined, KEY), null);

  // Flip a byte of ciphertext: GCM's auth tag must catch it rather than
  // returning plausible garbage that would then be sent to a PDS.
  const parts = sealed.split('.');
  const ct = Buffer.from(parts[2], 'base64url');
  ct[0] ^= 0xff;
  parts[2] = ct.toString('base64url');
  assert.equal(decryptSecret(parts.join('.'), KEY), null, 'tampered ciphertext');
});

test('deriveKey refuses an empty secret', () => {
  assert.throws(() => deriveKey(''), /ECHO_ATPROTO_SECRET/);
});
