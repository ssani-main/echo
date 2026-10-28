const e: any = new Error("boom")
e.echoCode = "CLAUDE_FAILED"
console.log(e.message, e.echoCode)
