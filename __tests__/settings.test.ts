import {
  filterSettings,
  isAllowed,
  isShippedPath,
  modulePrefixes,
  splitKey
} from '../src/settings.js'
import fc from 'fast-check'

const settings = new Map([
  ['sonar.modules', 'org.acme:parent-tests'],
  ['org.acme:parent-tests.sonar.modules', 'org.acme:bean-tests'],
  ['org.acme:parent-tests.org.acme:bean-tests.sonar.exclusions', '**/pojo/**'],
  ['org.acme:parent-tests.sonar.java.binaries', '/work/tests/target/classes'],
  ['sonar.projectName', 'acme'],
  ['sonar.host.url', 'https://evil.example.com'],
  ['sonar.token', 'secret'],
  ['org.acme:parent-tests.sonar.scanner.javaOpts', '-javaagent:/x.jar'],
  ['sonar.working.directory', '/'],
  ['sonar.nodejs.executable', '/tmp/evil'],
  ['sonar.region', 'us'],
  ['sonar.gradle.scanAll', 'true'],
  ['org.acme:parent-tests.sonar.sca.enabled', 'true'],
  ['env.GITHUB_TOKEN', 'ghs_secret'],
  ['java.home', '/usr/lib/jvm']
])

describe('modulePrefixes', () => {
  it('follows nested modules whose ids contain dots', () => {
    expect(modulePrefixes(settings)).toEqual([
      '',
      'org.acme:parent-tests.',
      'org.acme:parent-tests.org.acme:bean-tests.'
    ])
  })

  it('visits each module once', () => {
    const repeated = new Map([
      ['sonar.modules', 'a,a,a.a'],
      ['a.sonar.modules', 'a,a'],
      ['a.a.sonar.modules', 'a,a']
    ])
    expect(modulePrefixes(repeated)).toEqual(['', 'a.', 'a.a.', 'a.a.a.'])
  })

  it.each(['..', '.', 'up/..', 'C:\\x'])(
    'refuses the module id %s, which would leave its parent',
    (id) => {
      expect(() => modulePrefixes(new Map([['sonar.modules', id]]))).toThrow(
        /Invalid module id/
      )
    }
  )

  it.each(['sonar', 'sonar.sca', 'sonar.working'])(
    'refuses the module id %s, which would take settings from its parent',
    (id) => {
      expect(() => modulePrefixes(new Map([['sonar.modules', id]]))).toThrow(
        /Invalid module id/
      )
    }
  )
})

describe('modulePrefixes on any artifact', () => {
  const id = fc.oneof(
    fc.constantFrom(
      'sonar',
      'sonar.sca',
      'sonar.working',
      ' sonar ',
      '.',
      '..',
      'a/b',
      'org.acme:app',
      'a',
      'a.b',
      ''
    ),
    fc.string({ maxLength: 8 }).filter((id) => !id.includes(','))
  )
  const settings = fc
    .array(
      fc.tuple(fc.array(id, { maxLength: 3 }), fc.array(id, { maxLength: 4 })),
      { maxLength: 6 }
    )
    .map(
      (levels) =>
        new Map(
          levels.map(([path, modules]) => [
            `${path.map((module) => `${module}.`).join('')}sonar.modules`,
            modules.join(',')
          ])
        )
    )

  it('lets no module take a setting the analysis sets on the project', () => {
    const trusted = [
      'sonar.sca.enabled',
      'sonar.working.directory',
      'sonar.projectKey',
      'sonar.scm.revision'
    ]
    fc.assert(
      fc.property(settings, (settings) => {
        let prefixes: string[]
        try {
          prefixes = modulePrefixes(settings)
        } catch (error) {
          // Refusing the artifact is the other safe outcome.
          if ((error as Error).message.startsWith('Invalid module id')) return
          throw error
        }
        expect(new Set(prefixes).size).toBe(prefixes.length)
        for (const key of trusted)
          expect(splitKey(key, prefixes)).toEqual({ prefix: '', bareKey: key })
      }),
      { numRuns: 1000 }
    )
  })
})

describe('splitKey', () => {
  it('strips the longest matching module prefix', () => {
    expect(
      splitKey(
        'org.acme:parent-tests.org.acme:bean-tests.sonar.exclusions',
        modulePrefixes(settings)
      )
    ).toEqual({
      prefix: 'org.acme:parent-tests.org.acme:bean-tests.',
      bareKey: 'sonar.exclusions'
    })
  })
})

describe('isAllowed', () => {
  it.each([
    'sonar.coverageReportPaths',
    'sonar.python.ruff.reportPaths',
    'sonar.cs.opencover.reportsPaths',
    'sonar.php.tests.reportPath',
    'sonar.docker.file.patterns',
    'sonar.python.file.suffixes',
    'sonar.terraform.activate',
    'sonar.go.exclusions',
    'sonar.lang.patterns.docker',
    'sonar.typescript.tsconfigPaths',
    'sonar.python.version',
    'sonar.android.minsdkversion.min'
  ])('allows %s', (key) => {
    expect(isAllowed(key)).toBe(true)
  })

  it.each([
    'sonar.sca.exclusions',
    'sonar.scanner.excludeHiddenFiles',
    'sonar.scm.exclusions.disabled',
    'sonar.featureflag.anything.activate',
    'sonar.plsql.jdbc.driver.path',
    'sonar.nodejs.executable',
    'sonar.cfamily.compile-commands',
    'sonar.rust.cargo.manifestPaths',
    'sonar.javascript.node.maxspace',
    'env.COVERAGE_REPORTPATHS'
  ])('refuses %s', (key) => {
    expect(isAllowed(key)).toBe(false)
  })

  it('ships reports by their name', () => {
    expect(isShippedPath('sonar.kotlin.detekt.reportPaths')).toBe(true)
    expect(isShippedPath('sonar.java.binaries')).toBe(true)
    expect(isShippedPath('sonar.sources')).toBe(false)
  })
})

describe('filterSettings', () => {
  const { kept, dropped, replaced, ignored } = filterSettings(settings)

  it('keeps analysis settings at every module level', () => {
    expect([...kept.keys()]).toEqual([
      'sonar.modules',
      'org.acme:parent-tests.sonar.modules',
      'org.acme:parent-tests.org.acme:bean-tests.sonar.exclusions',
      'org.acme:parent-tests.sonar.java.binaries',
      'sonar.projectName'
    ])
  })

  it('tells the settings the fork path leaves out, in modules too', () => {
    expect(dropped).toEqual([
      'sonar.nodejs.executable',
      'sonar.region',
      'org.acme:parent-tests.sonar.sca.enabled'
    ])
  })

  it('sets apart those the analysis sets itself', () => {
    expect(replaced).toEqual([
      'sonar.host.url',
      'sonar.token',
      'org.acme:parent-tests.sonar.scanner.javaOpts',
      'sonar.working.directory',
      'sonar.gradle.scanAll'
    ])
  })

  it('sets apart environment and JVM properties', () => {
    expect(ignored).toEqual(['env.GITHUB_TOKEN', 'java.home'])
  })
})
