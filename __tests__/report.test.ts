import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findReport } from '../src/report.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'report-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function report(relative: string, modified?: Date): string {
  const path = join(directory, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'projectKey=key\n')
  if (modified) utimesSync(path, modified, modified)
  return path
}

describe('findReport', () => {
  it('finds a report written after the build started', () => {
    const path = report('build/sonar/report-task.txt')
    expect(findReport(directory, Date.now() - 1000)).toBe(path)
  })

  it('finds a report in a custom build directory', () => {
    const path = report('out/custom/sonar/report-task.txt')
    expect(findReport(directory, Date.now() - 1000)).toBe(path)
  })

  it('ignores a report left over from an earlier build', () => {
    report('target/sonar/report-task.txt', new Date(Date.now() - 60_000))
    expect(findReport(directory, Date.now() - 1000)).toBeUndefined()
  })

  it('skips .git, node_modules and .gradle', () => {
    report('node_modules/pkg/report-task.txt')
    report('.gradle/report-task.txt')
    report('.git/report-task.txt')
    expect(findReport(directory, Date.now() - 1000)).toBeUndefined()
  })
})
