const table: Record<string, number> = { a: 1 }
const key: string = "zz"
console.log((key ? table[key] : undefined) || 0)
