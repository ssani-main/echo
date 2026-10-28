interface Seg { text: string }
async function call(f: () => Promise<Seg[]>): Promise<Seg[]> { return await f() }
const fetcher = async (): Promise<Seg[]> => {
  if (Math.random() > 2) throw new Error("never")
  return [{ text: "a" }]
}
console.log(JSON.stringify(await call(fetcher)))
export {}
