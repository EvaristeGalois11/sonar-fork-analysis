import { readFileSync } from "node:fs";

export function fizzbuzz(n: number): string {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}

// Awaits a value that isn't a promise, which only the types from @types/node in node_modules reveal.
export async function size(path: string): Promise<number> {
  const data = await readFileSync(path);
  return data.length;
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
