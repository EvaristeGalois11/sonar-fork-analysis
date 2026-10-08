// Deliberate issue for Sonar to find: a dead store.
export function half(n) {
  const unused = n * 2;
  return n / 2;
}
