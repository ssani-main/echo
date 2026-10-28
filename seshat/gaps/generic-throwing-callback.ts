async function attempt<T>(f: () => Promise<T>): Promise<T | string> {
  try { return await f() } catch (e) { return `caught ${(e as Error).message}` }
}
const failing = async (): Promise<string> => { throw new Error("boom") }
console.log(await attempt(failing))
export {}
