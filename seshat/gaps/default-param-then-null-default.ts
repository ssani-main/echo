function pick(opts: { n?: number } = {}, onDone: (() => void) | null = null): number {
  if (onDone) onDone()
  return opts.n ?? 1
}
console.log(pick(), pick({ n: 2 }))
