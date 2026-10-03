import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

const SKIPPED = new Set(['.git', 'node_modules', '.gradle'])

// Report path -> content.
export type Reports = Map<string, string>

// The scanner writes report-task.txt after every analysis it uploads (target/sonar for Maven,
// build/sonar for Gradle, .scannerwork for the scanner CLI). Searching instead of checking those paths copes with custom build
// directories.
export function snapshotReports(
  directory: string,
  reports: Reports = new Map()
): Reports {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    // E.g. a database a test left in the workspace through a container's bind mount.
    return reports
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
      snapshotReports(path, reports)
    } else if (entry.isFile() && entry.name === 'report-task.txt') {
      reports.set(path, readFileSync(path, 'utf8'))
    }
  }
  return reports
}

// Each report carries the ceTaskId the server assigned to that analysis, so a real analysis always
// leaves a new or changed report, while one left over from an earlier build stays identical. This
// avoids comparing file timestamps, which are too coarse to rely on.
export function findNewReport(
  directory: string,
  before: Reports
): string | undefined {
  for (const [path, content] of snapshotReports(directory)) {
    if (before.get(path) !== content) return path
  }
  return undefined
}
