import { readFileSync } from "node:fs";

// Awaits a value that isn't a promise, which only the types from @types/node in node_modules reveal.
export async function size(path: string): Promise<number> {
  const data = await readFileSync(path);
  return data.length;
}
