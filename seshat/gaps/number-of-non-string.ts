const fromEnv = Number(process.env.ECHO_UNSET_VARIABLE) || 180000
const u: unknown = 42
console.log(fromEnv, Number(u), Number(true), Number(null))
