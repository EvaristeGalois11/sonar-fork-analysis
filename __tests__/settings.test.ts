import {
  byCodeUnit,
  filterSettings,
  isAllowed,
  isShippedPath,
  moduleTree
} from '../src/settings.js'
import fc from 'fast-check'
import { engineEntry, moduleSettings, trustedKeys } from './arbitraries.js'

const modulePrefixes = (settings: Map<string, string>): string[] =>
  moduleTree(settings).prefixes

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

describe('byCodeUnit', () => {
  it('sorts as .sort() does without a compare function', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'binary' })), (strings) => {
        expect(strings.toSorted(byCodeUnit)).toEqual(strings.toSorted())
      })
    )
  })
})

describe('moduleTree', () => {
  it('follows nested modules whose ids contain dots', () => {
    expect(modulePrefixes(settings)).toEqual([
      '',
      'org.acme:parent-tests.',
      'org.acme:parent-tests.org.acme:bean-tests.'
    ])
  })

  it.each([
    ['the same id twice', new Map([['sonar.modules', 'a,a']])],
    [
      'a nested module whose path is a sibling id',
      new Map([
        ['sonar.modules', 'a,a.b'],
        ['a.sonar.modules', 'b']
      ])
    ]
  ])('refuses %s, as the engine does', (_, tree) => {
    expect(() => modulePrefixes(tree)).toThrow(/Invalid module id/)
  })

  it('gives each key to the module the engine gives it to', () => {
    // a.b takes every a.b.* key before a, so a's module b.c gets none: no base, so it is refused later.
    const tree = moduleTree(
      new Map([
        ['sonar.modules', 'a,a.b'],
        ['a.sonar.modules', 'b.c'],
        ['a.b.c.sonar.projectBaseDir', '/work/checked']
      ])
    )
    expect(tree.prefixes).toEqual(['', 'a.b.', 'a.', 'a.b.c.'])
    expect(tree.split('a.b.c.sonar.projectBaseDir')).toEqual({
      prefix: 'a.b.',
      bareKey: 'c.sonar.projectBaseDir'
    })
    expect(tree.keyOf('a.b.c.', 'sonar.projectBaseDir')).toBeUndefined()
  })

  it('keeps ids that are prefixes of their siblings apart, like Tycho builds', () => {
    const tree = moduleTree(
      new Map([
        ['sonar.modules', 'X:core,X:core.tests'],
        ['X:core.sonar.sources', 'src'],
        ['X:core.tests.sonar.sources', 'test']
      ])
    )
    expect(tree.split('X:core.sonar.sources').prefix).toBe('X:core.')
    expect(tree.split('X:core.tests.sonar.sources').prefix).toBe(
      'X:core.tests.'
    )
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

describe('moduleTree and the scanner', () => {
  it.each([
    'app,"sonar.sca"',
    '"sonar.working"',
    '\u0001sonar.sca',
    'app,\u3000sonar.sca',
    'app,\u00a0x'
  ])(
    'refuses the module list %j, which the scanner reads otherwise',
    (list) => {
      expect(() => modulePrefixes(new Map([['sonar.modules', list]]))).toThrow(
        /Invalid module id/
      )
    }
  )
})

describe('moduleTree on any artifact', () => {
  it('lets no module take a setting the analysis sets on the project', () => {
    fc.assert(
      fc.property(moduleSettings, (settings) => {
        let tree
        try {
          tree = moduleTree(settings)
        } catch (error) {
          // Refusing the artifact is the other safe outcome.
          if ((error as Error).message.startsWith('Invalid module id')) return
          throw error
        }
        for (const prefix of tree.prefixes) {
          // Stricter than the engine, where only the project's own modules take its keys.
          for (const key of trustedKeys)
            expect(prefix !== '' && key.startsWith(prefix)).toBe(false)
          // The engine splits lists as CSV and trims ids its own way (see arbitraries.ts): with no
          // quotes, it must read the same ids.
          const list = settings.get(tree.keyOf(prefix, 'sonar.modules') ?? '')
          expect(list ?? '').not.toContain('"')
          for (const module of (list ?? '').split(','))
            expect(module.trim()).toBe(engineEntry(module) ?? '')
        }
      }),
      { numRuns: 1000 }
    )
  })
})

describe('moduleTree.split', () => {
  it('strips the prefix of the module the key belongs to', () => {
    expect(
      moduleTree(settings).split(
        'org.acme:parent-tests.org.acme:bean-tests.sonar.exclusions'
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
