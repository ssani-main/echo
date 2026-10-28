import { slugify, monthFolder } from '../vault.ts';
import { out } from './out.ts';

const titles: (string | null | undefined)[] = [
  'Hello World', '  --Leading and trailing--  ', 'Ünïcödé Tïtle', '日本語のタイトル', 'emoji 😀 title', '',
  'a'.repeat(80), `${'ab-'.repeat(25)}cd`, `${'x'.repeat(59)}-y`, 'İstanbul ǅ ß ﬁ', 'ÀÉÎ', '___', null, undefined,
  'Mixed CASE 123 & more!!!', 'line\nbreak\ttab',
];
titles.forEach((t, i) => out(`slugify#${i}`, slugify(t)));

const dates: (string | null | undefined)[] = [
  '2026-10-28T09:00:00.000Z', '2026-01-01T00:30:00+01:00', '2026-12-31T23:59:59-01:00', '2026-10-28', '2026-10-28 09:00',
  'October 28, 2026', 'garbage', '', null, undefined, '0001-01-01T00:00:00Z', '+275760-09-13T00:00:00Z',
  '-000001-01-01T00:00:00Z', '1969-12-31T23:59:59.999Z', '2026-02-30',
];
dates.forEach((d, i) => out(`monthFolder#${i}`, monthFolder(d)));
