import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNewReport, snapshotReports } from '../src/report.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'report-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function report(relative: string, ceTaskId = 'AZ-1'): string {
  const path = join(directory, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `projectKey=key\nceTaskId=${ceTaskId}\n`)
  return path
}

describe('findNewReport', () => {
  it('finds a report that did not exist before the build', () => {
    const before = snapshotReports(directory)
    const path = report('build/sonar/report-task.txt')
    expect(findNewReport(directory, before)).toBe(path)
  })

  it('finds a report in a custom build directory', () => {
    const before = snapshotReports(directory)
    const path = report('out/custom/sonar/report-task.txt')
    expect(findNewReport(directory, before)).toBe(path)
  })

  it('finds a report rewritten by a new analysis', () => {
    const path = report('target/sonar/report-task.txt', 'AZ-1')
    const before = snapshotReports(directory)
    report('target/sonar/report-task.txt', 'AZ-2')
    expect(findNewReport(directory, before)).toBe(path)
  })

  it('ignores a report left over from an earlier build', () => {
    report('target/sonar/report-task.txt')
    const before = snapshotReports(directory)
    expect(findNewReport(directory, before)).toBeUndefined()
  })

  it('skips a directory it cannot read', () => {
    // Root reads anything, so the directory can't be locked against it.
    if (process.getuid?.() === 0) return
    const before = snapshotReports(directory)
    mkdirSync(join(directory, 'data'))
    chmodSync(join(directory, 'data'), 0o000)
    const path = report('.scannerwork/report-task.txt')
    try {
      expect(findNewReport(directory, before)).toBe(path)
    } finally {
      chmodSync(join(directory, 'data'), 0o755)
    }
  })

  it('skips .git, node_modules and .gradle', () => {
    const before = snapshotReports(directory)
    report('node_modules/pkg/report-task.txt')
    report('.gradle/report-task.txt')
    report('.git/report-task.txt')
    expect(findNewReport(directory, before)).toBeUndefined()
  })
})
