import { filterSettings, modulePrefixes, splitKey } from '../src/settings.js'

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

describe('filterSettings', () => {
  const { kept, dropped } = filterSettings(settings)

  it('keeps analysis settings at every module level', () => {
    expect([...kept.keys()]).toEqual([
      'sonar.modules',
      'org.acme:parent-tests.sonar.modules',
      'org.acme:parent-tests.org.acme:bean-tests.sonar.exclusions',
      'org.acme:parent-tests.sonar.java.binaries',
      'sonar.projectName'
    ])
  })

  it('drops what the analysis must decide itself, in modules too', () => {
    expect(dropped).toEqual([
      'sonar.host.url',
      'sonar.token',
      'org.acme:parent-tests.sonar.scanner.javaOpts',
      'sonar.working.directory'
    ])
  })

  it('drops environment and JVM properties silently', () => {
    expect(kept.has('env.GITHUB_TOKEN')).toBe(false)
    expect(dropped).not.toContain('env.GITHUB_TOKEN')
    expect(dropped).not.toContain('java.home')
  })
})
