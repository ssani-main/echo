// Gap 55: spreading a call's result (`...f()`) whose record type is also held as `unknown` somewhere
// doesn't build: the C uses `.` on a pointer ("the generated C failed to compile"). Spreading a local
// holding the same call's result builds. Node prints {"label":"A","name":"a"} {"name":"a"}.
interface State { name: string }
function stateOf(n: string): State { return { name: n }; }
const v: unknown = stateOf('a');
console.log(JSON.stringify({ label: 'A', ...stateOf('a') }), JSON.stringify(v));
