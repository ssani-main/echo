interface Seg { text: string }
async function call(f: () => Promise<Seg[]>): Promise<Seg[]> { return await f() }
const fetcher = async (): Promise<Seg[]> => {
  if (Math.random() > 2) throw new Error("never")
  return [{ text: "a" }]
}
const segs = await call(fetcher)
const v: unknown = { segs }
console.log(JSON.stringify(v))
export {}
