// Checks what the analysis assumes about the scanner against the real one: the CLI the action pins,
// and the engines SonarCloud and the latest SonarQube serve, which change without notice. They are
// downloaded, so the checks only run when SCANNER_CHECKS is set, as the Scanner workflow does.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { formatProperties } from '../src/analyze.js'
import { REREAD_PATH, modulePrefixes } from '../src/settings.js'
import {
  engineEntry,
  moduleSettings,
  settingText,
  settingsWithoutPlaceholders,
  trustedKeys
} from './arbitraries.js'
import {
  Probe,
  cliJar,
  sonarCloudEngine,
  sonarQubeEngine
} from './scanner-probe.js'

// Like String.trim, which the CLI applies to every value: everything up to a space goes at both ends.
const javaTrim = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')

const describeScanner = process.env.SCANNER_CHECKS ? describe : describe.skip

const work = process.env.RUNNER_TEMP ?? join(tmpdir(), 'scanner-checks')
process.env.RUNNER_TEMP ??= work
process.env.RUNNER_TOOL_CACHE ??= join(work, 'tools')

describeScanner('the scanner CLI', () => {
  let probe: Probe

  beforeAll(async () => {
    mkdirSync(work, { recursive: true })
    probe = new Probe([await cliJar()])
  }, 600_000)

  it('reads the settings file back as written, values trimmed', () => {
    const seed = Date.now()
    const samples = fc.sample(settingsWithoutPlaceholders, {
      numRuns: 1000,
      seed
    })
    const read = probe.readSettingsFiles(
      samples.map((entries) => formatProperties(new Map(entries)))
    )
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
})

describeScanner.each([
  {
    name: 'SonarCloud',
    download: sonarCloudEngine,
    known: '__tests__/java/engine-processes-sonarcloud.txt'
  },
  {
    name: 'SonarQube',
    download: sonarQubeEngine,
    known: '__tests__/java/engine-processes-sonarqube.txt'
  }
])("$name's engine", ({ download, known }) => {
  let engine: string
  let probe: Probe

  beforeAll(async () => {
    mkdirSync(work, { recursive: true })
    engine = await download(work)
    console.info(`Checking against ${engine}`)
    probe = new Probe([engine])
  }, 600_000)

  it('splits a path list into exactly the entries the analysis checked', () => {
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
    const split = probe.splitLists(lists.map((list) => list.join(',')))
    lists.forEach((list, index) =>
      expect({ seed, split: split[index] }).toEqual({ seed, split: list })
    )
  })

  it('trims list entries as the model of it says', () => {
    const seed = Date.now()
    // Quotes, commas and line breaks make more entries; the model is about trimming one.
    const entries = fc.sample(
      settingText.filter((text) => !/[",\r\n]/.test(text)),
      { numRuns: 1000, seed }
    )
    const split = probe.splitLists(entries)
    entries.forEach((entry, index) => {
      const read = engineEntry(entry)
      expect({ seed, entry, split: split[index] }).toEqual({
        seed,
        entry,
        split: read === undefined ? [] : [read]
      })
    })
  })

  it('finds the modules the analysis checked and leaves the trusted settings on the project', () => {
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
    const walks = probe.walkModules(
      accepted.map(
        ({ settings }) =>
          new Map([
            ...settings,
            ...trustedKeys.map((key): [string, string] => [key, 'trusted'])
          ])
      )
    )
    accepted.forEach(({ settings, prefixes }, index) => {
      const walk = walks[index]
      // The engine refusing a tree, e.g. a repeated id, only fails the analysis.
      if (walk.refused !== undefined) return
      const modules = walk.modules
        .filter((path) => path !== '')
        .map((path) => `${path}.`)
        .sort()
      expect({ seed, settings, modules }).toEqual({
        seed,
        settings,
        modules: prefixes.filter((prefix) => prefix !== '').sort()
      })
      expect({ seed, settings, root: walk.root }).toEqual({
        seed,
        settings,
        root: expect.arrayContaining(trustedKeys)
      })
    })
  })

  it('starts processes only where it is known to', () => {
    const listed = readFileSync(known, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
    const unknown = probe
      .processClasses(engine)
      .filter((name) => !listed.includes(name))
    // New ones need a look: does any of them run something from the checkout, and if so, can a
    // trusted setting turn it off? Then add them to the list.
    expect({ engine, unknown }).toEqual({ engine, unknown: [] })
  })
})

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
