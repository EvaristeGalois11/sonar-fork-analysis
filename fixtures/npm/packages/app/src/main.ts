import { fizzbuzz, readText } from "@fixture/shared";

// Awaits a value that isn't a promise, which only the types of the shared package, reached through the
// workspace's link in node_modules, reveal.
export async function banner(path: string): Promise<string> {
  const text = await readText(path);
  return `${fizzbuzz(text.length)}: ${text}`;
}
