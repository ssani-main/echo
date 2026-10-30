// Gap 42: `x === 'throw'` doesn't narrow a `Answer | 'throw' | undefined` (T0108: not every variant has field
// `body`); TypeScript leaves `Answer` after both checks. Node prints ok.
interface Answer { body: string }
function bodyOf(answer: Answer | 'throw' | undefined): string {
  if (answer === 'throw') throw new Error('x');
  if (answer === undefined) return '';
  return answer.body;
}
console.log(bodyOf({ body: 'ok' }));
