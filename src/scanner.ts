import * as tc from '@actions/tool-cache'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '8.1.0.6389'
const SHA256 =
  'ab76ab3c360025e9108be5b55be066f304a164f8b2850d2f2f333915db51bc1b'
// The tool cache wants semver, which has no fourth component.
const CACHE_VERSION = '8.1.0'

export async function installScanner(): Promise<string> {
  let directory = tc.find('sonar-scanner-cli', CACHE_VERSION)
  if (!directory) {
    const zip = await tc.downloadTool(
      `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${VERSION}.zip`
    )
    const actual = createHash('sha256').update(readFileSync(zip)).digest('hex')
    if (actual !== SHA256) {
      throw new Error(
        `The downloaded scanner has SHA-256 ${actual}, expected ${SHA256}`
      )
    }
    const extracted = await tc.extractZip(zip)
    directory = await tc.cacheDir(
      join(extracted, `sonar-scanner-${VERSION}`),
      'sonar-scanner-cli',
      CACHE_VERSION
    )
  }
  return join(directory, 'bin', 'sonar-scanner')
}
