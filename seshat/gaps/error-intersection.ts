type Tagged = Error & { echoCode?: string }
function code(e: Tagged): string { return e.echoCode ?? "none" }
console.log(code(new Error("x")))
