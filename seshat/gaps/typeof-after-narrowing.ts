// Gap 46: after `if (v !== undefined && v !== null && typeof v !== 'string') return`, a later
// `typeof v === 'string'` on the same `unknown` is false for a string. Node prints "xx".
function langOf(raw: string): string {
  const v: unknown = JSON.parse(raw);
  if (v !== undefined && v !== null && typeof v !== 'string') return 'refused';
  let lang = 'none';
  if (typeof v === 'string') lang = v;
  return lang;
}
console.log(langOf('"xx"'));
