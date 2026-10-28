function messageOf(err: { message?: string }): string {
  return err.message || ""
}
console.log(messageOf(new Error("boom")))
