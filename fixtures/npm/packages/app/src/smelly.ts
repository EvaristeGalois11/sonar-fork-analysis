// Deliberate issues for Sonar to find, in a file no test covers.
export function same(a: number, b: number): boolean {
  const unused = a * 2;
  return a === b && a === b;
}
