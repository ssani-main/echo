function fail(reason: any): never {
  throw reason
}
try { fail({ message: "plain object" }) } catch (e) { console.log(String(e === undefined)) }
