const s: unknown = { text: "a" }
console.log((s as Record<string, unknown>).text)
