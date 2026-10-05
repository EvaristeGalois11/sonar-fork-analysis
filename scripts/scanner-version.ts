// Fails when Sonar has released a newer scanner CLI than the one the action pins, which nothing else
// would notice; with --update, pins the latest release and the SHA-256 of each of its builds instead.
//
// Usage: node scripts/scanner-version.ts [--update]
//
// The digests come from the files Sonar publishes next to each download. They guard against a
// corrupted download, not a compromised server, so an update goes through review and the real-scanner
// checks before the action trusts it.

import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'src/scanner.ts'
const DOWNLOADS =
  'https://binaries.sonarsource.com/Distribution/sonar-scanner-cli'

async function text(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

const metadata = await text(
  'https://repo1.maven.org/maven2/org/sonarsource/scanner/cli/sonar-scanner-cli/maven-metadata.xml'
)
// The cache version below needs all four parts.
const latest = /<release>(\d+\.\d+\.\d+\.\d+)<\/release>/.exec(metadata)?.[1]
if (!latest) throw new Error('No scanner CLI release found on Maven Central')

let source = readFileSync(SOURCE, 'utf8')
const pinned = /^const VERSION = '([0-9.]+)'$/m.exec(source)?.[1]
if (!pinned) throw new Error(`No VERSION found in ${SOURCE}`)

if (!process.argv.includes('--update')) {
  if (latest !== pinned) {
    console.error(
      `sonar-scanner-cli ${latest} is out, the action pins ${pinned}: run npm run scanner:update`
    )
    process.exit(1)
  }
  console.log(`sonar-scanner-cli ${pinned} is the latest release`)
  process.exit(0)
}

source = source.replace(
  /^const VERSION = '.*'$/m,
  `const VERSION = '${latest}'`
)
// Each build's digest follows its suffix in the source.
const suffixes = Array.from(
  source.matchAll(/suffix: '([^']*)'/g),
  ([, suffix = '']) => suffix
)
const published = await Promise.all(
  suffixes.map(async (suffix) => ({
    suffix,
    digest: await text(
      `${DOWNLOADS}/sonar-scanner-cli-${latest}${suffix}.zip.sha256`
    )
  }))
)
for (const { suffix, digest } of published) {
  const [sha256 = ''] = digest.trim().split(/\s+/)
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error(`No SHA-256 published for the ${suffix || 'plain'} build`)
  source = source.replace(
    new RegExp(String.raw`(suffix: '${suffix}',\s*sha256: )'[0-9a-f]{64}'`),
    `$1'${sha256}'`
  )
}
writeFileSync(SOURCE, source)
console.log(
  `Pinned sonar-scanner-cli ${latest}; run npm run bundle and npm run test:scanner`
)
