import { extractVideoId, extractSummary } from '../text.ts';
import { out } from './out.ts';


// The corpus of tests/shared-parity.test.js, plus Unicode and junk inputs.
const ids: unknown[] = [
  'https://www.youtube.com/watch?v=GRzaq5AHiV8',
  'https://www.youtube.com/watch?v=GRzaq5AHiV8&t=42s',
  'https://www.youtube.com/watch?list=PL123&v=GRzaq5AHiV8',
  'https://youtu.be/GRzaq5AHiV8',
  'https://youtu.be/GRzaq5AHiV8?t=10',
  'https://www.youtube.com/shorts/GRzaq5AHiV8',
  'https://www.youtube.com/embed/GRzaq5AHiV8',
  'https://www.youtube.com/live/GRzaq5AHiV8',
  'GRzaq5AHiV8', '_-aBcDeFgHi',
  'https://www.youtube.com/', 'https://www.youtube.com/feed/subscriptions', 'https://www.youtube.com/@somechannel',
  'https://www.youtube.com/playlist?list=PL1234567890', 'https://example.com/watch?v=GRzaq5AHiV8',
  'too-short', 'waytoolongtobeavideoid', '', '   ',
  '\u00a0GRzaq5AHiV8\u00a0', '\u3000https://youtu.be/GRzaq5AHiV8\u2029', 'https://youtu.be/GRzaq5AHiV8\u00a0x',
  'https://www.youtube.com/watch?v=GRzaq5AHiV8\u2003', 'https://www.youtube.com/watch?v=GRzaq5AHiV',
  'GRzaq5AHiV8\n', 'v=GRzaq5AHiV8', 'https://m.youtube.com/watch?feature=share&v=GRzaq5AHiV8',
  null, undefined, 42, {}, [],
];
ids.forEach((v, i) => out(`extractVideoId#${i}`, extractVideoId(v)));

const digests: unknown[] = [
  '## TL;DR\n\nThe real point of the video.\n\n## Key Points\n- a',
  '## TL;DR\nNo blank line here.\n\n## Key Points\n- a',
  '## TL;DR\n\n\n\nSeveral blank lines.\n',
  '## TL;DR\n\n## Key Points\n- nothing under the heading',
  '# tl;dr\n\nLowercase heading, one hash.',
  '###### TLDR\n\nNo semicolon, six hashes.',
  '## Overview\n\nNo TL;DR at all, so the first paragraph wins.\nsecond line.\n\n## Next',
  'Just a bare paragraph with no headings whatsoever.',
  '## TL;DR\n\nWith **bold**, _italic_, `code` and a [link](https://example.com).',
  `## TL;DR\n\n${'a very long sentence that will need truncating. '.repeat(20)}`,
  '', '   \n  \n ',
  '## TL;DR\n\nUnicode — em dashes, “quotes”, and ellipses…',
  `## TL;DR\n\n${'word '.repeat(200)}`,
  '## TL;DR\r\n\r\nWindows line endings.\r\n\r\n## Next',
  `## TL;DR\n\n${'😀'.repeat(300)}`,
  `## TL;DR\n\n${'x'.repeat(238)}😀 tail`,
  '####### TL;DR\n\nSeven hashes is not a heading.',
  '## TL;DR\n\n[nested [brackets]](u) and [a](b) [c]() [](d)',
  '\u00a0## TL;DR\u00a0\n\n\u2003Spaced\u3000out\u00a0text\u2028here',
  '> quoted\n> lines\n\n## TL;DR\n> only quote',
  42, null, undefined, true,
];
digests.forEach((v, i) => out(`extractSummary#${i}`, extractSummary(v)));
[0, 1, 2, 10, 239, 240, 241].forEach((n) => out(`extractSummary/max${n}`, extractSummary(`## TL;DR\n\n${'abc def '.repeat(40)}`, n)));
