import * as tc from '@actions/tool-cache'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installScanner, scannerBuild } from '../src/scanner.js'

describe('scannerBuild', () => {
  it('picks the build with a bundled Java runtime where one exists', () => {
    expect(scannerBuild('linux', 'x64').suffix).toBe('-linux-x64')
    expect(scannerBuild('linux', 'arm64').suffix).toBe('-linux-aarch64')
    expect(scannerBuild('darwin', 'arm64').suffix).toBe('-macosx-aarch64')
    expect(scannerBuild('win32', 'x64').suffix).toBe('-windows-x64')
  })

  it('falls back to the plain build elsewhere', () => {
    expect(scannerBuild('linux', 'ppc64')).toEqual({
      suffix: '',
      sha256: 'ab76ab3c360025e9108be5b55be066f304a164f8b2850d2f2f333915db51bc1b'
    })
  })
})

describe('installScanner', () => {
  let root: string
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scanner-'))
    process.env.RUNNER_TOOL_CACHE = join(root, 'cache')
    process.env.RUNNER_TEMP = join(root, 'temp')
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(root, { recursive: true, force: true })
  })

  it('uses a scanner already in the tool cache without downloading', async () => {
    const scanner = join(root, 'scanner')
    mkdirSync(join(scanner, 'bin'), { recursive: true })
    const cached = await tc.cacheDir(
      scanner,
      'sonar-scanner-cli-linux-x64',
      '8.1.0-build.6389'
    )

    await expect(installScanner('linux', 'x64')).resolves.toBe(
      join(cached, 'bin', 'sonar-scanner')
    )
  })
})
