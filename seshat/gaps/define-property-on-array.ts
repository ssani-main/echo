const segs: { text: string }[] = [{ text: "a" }]
Object.defineProperty(segs, "langUsed", { value: "en", enumerable: false })
console.log(JSON.stringify(segs), (segs as unknown as { langUsed?: string }).langUsed)
