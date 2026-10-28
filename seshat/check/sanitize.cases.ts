import { safeHttpUrl } from '../sanitize.ts';
import { out } from './out.ts';

const inputs: unknown[] = [
  'https://example.com', 'http://example.com/a?b=c#d', 'HTTPS://EXAMPLE.COM', '  https://example.com  ',
  'https://exa mple.com/pa th', 'ht\ttp://example.com', 'https:\n//example.com', 'java\nscript:alert(1)',
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'ftp://x.org',
  '//example.com', 'https:/example.com', 'https://', '', ' ', 'https://例え.jp/パス', 'https://x.org/\u00a0nbsp',
  'https://x.org/\u2028line-sep', 'https://x.org/\ufeffbom', 'https://x.org/\u3000ideo', 'https://x.org/\u200bzwsp',
  '\u000bhttps://x.org/vt\u000c', 'https://x.org/\u0085nel', 'https://x.org/\u180emvs',
  null, undefined, 42, true, ['https://a.b'],
];
inputs.forEach((v, i) => out(`safeHttpUrl#${i}`, safeHttpUrl(v)));
