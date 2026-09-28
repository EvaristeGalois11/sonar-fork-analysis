import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIPPED = new Set(['.git', 'node_modules', '.gradle'])

// The scanner writes report-task.txt after every analysis it uploads (target/sonar for Maven,
// build/sonar for Gradle). Searching instead of checking those paths copes with custom build
// directories.
export function findReport(
  directory: string,
  writtenSince: number
): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
      const found = findReport(path, writtenSince)
      if (found) return found
    } else if (
      entry.isFile() &&
      entry.name === 'report-task.txt' &&
      statSync(path).mtimeMs >= writtenSince
    ) {
      return path
    }
  }
  return undefined
}
