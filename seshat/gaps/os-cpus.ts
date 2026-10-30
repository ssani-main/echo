// Gap 51: node:os has no cpus() (T0107), nor availableParallelism(). Node prints true. whisper.js gives
// whisper-cli 75% of the cores.
import { cpus } from 'node:os';
console.log(cpus().length > 0);
