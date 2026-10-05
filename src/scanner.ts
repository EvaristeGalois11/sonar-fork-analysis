import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = '8.1.0.6389'

type Build = { suffix: string; sha256: string }

// Builds with their own Java runtime, so the analysis needs no Java on the runner.
const BUNDLED: Record<string, Build> = {
  'linux-x64': {
    suffix: '-linux-x64',
    sha256: 'bb8f709f9cb73352f8d1260a3b3c506c0f41146754bc630762c126d795499d0b'
  },
  'linux-arm64': {
    suffix: '-linux-aarch64',
    sha256: '5e1c9328f4e261838de778c9e586ee608cca45ff7f0538108642219214628ba5'
  },
  'darwin-x64': {
    suffix: '-macosx-x64',
    sha256: '8afc8bbff9008434e53b31cb681333ff643b999f84ca537db573d0fae8883cdc'
  },
  'darwin-arm64': {
    suffix: '-macosx-aarch64',
    sha256: '20d12be4081896b337cd873d98ebd3d554be666086a45e31dd84a12ef51c3688'
  },
  'win32-x64': {
    suffix: '-windows-x64',
    sha256: '73f0e71928673d5b2f39bb86213342a30e51a14c8eec345164016bb29c8df8ee'
  }
}

// Everywhere else: the plain build, which runs on the Java found on the runner.
const PLAIN: Build = {
  suffix: '',
  sha256: 'ab76ab3c360025e9108be5b55be066f304a164f8b2850d2f2f333915db51bc1b'
}

export function scannerBuild(platform: string, arch: string): Build {
  return BUNDLED[`${platform}-${arch}`] ?? PLAIN
}

// Where the zip is kept between runs, documented for users to cache. Other jobs or a restored cache
// may have put anything there: it's checked on every use, and nothing runs from it.
export function keptZip(name: string): string {
  return join(
    process.env.RUNNER_TOOL_CACHE ?? tmpdir(),
    'sonar-fork-analysis',
    VERSION,
    `${name}.zip`
  )
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Only a plain file of a sane size: reading a link to /dev/zero would never end.
function readKept(path: string): Buffer | undefined {
  try {
    const stats = lstatSync(path)
    return stats.isFile() && stats.size < 512 * 1024 * 1024
      ? readFileSync(path)
      : undefined
  } catch {
    // Missing, or under a file.
    return undefined
  }
}

function keep(path: string, bytes: Buffer): void {
  // A name of its own, written only if nothing is there: wx refuses any entry, links included.
  const part = `${path}.${String(process.pid)}.part`
  let written = false
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(part, bytes, { flag: 'wx' })
    written = true
    renameSync(part, path)
  } catch (error) {
    core.debug(`Not keeping the scanner in ${dirname(path)}: ${String(error)}`)
    if (written) rmSync(part, { force: true })
  }
}

// The zip's bytes, checked against the pinned digest: the kept copy if it matches, else a download.
export async function scannerZip(
  name: string,
  sha256: string
): Promise<Buffer> {
  const kept = keptZip(name)
  const bytes = readKept(kept)
  if (bytes && digest(bytes) === sha256) return bytes
  const download = await tc.downloadTool(
    `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${name}.zip`
  )
  const downloaded = readFileSync(download)
  rmSync(download, { force: true })
  const actual = digest(downloaded)
  if (actual !== sha256) {
    throw new Error(
      `The downloaded scanner has SHA-256 ${actual}, expected ${sha256}`
    )
  }
  keep(kept, downloaded)
  return downloaded
}

export async function installScanner(
  platform: string = process.platform,
  arch: string = process.arch
): Promise<string> {
  const build = scannerBuild(platform, arch)
  if (build === PLAIN) {
    core.info(
      `No scanner with a bundled Java runtime for ${platform}-${arch}, using the Java on the runner`
    )
  }
  const name = `sonar-scanner-cli-${VERSION}${build.suffix}`
  const bytes = await scannerZip(name, build.sha256)
  // The bytes just checked, unpacked where only this job writes.
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-scanner-')
  )
  // PowerShell 5.1, which extracts on some Windows runners, refuses a file without the extension.
  const zip = join(directory, `${name}.zip`)
  writeFileSync(zip, bytes)
  const extracted = await tc.extractZip(zip, join(directory, 'scanner'))
  const script = platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner'
  return join(
    extracted,
    `sonar-scanner-${VERSION}${build.suffix}`,
    'bin',
    script
  )
}
