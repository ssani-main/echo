function attempt(): void {
  let last: any
  try { throw new Error("boom") } catch (e) { last = e }
  throw last
}
try { attempt() } catch (e) { console.log((e as Error).message) }
