// Deliberate issue for Sonar to find: a dead store.
export function Widget({ label }) {
  const unused = label.length;
  return <button type="button">{label}</button>;
}
