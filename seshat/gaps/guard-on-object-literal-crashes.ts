function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}
const s: unknown = { text: "a" }
if (isRecord(s)) console.log(s.text)
