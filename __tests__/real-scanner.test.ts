// Checks what the analysis assumes about the scanner against the real one: the CLI the action pins,
// and the engines SonarCloud and the latest SonarQube serve, which change without notice. They are
// downloaded, so the checks only run when SCANNER_CHECKS is set, as the Scanner workflow does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import fc from 'fast-check'
import { posixIt } from '../__fixtures__/platform.js'
import { formatProperties } from '../src/analyze.js'
import { NO_FILE, TESTED_LANGUAGES } from '../src/languages.js'
import { REREAD_PATH, moduleTree } from '../src/settings.js'
import {
  engineEntry,
  moduleSettings,
  plausibleModuleSettings,
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
  // eslint-disable-next-line no-control-regex -- control characters are what it trims
  text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')

const describeScanner = process.env.SCANNER_CHECKS ? describe : describe.skip

// Sampled: about 640 trees with 2500 modules get through per 1000; well below that, the check says
// little.
const MIN_ACCEPTED = 400
const MIN_MODULES = 1500

// Downloads are kept between local runs in the user's own cache, never a shared directory; on CI they
// go to the job's temporary directory. The installer's own leftovers go to a directory of this run.
const work =
  process.env.RUNNER_TEMP ??
  join(homedir(), '.cache', 'sonar-fork-analysis', 'scanner-checks')
process.env.RUNNER_TOOL_CACHE ??= join(work, 'tools')
// The Scanner workflow caches the engines in a directory of their own.
const engines = process.env.SCANNER_ENGINES ?? work
const runnerTemp = process.env.RUNNER_TEMP
if (!runnerTemp)
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'scanner-'))

afterAll(() => {
  if (!runnerTemp)
    rmSync(process.env.RUNNER_TEMP as string, { recursive: true, force: true })
})

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

  it('expands no value the analysis lets through', () => {
    const seed = Date.now()
    const piece = fc.constantFrom(
      '$',
      '{',
      '}',
      '$$',
      'env.',
      'NAME',
      'other',
      'x',
      '.',
      '_',
      '1',
      ' ',
      '\\',
      'é',
      '${other}',
      '${env.NAME}'
    )
    // Two that expand for sure, so the check below never depends on chance.
    const samples = [
      '${other}',
      'a${env.NAME}b',
      ...fc.sample(
        fc.array(piece, { maxLength: 8 }).map((pieces) => pieces.join('')),
        { numRuns: 2000, seed }
      )
    ]
    const letThrough = (value: string): boolean => {
      try {
        formatProperties(new Map([['value', value]]))
        return true
      } catch {
        return false
      }
    }
    const read = probe.resolvePlaceholders(samples)
    const changed = samples
      .filter((value, index) => letThrough(value) && read[index] !== value)
      .map((value) => ({ value, read: read[samples.indexOf(value)] }))
    expect({ seed, changed }).toEqual({ seed, changed: [] })
    // The probe resolves: some of what the analysis refuses does get expanded.
    expect(read.some((value, index) => value !== samples[index])).toBe(true)
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
    mkdirSync(engines, { recursive: true })
    engine = await download(engines)
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
    lists.forEach((list, index) => {
      expect({ seed, split: split[index] }).toEqual({ seed, split: list })
    })
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

  it('gives every setting to the module the analysis checked it for', () => {
    const seed = Date.now()
    const accepted = fc
      .sample(
        fc.oneof(
          { weight: 3, arbitrary: plausibleModuleSettings },
          { weight: 1, arbitrary: moduleSettings }
        ),
        { numRuns: 1000, seed }
      )
      .map((generated) => {
        const settings = new Map([
          ...generated,
          ...trustedKeys.map((key): [string, string] => [key, 'trusted'])
        ])
        try {
          return { settings, tree: moduleTree(settings) }
        } catch {
          return undefined
        }
      })
      .filter((tree) => tree !== undefined)
    const walks = probe.walkModules(accepted.map(({ settings }) => settings))
    const sorted = (modules: Map<string, string[]>): [string, string[]][] =>
      [...modules]
        .map(([path, keys]): [string, string[]] => [path, [...keys].sort()])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    let modules = 0
    accepted.forEach(({ settings, tree }, index) => {
      // The engine names a module by its ids joined with dots: the analysis's prefix without the dot.
      const ours = new Map(
        tree.prefixes.map((prefix): [string, string[]] => [
          prefix.slice(0, -1),
          []
        ])
      )
      for (const key of settings.keys()) {
        const { prefix, bareKey } = tree.split(key)
        ours.get(prefix.slice(0, -1))?.push(bareKey)
      }
      const walk = walks[index]
      expect({
        seed,
        settings,
        refused: walk.refused,
        modules: sorted(walk.modules)
      }).toEqual({ seed, settings, refused: undefined, modules: sorted(ours) })
      modules += ours.size - 1
    })
    // Most generated trees are refused or flat; enough must get through for this to say anything.
    expect({
      seed,
      accepted: accepted.length,
      modules,
      enough: accepted.length > MIN_ACCEPTED && modules > MIN_MODULES
    }).toMatchObject({ enough: true })
  })

  // The methods a method calls, in order: a class's own by name, others as Class.name.
  const calls = (className: string, method: string): string[] =>
    probe
      .bytecode(engine, className, method)
      .map(
        (line) =>
          /\/\/ (?:Interface)?Method (?:[\w/$]*\/)?([\w$]+\.)?(\w+):/.exec(
            line
          ) ?? []
      )
      .filter((match) => match.length > 0)
      .map(([, owner = '', name]) => `${owner}${name}`)

  // On the fork path the analysis turns untested languages off. That keeps their analyzers out of the
  // job only while the engine loads a language's analyzers once it has detected the language.
  it('loads analyzers only for the languages it detects, unless told otherwise', () => {
    const start = probe.bytecode(
      engine,
      'org.sonar.scanner.bootstrap.ScannerPluginRepository',
      'start'
    )
    // The switch and its default: SonarQube reads the first, SonarCloud the second.
    const read = start.findIndex((line) => /String sonar\.plugins\./.test(line))
    const key = /String (sonar\.plugins\.\w+)/.exec(start[read] ?? '')?.[1]
    const fallback = start
      .slice(read)
      .map((line) => /\b(iconst_[01])\b/.exec(line)?.[1])
      .find(Boolean)
    expect({ engine, key, fallback }).toMatchObject({
      key: expect.toBeOneOf([
        'sonar.plugins.downloadOnlyRequired',
        'sonar.plugins.loadAll'
      ]),
      fallback:
        key === 'sonar.plugins.downloadOnlyRequired' ? 'iconst_1' : 'iconst_0'
    })
    expect(start.join('\n')).toContain('PluginInstaller.installRequiredPlugins')
    // Later, the project's scan hands the detected languages to the repository.
    const scan = calls(
      'org.sonar.scanner.scan.SpringProjectScanContainer',
      'doBeforeStart'
    )
    expect({ engine, scan }).toMatchObject({
      scan: expect.arrayContaining([
        'LanguageDetection.getDetectedLanguages',
        'installPluginsForLanguages'
      ])
    })
    expect(scan.indexOf('installPluginsForLanguages')).toBe(
      scan.indexOf('LanguageDetection.getDetectedLanguages') + 1
    )
    expect(
      calls(
        'org.sonar.scanner.scan.SpringProjectScanContainer',
        'installPluginsForLanguages'
      )
    ).toContain('ScannerPluginRepository.installPluginsForLanguages')
    expect(
      calls(
        'org.sonar.scanner.bootstrap.ScannerPluginRepository',
        'installPluginsForLanguages'
      )
    ).toContain('PluginInstaller.installPluginsForLanguages')
  })

  // The analysis turns off a language by setting sonar.lang.patterns.<language> to a pattern no file
  // matches. That only works while the engine reads the setting before the language's own patterns,
  // and uses them only when the setting gives none.
  it("reads sonar.lang.patterns.<language> before the language's own patterns", () => {
    const order = calls(
      'org.sonar.scanner.scan.filesystem.LanguageDetection',
      'org.sonar.scanner.scan.filesystem.LanguageDetection'
    )
    const at = (name: string): number => order.indexOf(name)
    expect({ engine, order }).toMatchObject({
      order: expect.arrayContaining([
        'getFileLangPatternPropKey',
        'Configuration.getStringArray',
        'PathPattern.create',
        'getLanguagePatterns'
      ])
    })
    expect(at('getFileLangPatternPropKey')).toBeLessThan(
      at('Configuration.getStringArray')
    )
    expect(at('Configuration.getStringArray')).toBeLessThan(
      at('PathPattern.create')
    )
    expect(at('PathPattern.create')).toBeLessThan(at('getLanguagePatterns'))
  })

  it('matches no file of a checkout with the pattern that turns a language off', () => {
    const workspace = '/home/runner/work/repo/repo'
    // Paths a fork chooses, including ones spelled like the pattern.
    const paths = [
      'src/x.py',
      'test/evil.rs',
      'never',
      'dev/null/never',
      'DEV/NULL/NEVER',
      'a/b/dev/null/never',
      'file:/dev/null/never'
    ]
    const results = probe.matches([
      // Shows the probe matches at all.
      {
        pattern: '**/*.py',
        absolute: `${workspace}/src/x.py`,
        relative: 'src/x.py'
      },
      ...paths.map((path) => ({
        pattern: NO_FILE,
        absolute: `${workspace}/${path}`,
        relative: path
      }))
    ])
    expect({ engine, results }).toEqual({
      engine,
      results: [
        { patterns: 1, matched: true },
        ...paths.map(() => ({ patterns: 1, matched: false }))
      ]
    })
  })

  // A new process start inside a listed class goes unnoticed here; Fixtures Sonar's traps catch
  // those at run time.
  it('has no class that can start a process beyond the reviewed ones', () => {
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

// On the fork path the analysis turns off every language outside TESTED_LANGUAGES. A tested language
// SonarCloud renames or drops would be turned off with them, silently.
describeScanner("SonarCloud's languages", () => {
  it('still include every tested language', async () => {
    const response = await fetch(
      'https://sonarcloud.io/api/languages/list?ps=0'
    )
    const { languages } = (await response.json()) as {
      languages: { key: string }[]
    }
    const keys = languages.map(({ key }) => key)
    expect(TESTED_LANGUAGES.filter((key) => !keys.includes(key))).toEqual([])
  })
})

// Dependabot regenerates the fixtures' wrappers, so Fixtures Sonar can't put traps in them. It traps
// what they need instead: Java on the PATH and in JAVA_HOME, and the wget and curl that mvnw uses to
// download Maven. If a wrapper update gets past these traps, this test fails.
describe('the fixture build wrappers', () => {
  posixIt.each(['fixtures/maven/mvnw', 'fixtures/gradle/gradlew'])(
    '%s springs the traps',
    (wrapper) => {
      const directory = mkdtempSync(join(tmpdir(), 'trap-'))
      try {
        const sprung = join(directory, 'sprung')
        const jdk = join(directory, 'jdk', 'bin')
        mkdirSync(jdk, { recursive: true })
        for (const tool of ['java', 'javac', 'wget', 'curl']) {
          for (const where of [directory, jdk]) {
            writeFileSync(
              join(where, tool),
              `#!/bin/sh\necho "$0 $*" >> "${sprung}"\nexit 1\n`,
              { mode: 0o755 }
            )
          }
        }
        const run = spawnSync('sh', [wrapper, '--version'], {
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            JAVA_HOME: join(directory, 'jdk'),
            // Not a Maven the machine already downloaded.
            MAVEN_USER_HOME: join(directory, 'm2')
          },
          encoding: 'utf8'
        })
        expect(run.status).not.toBe(0)
        expect(readFileSync(sprung, 'utf8')).not.toBe('')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
