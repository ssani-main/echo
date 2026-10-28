const table: Record<string, { n: number }> = { a: { n: 1 } }
function pick(key: string | null): number {
  const found = (key && table[key]) || { n: 0 }
  return found.n
}
console.log(pick("a"), pick(""), pick(null), pick("zz"))
