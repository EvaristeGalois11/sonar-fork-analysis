// Deliberate issue for Sonar to find: a dead store.
export function double(n) {
  const unused = n * 3;
  return n * 2;
}
