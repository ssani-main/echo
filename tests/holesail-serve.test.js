import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSecurityBanner, buildJanusUrl } from '../tools/holesail-serve.mjs';

// ---------------------------------------------------------------------------
// The public-tunnel warning.
//
// It has to be right in both directions. Crying wolf over the CORRECT setup
// teaches the operator to ignore it; staying quiet over an open one is the
// actual accident.
// ---------------------------------------------------------------------------

const GATE = {
  ECHO_ATPROTO_ENABLED: '1',
  ECHO_ATPROTO_SECRET: 'a-secret',
  ECHO_SESSION_SECRET: 'another-secret',
  ECHO_ADMIN_DIDS: 'did:plc:someone',
};

test('web mode never warns — BYOK plus no server library', () => {
  assert.equal(needsSecurityBanner('web', {}), false);
});

test('an ungated local instance warns', () => {
  assert.equal(needsSecurityBanner('local', {}), true);
  assert.equal(needsSecurityBanner(undefined, {}), true, 'unset defaults to local');
  assert.equal(needsSecurityBanner('desktop', {}), true, 'desktop has the full library too');
  assert.equal(needsSecurityBanner('Local', {}), true, 'a typo resolves to local, so it exposes');
});

test('a fully configured account gate makes local safe to expose', () => {
  // This is now the intended way to run the tunnel, so warning about it would
  // be telling the operator something untrue about the correct setup.
  assert.equal(needsSecurityBanner('local', GATE), false);
  assert.equal(needsSecurityBanner('desktop', GATE), false);
});

test('a HALF-configured gate still warns', () => {
  // Each of these leaves the instance either open or unusable, and both are
  // worth saying out loud before a link goes anywhere.
  for (const missing of Object.keys(GATE)) {
    const partial = { ...GATE };
    delete partial[missing];
    assert.equal(
      needsSecurityBanner('local', partial), true,
      `missing ${missing} must still warn`
    );
  }

  // Sign-in on with nobody able to approve anyone is the specific trap: not
  // open, but not working either.
  assert.equal(needsSecurityBanner('local', { ...GATE, ECHO_ADMIN_DIDS: '   ' }), true);
  assert.equal(needsSecurityBanner('local', { ...GATE, ECHO_ATPROTO_ENABLED: '0' }), true);
});

test('the Janus URL keeps its literal 0000 prefix', () => {
  assert.equal(buildJanusUrl('abc123'), 'https://0000abc123.janus.ssani.dev/');
});
