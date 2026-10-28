function messageOf(err: any): { message: string } {
  return { message: err.message }
}
console.log(JSON.stringify(messageOf({})))
