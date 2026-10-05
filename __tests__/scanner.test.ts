import { jest } from '@jest/globals'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { posixIt } from '../__fixtures__/platform.js'

const downloadTool = jest.fn<(url: string) => Promise<string>>()
const extractZip =
  jest.fn<(file: string, destination?: string) => Promise<string>>()
jest.unstable_mockModule('@actions/tool-cache', () => ({
  downloadTool,
  extractZip
}))

const { keptZip, scannerBuild, scannerZip, unpackScanner } =
  await import('../src/scanner.js')

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

describe('scannerZip', () => {
  const zip = Buffer.from('the scanner')
  const sha256 = createHash('sha256').update(zip).digest('hex')
  let root: string
  let served: Buffer
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scanner-'))
    process.env.RUNNER_TOOL_CACHE = join(root, 'cache')
    served = zip
    let downloads = 0
    downloadTool.mockImplementation(async () => {
      const file = join(root, `download-${String(++downloads)}`)
      writeFileSync(file, served)
      return file
    })
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(root, { recursive: true, force: true })
  })

  it('downloads, checks and keeps the zip, then uses the kept copy', async () => {
    expect(await scannerZip('cli', sha256)).toEqual(zip)
    expect(readFileSync(keptZip('cli'))).toEqual(zip)
    downloadTool.mockClear()

    expect(await scannerZip('cli', sha256)).toEqual(zip)
    expect(downloadTool).not.toHaveBeenCalled()
  })

  it('downloads again over a kept copy that fails the check', async () => {
    mkdirSync(dirname(keptZip('cli')), { recursive: true })
    writeFileSync(keptZip('cli'), 'tampered')

    expect(await scannerZip('cli', sha256)).toEqual(zip)
    expect(downloadTool).toHaveBeenCalled()
    expect(readFileSync(keptZip('cli'))).toEqual(zip)
  })

  it('refuses a download that fails the check, and keeps nothing', async () => {
    served = Buffer.from('not the scanner')

    await expect(scannerZip('cli', sha256)).rejects.toThrow(
      `expected ${sha256}`
    )
    expect(existsSync(keptZip('cli'))).toBe(false)
  })

  posixIt(
    'reads and writes through no link where the zip is kept',
    async () => {
      const kept = keptZip('cli')
      mkdirSync(dirname(kept), { recursive: true })
      // Endless to read, and a file elsewhere to write to.
      symlinkSync('/dev/zero', kept)
      const target = join(root, 'target')
      symlinkSync(target, `${kept}.${String(process.pid)}.part`)

      expect(await scannerZip('cli', sha256)).toEqual(zip)
      expect(existsSync(target)).toBe(false)
    }
  )

  it("works where the zip can't be kept", async () => {
    writeFileSync(join(root, 'cache'), 'a file, not a directory')

    expect(await scannerZip('cli', sha256)).toEqual(zip)
    expect(lstatSync(join(root, 'cache')).isFile()).toBe(true)
  })
})

describe('unpackScanner', () => {
  let root: string
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scanner-'))
    process.env.RUNNER_TEMP = root
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(root, { recursive: true, force: true })
  })

  it('unpacks exactly the checked bytes into a directory of its own', async () => {
    let unpacked: Buffer | undefined
    extractZip.mockImplementation(async (file, destination) => {
      expect(file.startsWith(root)).toBe(true)
      expect(file.endsWith('.zip')).toBe(true)
      unpacked = readFileSync(file)
      return destination ?? ''
    })

    const script = await unpackScanner(
      Buffer.from('checked'),
      '-linux-x64',
      'linux'
    )

    expect(unpacked).toEqual(Buffer.from('checked'))
    expect(script.startsWith(root)).toBe(true)
    expect(script).toMatch(
      /sonar-scanner-[\d.]+-linux-x64[/\\]bin[/\\]sonar-scanner$/
    )
    expect(
      await unpackScanner(Buffer.from('checked'), '-windows-x64', 'win32')
    ).toMatch(/sonar-scanner\.bat$/)
  })
})
