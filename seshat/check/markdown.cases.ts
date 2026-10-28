import { entryToMarkdown, buildVaultIndex, extractSummary } from '../markdown.ts';
import type { Entry, Segment, VaultItem } from '../markdown.ts';
import { out } from './out.ts';

const digest = '## TL;DR\n\nA "quoted" point — with **bold**.\n\n## Key Points\n- one\n- two\n\n\n\n## End';
const segments: (Segment | null)[] = [
  { text: ' first ' }, { text: '' }, null, { text: 'second\nline' }, {}, { text: 'third' },
  { text: 0 }, { text: 7 }, { text: null }, { text: true },
];

const entries: (Entry | null | undefined)[] = [
  { title: 'A video', url: 'https://www.youtube.com/watch?v=GRzaq5AHiV8', videoId: 'GRzaq5AHiV8', tags: ['ai', '', 'llm'], segments, digest, savedAt: '2026-10-28T09:00:00.000Z' },
  { videoId: 'GRzaq5AHiV8' },
  { title: 'Say "hi" \\ there', url: 'javascript:alert(1)', videoId: 'x"y', tags: ['a"b'], digest: '   ', savedAt: '' },
  { title: 'No url', segments: [], digest: 'Just one paragraph.\n\n\n\n\nAnd another.' },
  { title: 'Tags and segments null', tags: null, segments: null },
  { title: 'Ünïcödé 😀 [x] | y', url: ' https://youtu.be/GRzaq5AHiV8 ', tags: ['日本語', 'émoji😀'], digest: '# Heading only' },
  { title: null, url: null, videoId: null, digest: null, savedAt: null },
  {},
  null,
  undefined,
];
entries.forEach((e, i) => {
  out(`entryToMarkdown#${i}`, entryToMarkdown(e));
  out(`entryToMarkdown#${i}/noTranscript`, entryToMarkdown(e, { includeTranscript: false }));
});
out('extractSummary re-export', extractSummary(digest));

const items: VaultItem[] = [
  { link: '2026-10/a', title: 'banana', savedAt: '2026-10-28T09:00:00.000Z', tags: ['fruit', 'yellow'], summary: 'A fruit.' },
  { link: '2026-10/b', title: 'Apple', savedAt: '2026-10-01T00:00:00.000Z', tags: ['fruit'], summary: '' },
  { link: '2026-09/c', title: 'apple', savedAt: '2026-09-30T23:59:59.999Z', tags: ['fruit', 'red'], summary: null },
  { link: '2026-09/d', title: 'Éclair', savedAt: '2026-09-15', tags: ['red', 'dessert', ''] },
  { link: '2026-09/e', title: 'eclair', savedAt: '2026-09-15T12:00:00', tags: ['dessert'] },
  { link: 'x/f', title: '[[weird]] | title', savedAt: 'not a date', tags: null },
  { link: 'x/g', title: 'Zebra', savedAt: null },
  { link: 'x/h', title: '', savedAt: '' },
  { link: '2025-01/i', title: 'Older', savedAt: '2025-01-31T23:30:00-02:00', tags: ['yellow'] },
  { link: '2024-12/j', title: 'Year end', savedAt: '2024-12-31T23:59:59Z', tags: ['Fruit'] },
  { link: '2026-02/k', title: 'Leap-ish', savedAt: '2026-02-29T00:00:00Z' },
  { link: '2026-03/l', title: '10 things', savedAt: '2026-03-01T00:00:00+14:00', tags: ['yellow'] },
  { link: '2026-03/m', title: 'Über', savedAt: '2026-03-02T00:00:00Z', tags: ['dessert'] },
  { link: '2026-03/n', title: 'uber', savedAt: '2026-03-03T00:00:00Z' },
  { link: '2026-03/o', title: 'UBER', savedAt: '2026-03-04T00:00:00Z' },
];
out('buildVaultIndex/all', buildVaultIndex(items));
out('buildVaultIndex/one', buildVaultIndex(items.slice(0, 1)));
out('buildVaultIndex/empty', buildVaultIndex([]));
out('buildVaultIndex/null', buildVaultIndex(null));
out('buildVaultIndex/undefined', buildVaultIndex(undefined));

// Dates as V8 reads them: buckets come from new Date(savedAt), which V8 also parses outside ISO 8601.
const dateForms = [
  '2026-10-28', '2026-10', '2026', '+002026-10-28T00:00:00Z', '2026-10-28T09:00Z', '2026-10-28 09:00:00',
  '2026-10-28T09:00:00.123456Z', 'October 28, 2026', 'Wed, 28 Oct 2026 09:00:00 GMT', '10/28/2026', '2026/10/28',
  '28 Oct 2026', '2026-13-01', '2026-02-30', ' 2026-10-28 ', 'Tue Oct 27 2026 23:00:00 GMT+0000',
];
dateForms.forEach((savedAt, i) => out(`buildVaultIndex/date#${i}`, buildVaultIndex([{ link: `d/${i}`, title: 't', savedAt }])));
