import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '8.1.0.6389'
// The tool cache wants semver, which has no fourth component.
const CACHE_VERSION = '8.1.0'

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
  const tool = `sonar-scanner-cli${build.suffix}`
  let directory = tc.find(tool, CACHE_VERSION)
  if (!directory) {
    const name = `sonar-scanner-cli-${VERSION}${build.suffix}`
    const zip = await tc.downloadTool(
      `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${name}.zip`
    )
    const actual = createHash('sha256').update(readFileSync(zip)).digest('hex')
    if (actual !== build.sha256) {
      throw new Error(
        `The downloaded scanner has SHA-256 ${actual}, expected ${build.sha256}`
      )
    }
    const extracted = await tc.extractZip(zip)
    directory = await tc.cacheDir(
      join(extracted, `sonar-scanner-${VERSION}${build.suffix}`),
      tool,
      CACHE_VERSION
    )
  }
  const script = platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner'
  return join(directory, 'bin', script)
}
