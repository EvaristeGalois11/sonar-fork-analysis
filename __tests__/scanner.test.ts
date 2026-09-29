import { scannerBuild } from '../src/scanner.js'

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
