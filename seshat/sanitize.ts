// Port of ../sanitize.js. Checked against it by check/sanitize.cases.ts.

// Returns the URL only if it is a safe http(s) URL, else ''.
// Browsers ignore leading/trailing whitespace and embedded control chars
// (tab/newline/CR) when resolving a scheme, so strip those before testing.
export function safeHttpUrl(raw: unknown): string {
  if (raw == null) return '';
  const cleaned = String(raw).replace(/\s+/g, '');
  return /^https?:\/\//i.test(cleaned) ? cleaned : '';
}
