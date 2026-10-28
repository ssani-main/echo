// One line per case: the case name and the result as JSON, so a difference in
// whitespace or a lone surrogate shows up in the byte comparison.
export function out(name: string, value: unknown): void {
  process.stdout.write(JSON.stringify([name, value]) + '\n');
}
