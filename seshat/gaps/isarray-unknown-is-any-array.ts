const input: unknown = ["a", "b"]
const xs: string[] = Array.isArray(input) ? input : []
console.log(xs.join(","))
