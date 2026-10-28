const v: unknown = { text: "x" }
if (typeof v === "object" && v !== null && "text" in v) console.log(v.text)
