// Port of the pure parts of ../vault.js (slugify, monthFolder). syncVault
// writes files and reads the library, so it comes with store.js (see PORT.md).
// Checked against the original by check/vault.cases.ts.

const MAX_SLUG_LEN = 60;

/**
 * Turn an arbitrary string into a filesystem-safe slug: lowercase,
 * non-alphanumeric runs collapsed to a single '-', leading/trailing '-'
 * trimmed, capped at MAX_SLUG_LEN chars; 'untitled' if nothing is left.
 */
export function slugify(str: string | null | undefined): string {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Bucket an entry into a `YYYY-MM` subfolder by its save date (UTC);
 * invalid/missing dates go to `Undated`.
 */
export function monthFolder(savedAt: string | null | undefined): string {
  const d = savedAt ? new Date(savedAt) : null;
  if (!d || isNaN(d.getTime())) return 'Undated';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
