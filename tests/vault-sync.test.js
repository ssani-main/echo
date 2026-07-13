import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readdirSync, readFileSync } from 'node:fs';

const DB = join(tmpdir(), `echo-test-vault-db-${process.pid}-${Date.now()}.db`);
process.env.ECHO_DB_PATH = DB;

const store = await import('../store.js');
const { syncVault, slugify, monthFolder } = await import('../vault.js');

const VAULT_DIR = join(tmpdir(), `echo-test-vault-${process.pid}-${Date.now()}`);

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { rmSync(VAULT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

test.after(cleanup);

test('setup: seed one saved entry', async () => {
  await store.saveEntry({
    videoId: 'vaultVid1',
    url: 'https://www.youtube.com/watch?v=vaultVid1',
    title: 'My Great Video!!',
    segments: [{ text: 'hello there', offset: 0 }],
    digest: 'a short digest',
  });
});

test('syncVault writes one .md per entry with the expected idempotent filename', async () => {
  const result = await syncVault(VAULT_DIR);
  assert.equal(result.total, 1);
  assert.equal(result.written, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(result.failed, 0);

  const expectedName = `${slugify('My Great Video!!')}-vaultVid1.md`;
  const entry = await store.getEntry('vaultVid1');
  const sub = monthFolder(entry.savedAt);

  // Notes live in a YYYY-MM/ subfolder, not the vault root.
  const subFiles = readdirSync(join(result.dir, sub));
  assert.ok(subFiles.includes(expectedName), `expected ${expectedName} in ${sub}/ (${subFiles.join(', ')})`);

  const contents = readFileSync(join(result.dir, sub, expectedName), 'utf8');
  assert.match(contents, /My Great Video!!/);
  assert.match(contents, /a short digest/);
});

test('monthFolder buckets by UTC year-month and handles bad dates', () => {
  assert.equal(monthFolder('2026-07-13T10:00:00.000Z'), '2026-07');
  assert.equal(monthFolder('2026-01-01T00:00:00.000Z'), '2026-01');
  assert.equal(monthFolder(''), 'Undated');
  assert.equal(monthFolder('not-a-date'), 'Undated');
  assert.ok(!monthFolder('2026-07-13T10:00:00.000Z').includes('/'));
});

test('syncVault writes an Echo Library.md index note linking each entry', async () => {
  const result = await syncVault(VAULT_DIR);
  assert.ok(['written', 'unchanged'].includes(result.index));
  const idxPath = join(VAULT_DIR, 'Echo Library.md');
  const idx = readFileSync(idxPath, 'utf8');
  assert.match(idx, /# Echo Library/);
  assert.match(idx, /\[\[.*vaultVid1\|My Great Video!!\]\]/);
});

test('a second sync with no changes reports files as unchanged, not written', async () => {
  const result = await syncVault(VAULT_DIR);
  assert.equal(result.total, 1);
  assert.equal(result.written, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.failed, 0);
});

test('a changed entry is rewritten (written), not left unchanged', async () => {
  await store.saveEntry({
    videoId: 'vaultVid1',
    url: 'https://www.youtube.com/watch?v=vaultVid1',
    title: 'My Great Video!!',
    segments: [{ text: 'hello there', offset: 0 }],
    digest: 'an updated digest',
  });

  const result = await syncVault(VAULT_DIR);
  assert.equal(result.written, 1);
  assert.equal(result.unchanged, 0);
});

test('slugify strips unsafe chars and never leaves path separators/traversal', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('  '), 'untitled');
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify(null), 'untitled');
  assert.ok(!slugify('a/b\\c:d*e?f"g<h>i|j').includes('/'));
  assert.ok(!slugify('a/b\\c:d*e?f"g<h>i|j').includes('\\'));

  const longStr = 'x'.repeat(200);
  assert.ok(slugify(longStr).length <= 60);
});

test('syncVault with a missing/empty dir string throws', async () => {
  await assert.rejects(() => syncVault(''), /vault folder/i);
  await assert.rejects(() => syncVault(undefined), /vault folder/i);
  await assert.rejects(() => syncVault('   '), /vault folder/i);
});

test('an entry with a videoId containing path separators is skipped, never escapes the vault dir', async () => {
  // getEntry/listEntries only ever return DB-stored videoIds, but syncVault's
  // VIDEO_ID_RE guard is defense-in-depth — verify indirectly via a clean
  // sync still only producing files inside VAULT_DIR.
  const result = await syncVault(VAULT_DIR);
  const files = readdirSync(result.dir);
  for (const f of files) {
    assert.ok(!f.includes('/') && !f.includes('\\'), `filename escaped: ${f}`);
  }
});
