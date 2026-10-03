// Deliberate issues for Sonar to find.
export function same(a: number, b: number): boolean {
  const unused = a * 2;
  return a === b && a === b;
}
