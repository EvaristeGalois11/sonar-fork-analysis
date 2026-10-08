// Deliberate issues for Sonar to find in a component.
export function Widget({ label }: { label: string }) {
  const unused = label.length;
  return <button onClick={() => {}}>{label}</button>;
}
