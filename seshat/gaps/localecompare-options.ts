const words = ["b", "A", "a", "B", "é", "e"]
console.log(words.sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" })).join(" "))
