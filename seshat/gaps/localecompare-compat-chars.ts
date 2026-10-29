// Node (ICU): [0,-1,0,0]. Seshat: [1,1,1,1]: ligatures, fullwidth letters and unit symbols sort after
// every other letter, with or without options.
const base = { sensitivity: 'base' } as const;
console.log(JSON.stringify([
  'ﬁle'.localeCompare('file', undefined, base),
  'ﬁle'.localeCompare('zebra'),
  'Ａpple'.localeCompare('apple', undefined, base),
  '㎏'.localeCompare('kg', undefined, base),
]));
