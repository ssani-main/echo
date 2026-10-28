const v: unknown = [null, { text: "x" }]
const xs = v as { text: string }[]
console.log(xs.length)
