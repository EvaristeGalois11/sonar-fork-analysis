// Checks what the analysis assumes about the scanner against the real one: the CLI the action pins,
// and the engine SonarCloud serves today, which changes without notice. Both are downloaded, so the
// checks only run when SCANNER_CHECKS is set, as the Scanner workflow does.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import fc from 'fast-check'
import { formatProperties } from '../src/analyze.js'
import { installScanner } from '../src/scanner.js'
import { REREAD_PATH, modulePrefixes } from '../src/settings.js'
import {
  engineTrim,
  moduleSettings,
  settingText,
  settingsWithoutPlaceholders,
  trustedKeys
} from './arbitraries.js'

const hex = (text: string): string =>
  'x' +
  [...Array(text.length).keys()]
    .map((index) => text.charCodeAt(index).toString(16).padStart(4, '0'))
    .join('')

const unhex = (text: string): string =>
  String.fromCharCode(
    ...(text.slice(1).match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16))
  )

// Like String.trim, which the CLI applies to every value: everything up to a space goes at both ends.
const javaTrim = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')

const describeScanner = process.env.SCANNER_CHECKS ? describe : describe.skip

describeScanner('the real scanner', () => {
  const work = process.env.RUNNER_TEMP ?? join(tmpdir(), 'scanner-checks')
  process.env.RUNNER_TEMP ??= work
  process.env.RUNNER_TOOL_CACHE ??= join(work, 'tools')
  let classpath: string
  let engine: string
  let scratch: string

  beforeAll(async () => {
    mkdirSync(work, { recursive: true })
    const lib = join(dirname(dirname(await installScanner())), 'lib')
    const cli = readdirSync(lib).find((name) =>
      name.startsWith('sonar-scanner-cli-')
    ) as string
    engine = await downloadEngine(work)
    classpath = [join(lib, cli), engine].join(delimiter)
  }, 600_000)

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'scanner-'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const probe = (mode: string, input: string): string[] =>
    execFileSync(
      'java',
      [
        '-cp',
        classpath,
        resolve('__tests__/java/ScannerProbe.java'),
        mode,
        input
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 }
    )
      .split('\n')
      .filter((line) =>
        /^(file|entry|split|case|refused|module|root|class)( |$)/.test(line)
      )

  it('CLI reads the settings file back as written, values trimmed', () => {
    const seed = Date.now()
    const samples = fc.sample(settingsWithoutPlaceholders, {
      numRuns: 1000,
      seed
    })
    samples.forEach((entries, index) =>
      writeFileSync(
        join(scratch, `${String(index).padStart(4, '0')}.properties`),
        formatProperties(new Map(entries))
      )
    )
    const read: Map<string, string>[] = []
    for (const line of probe('cli', scratch)) {
      if (line.startsWith('file ')) read.push(new Map())
      else {
        const [, key, value] = line.split(' ')
        read[read.length - 1].set(unhex(key), unhex(value))
      }
    }
    samples.forEach((entries, index) => {
      const expected = new Map(
        entries.map(([key, value]) => [key, javaTrim(value)])
      )
      expect({ seed, entries, read: read[index] }).toEqual({
        seed,
        entries,
        read: expected
      })
    })
  })

  it('engine splits a path list into exactly the entries the analysis checked', () => {
    const seed = Date.now()
    const lists = fc.sample(
      fc.array(
        settingText
          .map((text) => `/${text}`)
          .filter((path) => !path.includes(',') && !REREAD_PATH.test(path)),
        { minLength: 1, maxLength: 4 }
      ),
      { numRuns: 1000, seed }
    )
    const input = join(scratch, 'lists')
    writeFileSync(input, lists.map((list) => hex(list.join(','))).join('\n'))
    const split = probe('csv', input).map((line) =>
      line.slice('split '.length).split(' ').filter(Boolean).map(unhex)
    )
    lists.forEach((list, index) =>
      expect({ seed, split: split[index] }).toEqual({ seed, split: list })
    )
  })

  it('engine trims list entries as the model of it says', () => {
    const seed = Date.now()
    // Quotes, commas and line breaks make more entries; the model is about trimming one.
    const entries = fc.sample(
      settingText.filter((text) => !/[",\r\n]/.test(text)),
      { numRuns: 1000, seed }
    )
    const input = join(scratch, 'entries')
    writeFileSync(input, entries.map(hex).join('\n'))
    const split = probe('csv', input).map((line) =>
      line.slice('split '.length).split(' ').filter(Boolean).map(unhex)
    )
    entries.forEach((entry, index) => {
      // An entry of nothing but characters up to a space is dropped; one of other spaces stays empty.
      // eslint-disable-next-line no-control-regex
      const dropped = /^[\x00-\x20]*$/.test(entry)
      expect({ seed, entry, split: split[index] }).toEqual({
        seed,
        entry,
        split: dropped ? [] : [engineTrim(entry)]
      })
    })
  })

  it('engine finds the modules the analysis checked and leaves the trusted settings on the project', () => {
    const seed = Date.now()
    const accepted = fc
      .sample(moduleSettings, { numRuns: 1000, seed })
      .map((settings) => {
        try {
          return { settings, prefixes: modulePrefixes(settings) }
        } catch {
          return undefined
        }
      })
      .filter((tree) => tree !== undefined)
    const input = join(scratch, 'modules')
    writeFileSync(
      input,
      accepted
        .map(({ settings }) =>
          [
            'case',
            ...[...settings, ...trustedKeys.map((key) => [key, 'trusted'])].map(
              ([key, value]) => `${hex(key)} ${hex(value)}`
            )
          ].join('\n')
        )
        .join('\n')
    )
    const results: { refused?: string; modules: string[]; root: string[] }[] =
      []
    for (const line of probe('modules', input)) {
      const [kind, value] = line.split(' ')
      if (kind === 'case') results.push({ modules: [], root: [] })
      const result = results[results.length - 1]
      if (kind === 'refused') result.refused = unhex(value)
      if (kind === 'module') result.modules.push(unhex(value))
      if (kind === 'root') result.root.push(unhex(value))
    }
    accepted.forEach(({ settings, prefixes }, index) => {
      const result = results[index]
      // The engine refusing a tree, e.g. a repeated id, only fails the analysis.
      if (result.refused !== undefined) return
      const modules = result.modules
        .filter((path) => path !== '')
        .map((path) => `${path}.`)
        .sort()
      expect({ seed, settings, modules }).toEqual({
        seed,
        settings,
        modules: prefixes.filter((prefix) => prefix !== '').sort()
      })
      expect({ seed, settings, root: result.root }).toEqual({
        seed,
        settings,
        root: expect.arrayContaining(trustedKeys)
      })
    })
  })

  it('engine starts processes only where it is known to', () => {
    const known = readFileSync('__tests__/java/engine-processes.txt', 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
    const unknown = probe('processes', engine)
      .map((line) => line.slice('class '.length))
      .filter((name) => !known.includes(name))
    // New ones need a look: does any of them run something from the checkout, and if so, can a
    // trusted setting turn it off? Then add them to engine-processes.txt.
    expect({ engine, unknown }).toEqual({ engine, unknown: [] })
  })
})

// The engine SonarCloud currently hands the scanner, checked against the digest it publishes.
async function downloadEngine(work: string): Promise<string> {
  const response = await fetch('https://api.sonarcloud.io/analysis/engine', {
    headers: { Accept: 'application/json' }
  })
  const { filename, sha256, downloadUrl } = (await response.json()) as {
    filename: string
    sha256: string
    downloadUrl: string
  }
  const path = join(work, filename)
  if (!existsSync(path))
    writeFileSync(
      path,
      Buffer.from(await (await fetch(downloadUrl)).arrayBuffer())
    )
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== sha256)
    throw new Error(`${filename} has SHA-256 ${actual}, expected ${sha256}`)
  console.info(`Checking against ${filename}`)
  return path
}

// The fixtures' build wrappers are traps on the fork path: Fixtures Sonar sets the variable while
// analysing, where nothing may run the analysed code. A wrapper update that drops them fails here.
describe('the fixture build wrappers', () => {
  it.each(['fixtures/maven/mvnw', 'fixtures/gradle/gradlew'])(
    '%s springs the trap',
    (wrapper) => {
      const sprung = join(mkdtempSync(join(tmpdir(), 'trap-')), 'sprung')
      const run = spawnSync('sh', [wrapper, '--version'], {
        env: { ...process.env, SONAR_FORK_ANALYSIS_TRAP: sprung },
        encoding: 'utf8'
      })
      expect(run.status).toBe(1)
      expect(readFileSync(sprung, 'utf8')).toContain(wrapper)
    }
  )
})
